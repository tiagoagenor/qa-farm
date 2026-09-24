import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { apkProblems, parseBadging } from "@/core/parsers/aapt2"
import { appiumGroup, parseAdbDevices, portsFor, serialFromIndex } from "@/core/parsers/adb-devices"
import { classifyRun, parseRobotOutput, splitTeardown } from "@/core/parsers/robot-output"

const fx = (p: string) => fs.readFileSync(path.join(__dirname, "../fixtures", p), "utf8")

const noRun = { exitCode: 0, canceled: false, timedOut: false, deviceLost: false, consoleText: "" }

describe("parseRobotOutput", () => {
  it("lê um caso que passou com a duração", () => {
    // Arrange
    const xml = fx("output/pass.xml")

    // Act
    const [t] = parseRobotOutput(xml)

    // Assert
    expect(t).toMatchObject({ name: "CT_EXEMPLO_09-Abrir-tela-SMOKE", status: "PASS", message: "", elapsedMs: 16001 })
  })

  it("separa a mensagem principal do erro de teardown", () => {
    // Arrange
    const xml = fx("output/fail-teardown.xml")

    // Act
    const [t] = parseRobotOutput(xml)

    // Assert
    expect([t.status, t.message, t.teardownMessage]).toEqual([
      "FAIL",
      `Element locator '//*[@resource-id="auth.submit.button"]' did not match any elements after 20 seconds`,
      "There is no Active Screen Record Session.",
    ])
  })

  it("decodifica entidades XML da mensagem", () => {
    // Arrange
    const xml = fx("output/escaped.xml")

    // Act
    const [t] = parseRobotOutput(xml)

    // Assert
    expect(t.message).toBe(`Text 'accessibility_id=Não foi possível & "x" <y>' did not appear`)
  })

  it("mantém nomes com acentos e símbolos", () => {
    // Arrange
    const xml = fx("output/fail-teardown.xml")

    // Act
    const [t] = parseRobotOutput(xml)

    // Assert
    expect(t.name).toBe("CT_EXEMPLO_01-Fluxo-com-falha (ç+$)")
  })
})

describe("splitTeardown", () => {
  it("sem sufixo de teardown devolve a mensagem inteira", () => {
    // Arrange
    const msg = "falhou"

    // Act
    const out = splitTeardown(msg)

    // Assert
    expect(out).toEqual({ message: "falhou" })
  })
})

describe("classifyRun", () => {
  it("caso que passou → passed", () => {
    // Arrange
    const input = { ...noRun, outputXml: fx("output/pass.xml") }

    // Act
    const r = classifyRun(input)

    // Assert
    expect([r.status, r.hasOutputXml]).toEqual(["passed", true])
  })

  it("falha comum → failed com a mensagem limpa", () => {
    // Arrange
    const input = { ...noRun, exitCode: 1, outputXml: fx("output/fail-teardown.xml") }

    // Act
    const r = classifyRun(input)

    // Assert
    expect([r.status, r.teardownMessage]).toEqual(["failed", "There is no Active Screen Record Session."])
  })

  it("falha ao abrir sessão no setup → infra_error", () => {
    // Arrange
    const input = { ...noRun, exitCode: 1, outputXml: fx("output/setup-infra.xml") }

    // Act
    const r = classifyRun(input)

    // Assert
    expect(r.status).toBe("infra_error")
  })

  it("código 252 → config_error com a mensagem do robot", () => {
    // Arrange
    const input = { ...noRun, exitCode: 252, consoleText: fx("console/nomatch.txt") }

    // Act
    const r = classifyRun(input)

    // Assert
    expect([r.status, r.message]).toEqual([
      "config_error",
      "Suite 'Exemplo' contains no tests matching name 'Exemplo.CT_NAO_EXISTE'.",
    ])
  })

  it("timeout tem prioridade sobre o resto", () => {
    // Arrange
    const input = { ...noRun, exitCode: null, timedOut: true, consoleText: fx("console/killed.txt") }

    // Act
    const r = classifyRun(input)

    // Assert
    expect(r.status).toBe("timeout")
  })

  it("celular perdido durante o caso → infra_error", () => {
    // Arrange
    const input = { ...noRun, exitCode: 1, deviceLost: true, outputXml: fx("output/fail-teardown.xml") }

    // Act
    const r = classifyRun(input)

    // Assert
    expect(r.status).toBe("infra_error")
  })

  it("cancelado → canceled", () => {
    // Arrange
    const input = { ...noRun, exitCode: null, canceled: true }

    // Act
    const r = classifyRun(input)

    // Assert
    expect(r.status).toBe("canceled")
  })

  it("sem output.xml e sem sinal de infra → failed explicando", () => {
    // Arrange
    const input = { ...noRun, exitCode: 3, consoleText: "Traceback: boom" }

    // Act
    const r = classifyRun(input)

    // Assert
    expect([r.status, r.message?.startsWith("Robot terminou sem output.xml (código 3)")]).toEqual(["failed", true])
  })
})

describe("parseBadging", () => {
  it("lê package, versão, minSdk, ABIs e activity", () => {
    // Arrange
    const text = fx("aapt2/badging.txt")

    // Act
    const info = parseBadging(text)

    // Assert
    expect(info).toEqual({
      package: "com.exemplo.App.hml",
      versionCode: 5528,
      versionName: "7.26.0",
      minSdk: 26,
      abis: ["arm64-v8a", "armeabi-v7a", "x86_64"],
      launchableActivity: "com.exemplo.versao3.MainActivity",
    })
  })

  it("texto que não é APK → null", () => {
    // Arrange
    const text = "ERROR: dump failed because no AndroidManifest.xml found"

    // Act
    const info = parseBadging(text)

    // Assert
    expect(info).toBeNull()
  })
})

describe("apkProblems", () => {
  it("aceita APK com x86_64", () => {
    // Arrange
    const info = parseBadging(fx("aapt2/badging.txt"))!

    // Act
    const problems = apkProblems(info)

    // Assert
    expect(problems).toEqual([])
  })

  it("recusa APK só com ARM", () => {
    // Arrange
    const info = parseBadging(fx("aapt2/arm-only.txt"))!

    // Act
    const problems = apkProblems(info)

    // Assert
    expect(problems[0]).toMatch(/x86_64/)
  })

  it("recusa APK que exige Android mais novo que o emulador", () => {
    // Arrange
    const info = { ...parseBadging(fx("aapt2/badging.txt"))!, minSdk: 34 }

    // Act
    const problems = apkProblems(info)

    // Assert
    expect(problems[0]).toMatch(/API 34/)
  })
})

describe("parseAdbDevices", () => {
  it("junta emulator-5556 e 127.0.0.1:5557 no mesmo aparelho", () => {
    // Arrange
    const text = fx("adb/devices.txt")

    // Act
    const devs = parseAdbDevices(text)

    // Assert
    expect(devs.find((d) => d.serial === "emulator-5556")?.rawSerials.sort()).toEqual(["127.0.0.1:5557", "emulator-5556"])
  })

  it("classifica emuladores com índice e o aparelho físico como externo", () => {
    // Arrange
    const text = fx("adb/devices.txt")

    // Act
    const devs = parseAdbDevices(text)

    // Assert
    expect(devs.map((d) => [d.serial, d.kind, d.index ?? null, d.adbState])).toEqual([
      ["emulator-5554", "emulator", 1, "device"],
      ["emulator-5556", "emulator", 2, "device"],
      ["emulator-5558", "emulator", 3, "offline"],
      ["emulator-5560", "emulator", 4, "unauthorized"],
      ["R9QYB016NGH", "physical", null, "device"],
    ])
  })

  it("saída vazia → nenhum aparelho", () => {
    // Arrange
    const text = "List of devices attached\n\n"

    // Act
    const devs = parseAdbDevices(text)

    // Assert
    expect(devs).toEqual([])
  })
})

describe("portsFor / serialFromIndex", () => {
  it("calcula portas fixas pelo índice", () => {
    // Arrange
    const index = 3

    // Act
    const ports = portsFor(index)

    // Assert
    expect([ports, serialFromIndex(index)]).toEqual([
      { appium: 4801, system: 8203, mjpeg: 9203, chromedriver: 9603 },
      "emulator-5558",
    ])
  })

  it("um Appium atende cada grupo de 5 celulares", () => {
    // Arrange
    const indexes = [1, 5, 6, 10, 11, 15, 18]

    // Act
    const groups = indexes.map((i) => appiumGroup(i, 5))

    // Assert
    expect(groups).toEqual([1, 1, 2, 2, 3, 3, 4])
  })
})
