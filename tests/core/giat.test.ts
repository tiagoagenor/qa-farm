import { describe, expect, it } from "vitest"

import { classifyGiat, giatEntry, giatEnv, parseEnvFile, validGiatTest } from "@/core/giat"

describe("GI-App-Test", () => {
  it("aceita só caminhos .mjs dentro de tests/, fora de flows/ e sem ..", () => {
    // Arrange
    const cases = ["smoke/app_abre.mjs", "flows/login.mjs", "../run.mjs", "smoke/../../x.mjs", "smoke/app.js", "/etc/x.mjs", "a//b.mjs"]

    // Act
    const ok = cases.map(validGiatTest)

    // Assert
    expect(ok).toEqual([true, false, false, false, false, false, false])
  })

  it("caso vira entrada do catálogo com a pasta de tests/ e o nome do --list", () => {
    // Arrange
    const rel = "login2/ct_login_01.mjs"

    // Act
    const e = giatEntry(rel, "Login válido", ["regressivo"])

    // Assert
    expect([e.id, e.name, e.folder, e.file, e.fileLongName, e.tags, e.accounts]).toEqual([
      "giat:login2/ct_login_01.mjs",
      "Login válido",
      "tests/login2",
      "tests/login2/ct_login_01.mjs",
      "login2/ct_login_01.mjs",
      ["regressivo"],
      [],
    ])
  })

  it("ambiente limpo: nada da fazenda, segredos do .env.server e celular/Appium/porta da fazenda vencem", () => {
    // Arrange
    const secrets = parseEnvFile('# senhas\nQA_APP_PASSWORD_HML="s3nha"\nexport QA_APP_EMAIL_DANY=dany@x\nAPPIUM_URL=http://outro\nDEVICE_SERIAL=X\n')

    // Act
    const env = giatEnv({
      nodeBin: "/n/bin",
      sdkRoot: "/sdk",
      javaHome: "/jdk",
      home: "/h",
      tmpDir: "/t",
      serial: "emulator-5554",
      appiumUrl: "http://127.0.0.1:4801/wd/hub",
      systemPort: 8201,
      secrets,
    })

    // Assert
    expect([
      env.QA_APP_PASSWORD_HML,
      env.QA_APP_EMAIL_DANY,
      env.GIAT_ALLOWED_DEVICES,
      env.DEVICE_SERIAL,
      env.APPIUM_URL,
      env.SYSTEM_PORT,
      Object.keys(env).some((k) => k.startsWith("QAFARM_")),
    ]).toEqual(["s3nha", "dany@x", "emulator-5554", "emulator-5554", "http://127.0.0.1:4801/wd/hub", "8201", false])
  })

  it("código de saída e --json viram o status da tentativa", () => {
    // Arrange
    const base = { canceled: false, timedOut: false, deviceLost: false, screenshots: [] }
    const fail = [{ ok: false, error: "Elemento não apareceu" }]

    // Act
    const st = [
      classifyGiat({ ...base, exitCode: 0, results: [{ ok: true }] }),
      classifyGiat({ ...base, exitCode: 1, results: fail }),
      classifyGiat({ ...base, exitCode: 1, results: [{ ok: false, infra: true, error: "sem sessão" }] }),
      classifyGiat({ ...base, exitCode: 2, results: [] }),
      classifyGiat({ ...base, exitCode: 3, results: [] }),
      classifyGiat({ ...base, exitCode: 143, results: [], timedOut: true }),
      classifyGiat({ ...base, exitCode: 143, results: [], canceled: true }),
    ].map((r) => [r.status, r.message ?? null])

    // Assert
    expect(st.map((x) => x[0])).toEqual(["passed", "failed", "infra_error", "config_error", "infra_error", "timeout", "canceled"])
    expect(st[1][1]).toBe("Elemento não apareceu")
  })
})
