import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { isSafeId, newId } from "@/core/ids"
import { contentTypeFor, safeJoin } from "@/core/paths"
import { buildRobotArgs, buildRobotEnv, escapeRobotPattern } from "@/core/robot-args"
import { listJsonFiles, readJson, writeJsonAtomic } from "@/core/store"

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "qafarm-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("safeJoin", () => {
  it("aceita caminho dentro da base, com acentos e símbolos codificados", () => {
    // Arrange
    const segs = ["queue_x", "i0001", "a1", encodeURIComponent("FAIL-CT_01 (ç+$).png")]

    // Act
    const p = safeJoin("/data/runs", segs)

    // Assert
    expect(p).toBe("/data/runs/queue_x/i0001/a1/FAIL-CT_01 (ç+$).png")
  })

  it.each([[[".."]], [["a", "..", "..", "etc"]], [["%2e%2e"]], [["a%2Fb"]], [["x%00"]], [[""]]])(
    "recusa tentativa de sair da pasta: %j",
    (segs) => {
      // Arrange
      const base = "/data/runs"

      // Act
      const p = safeJoin(base, segs)

      // Assert
      expect(p).toBeNull()
    },
  )
})

describe("contentTypeFor", () => {
  it("usa text/html para log.html", () => {
    // Arrange
    const file = "log.html"

    // Act
    const ct = contentTypeFor(file)

    // Assert
    expect(ct).toBe("text/html; charset=utf-8")
  })
})

describe("store", () => {
  it("grava e lê JSON validado", async () => {
    // Arrange
    const file = path.join(dir, "a", "b.json")

    // Act
    await writeJsonAtomic(file, { n: 1 })
    const data = await readJson(file, z.object({ n: z.number() }), { n: 0 })

    // Assert
    expect(data).toEqual({ n: 1 })
  })

  it("arquivo corrompido devolve o valor padrão", async () => {
    // Arrange
    const file = path.join(dir, "bad.json")
    await fs.writeFile(file, "{ not json")

    // Act
    const data = await readJson(file, z.object({ n: z.number() }), { n: -1 })

    // Assert
    expect(data).toEqual({ n: -1 })
  })

  it("JSON fora do schema devolve o valor padrão", async () => {
    // Arrange
    const file = path.join(dir, "x.json")
    await fs.writeFile(file, JSON.stringify({ n: "texto" }))

    // Act
    const data = await readJson(file, z.object({ n: z.number() }), { n: -1 })

    // Assert
    expect(data).toEqual({ n: -1 })
  })

  it("não deixa arquivos temporários para trás", async () => {
    // Arrange
    const file = path.join(dir, "c.json")

    // Act
    await writeJsonAtomic(file, { ok: true })
    const names = await fs.readdir(dir)

    // Assert
    expect(names).toEqual(["c.json"])
  })

  it("lista apenas .json em ordem", async () => {
    // Arrange
    await fs.writeFile(path.join(dir, "b.json"), "{}")
    await fs.writeFile(path.join(dir, "a.json"), "{}")
    await fs.writeFile(path.join(dir, "c.tmp"), "{}")

    // Act
    const files = await listJsonFiles(dir)

    // Assert
    expect(files.map((f) => path.basename(f))).toEqual(["a.json", "b.json"])
  })
})

describe("ids", () => {
  it("newId gera id seguro e ordenável", () => {
    // Arrange
    const now = new Date("2026-09-24T01:02:03Z")

    // Act
    const id = newId("queue", now)

    // Assert
    expect([id.startsWith("queue_20260924-010203_"), isSafeId(id)]).toEqual([true, true])
  })

  it("isSafeId recusa caminhos", () => {
    // Arrange
    const id = "../etc/passwd"

    // Act
    const ok = isSafeId(id)

    // Assert
    expect(ok).toBe(false)
  })
})

describe("robot args", () => {
  it("escapa caracteres de glob no nome do caso", () => {
    // Arrange
    const name = "Suite.CT_[A]*?"

    // Act
    const escaped = escapeRobotPattern(name)

    // Assert
    expect(escaped).toBe("Suite.CT_[[]A][*][?]")
  })

  it("monta argv com listener, variáveis, --test e arquivo", () => {
    // Arrange
    const input = {
      listenerPath: "/repo/scripts/robot/qafarm_listener.py",
      env: "hml" as const,
      fileLongName: "Login.CT_LOGIN_09 (ç+$)",
      outputDir: "/data/runs/q/i/a1",
      suiteFile: "scenarios/login/login.robot",
    }

    // Act
    const args = buildRobotArgs(input)

    // Assert
    expect(args).toEqual([
      "--listener",
      "/repo/scripts/robot/qafarm_listener.py",
      "-v",
      "LOC:local",
      "-v",
      "FORMATO:apk",
      "-v",
      "AMBIENTE:hml",
      "--test",
      "Login.CT_LOGIN_09 (ç+$)",
      "--outputdir",
      "/data/runs/q/i/a1",
      "--console",
      "verbose",
      "--consolecolors",
      "off",
      "scenarios/login/login.robot",
    ])
  })

  it("ambiente do robot não inclui segredos do painel", () => {
    // Arrange
    const base = { PATH: "/bin", HOME: "/h", QAFARM_PASSWORD: "p", QAFARM_SECRET: "s", OTHER: "x" }

    // Act
    const env = buildRobotEnv(base, { AMBIENTE: "hml", QAFARM_SERIAL: "emulator-5554" })

    // Assert
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", AMBIENTE: "hml", QAFARM_SERIAL: "emulator-5554" })
  })
})
