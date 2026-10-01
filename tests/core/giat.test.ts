import { describe, expect, it } from "vitest"

import { giatEnv, giatStatusFromExit, parseEnvFile, validGiatTest } from "@/core/giat"

describe("GI-App-Test", () => {
  it("aceita só caminhos .mjs dentro de tests/, fora de flows/ e sem ..", () => {
    // Arrange
    const cases = ["smoke/app_abre.mjs", "flows/login.mjs", "../run.mjs", "smoke/../../x.mjs", "smoke/app.js", "/etc/x.mjs", "a//b.mjs"]

    // Act
    const ok = cases.map(validGiatTest)

    // Assert
    expect(ok).toEqual([true, false, false, false, false, false, false])
  })

  it("ambiente limpo: nada da fazenda, segredos do .env.server e o serial reservado vence", () => {
    // Arrange
    const secrets = parseEnvFile('# senhas\nQA_APP_PASSWORD_HML="s3nha"\nexport QA_APP_EMAIL_DANY=dany@x\nGIAT_ALLOWED_DEVICES=OUTRO\n')

    // Act
    const env = giatEnv({ nodeBin: "/n/bin", sdkRoot: "/sdk", javaHome: "/jdk", home: "/h", tmpDir: "/t", serials: ["emulator-5554"], secrets })

    // Assert
    expect([env.QA_APP_PASSWORD_HML, env.QA_APP_EMAIL_DANY, env.GIAT_ALLOWED_DEVICES, env.ANDROID_HOME, "QAFARM_PASSWORD" in env, env.PATH.split(":")[0]]).toEqual([
      "s3nha",
      "dany@x",
      "emulator-5554",
      "/sdk",
      false,
      "/n/bin",
    ])
  })

  it("código de saída do run.mjs vira o status da execução", () => {
    // Arrange
    const codes = [0, 1, 2, 3, 143, null]

    // Act
    const st = codes.map((c) => giatStatusFromExit(c).status)

    // Assert
    expect(st).toEqual(["passed", "failed", "error", "error", "canceled", "error"])
  })
})
