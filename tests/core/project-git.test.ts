import { describe, expect, it } from "vitest"

import {
  BranchNameSchema,
  envValues,
  isBlockedPath,
  MASK,
  maskSecrets,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseStatus,
} from "@/core/project-git"

describe("BranchNameSchema", () => {
  it.each([
    ["main", true],
    ["feature/novo-fluxo_2", true],
    ["release/7.26.0", true],
    ["-x", false],
    ["--upload-pack=x", false],
    ["a..b", false],
    ["a.lock", false],
    ["x@{1}", false],
    ["com espaço", false],
    ["a//b", false],
    ["fim/", false],
    ["HEAD", false],
  ])("%s → %s", (name, ok) => {
    // Arrange
    const input = name

    // Act
    const r = BranchNameSchema.safeParse(input)

    // Assert
    expect(r.success).toBe(ok)
  })
})

describe("parsers do git", () => {
  it("status com upstream, atrás/à frente e arquivos alterados", () => {
    // Arrange
    const out = "## feature/pix...origin/feature/pix [ahead 1, behind 3]\n M scenarios/a.robot\n?? novo.txt\n"

    // Act
    const st = parseStatus(out)

    // Assert
    expect(st).toEqual({
      branch: "feature/pix",
      upstream: "origin/feature/pix",
      ahead: 1,
      behind: 3,
      dirty: [
        { code: "M", path: "scenarios/a.robot" },
        { code: "??", path: "novo.txt" },
      ],
    })
  })

  it("status sem upstream e com HEAD solto", () => {
    // Arrange
    const outs = ["## main\n", "## HEAD (no branch)\n"]

    // Act
    const sts = outs.map(parseStatus)

    // Assert
    expect(sts.map((s) => [s.branch, s.upstream, s.behind])).toEqual([
      ["main", null, 0],
      [null, null, 0],
    ])
  })

  it("log e refs com separadores de controle; origin/HEAD fica de fora; mais recente primeiro", () => {
    // Arrange
    const log =
      "abc\x1fajuste: pix\x1fQA\x1f2026-09-01T10:00:00Z\x1e\ndef\x1fcom | barra\x1fQA\x1f2026-08-01T10:00:00Z\x1e"
    const refs =
      "origin/HEAD\x1fh0\x1f2026-01-01T00:00:00Z\x1fx\x1e\norigin/main\x1fh1\x1f2026-01-02T00:00:00Z\x1fa\x1e\norigin/develop\x1fh2\x1f2026-02-01T00:00:00Z\x1fb\x1e"

    // Act
    const [commits, branches] = [parseLog(log), parseRefs(refs)]

    // Assert
    expect([commits.map((c) => c.subject), branches.map((b) => b.name)]).toEqual([
      ["ajuste: pix", "com | barra"],
      ["develop", "main"],
    ])
  })

  it("diff --name-status, inclusive renomeado", () => {
    // Arrange
    const out = "M\tscenarios/a.robot\nR100\tvelho.robot\tnovo.robot\n"

    // Act
    const files = parseNameStatus(out)

    // Assert
    expect(files).toEqual([
      { status: "M", path: "scenarios/a.robot" },
      { status: "R", path: "novo.robot" },
    ])
  })
})

describe("visualizador: bloqueios e segredos", () => {
  it.each([
    [".git/config", true],
    [".venv/lib/x.py", true],
    ["results/output.xml", true],
    ["app/genial.apk", true],
    ["certs/chave.pem", true],
    ["scenarios/login/login.robot", false],
    ["testsData/importEnvs/hml/.env_", false],
  ])("%s bloqueado = %s", (p, blocked) => {
    // Arrange
    const rel = p

    // Act
    const r = isBlockedPath(rel)

    // Assert
    expect(r).toBe(blocked)
  })

  it("valores de arquivo de ambiente (curtos e comentários ficam de fora)", () => {
    // Arrange
    const text = "# comentário\nSENHA=abc\nQA_APP_PASSWORD_HML='senha-longa-1'\nexport EMAIL=qa@example.com\n"

    // Act
    const vals = envValues(text)

    // Assert
    expect(vals).toEqual(["senha-longa-1", "qa@example.com"])
  })

  it("mascara valores conhecidos e atribuições com nome sensível, sem esconder referências nem 'keycode'", () => {
    // Arrange
    const text = [
      "${ACCESS_KEY}       CHAVE_REAL_999",
      '    "password": "Senha@123",',
      "${senha_hml}    minhaSenha1",
      "Input Password    ${senha_hml}",
      "Press Keycode    keycode=66",
      "Log    usa CHAVE_REAL_999 aqui",
    ].join("\n")

    // Act
    const r = maskSecrets(text, ["CHAVE_REAL_999"])

    // Assert
    expect(r.text.split("\n")).toEqual([
      `\${ACCESS_KEY}       ${MASK}`,
      `    "password": "${MASK}",`,
      `\${senha_hml}    ${MASK}`,
      "Input Password    ${senha_hml}",
      "Press Keycode    keycode=66",
      `Log    usa ${MASK} aqui`,
    ])
  })
})
