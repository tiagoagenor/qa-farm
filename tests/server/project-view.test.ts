import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { MASK } from "@/core/project-git"
import { listProjectDir, readProjectFile, resolveProjectPath } from "@/server/web/project"

const REPO = path.resolve(__dirname, "../..")
const FAKE = path.join(REPO, "tests/fixtures/fake-project")

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

describe("visualizador de código (somente leitura)", () => {
  it("não sai da pasta do projeto: '..', caminho absoluto, .git e link simbólico para fora", async () => {
    // Arrange
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "qafarm-view-"))
    dirs.push(root)
    await fs.mkdir(path.join(root, ".git"))
    await fs.writeFile(path.join(root, ".git", "config"), "x")
    await fs.symlink("/etc", path.join(root, "fora"))
    await fs.writeFile(path.join(root, "ok.robot"), "ok")

    // Act
    const out = await Promise.all(
      ["../x", "/etc/passwd", ".git/config", "fora/hosts", "ok.robot"].map((p) =>
        resolveProjectPath(root, p),
      ),
    )

    // Assert
    expect(out.map((x) => (x ? path.basename(x) : null))).toEqual([null, null, null, null, "ok.robot"])
  })

  it("lista pastas primeiro e esconde o que é bloqueado", async () => {
    // Arrange
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "qafarm-view-"))
    dirs.push(root)
    for (const d of ["scenarios", ".git", "results", ".venv"]) await fs.mkdir(path.join(root, d))
    await fs.writeFile(path.join(root, "README.md"), "x")
    await fs.writeFile(path.join(root, "app.apk"), "x")

    // Act
    const entries = await listProjectDir("", root)

    // Assert
    expect(entries?.map((e) => `${e.type}:${e.name}`)).toEqual(["dir:scenarios", "file:README.md"])
  })

  it("arquivo de ambiente mostra só os nomes; valores e chaves viram •••• também em outros arquivos", async () => {
    // Arrange
    const envRel = "testsData/importEnvs/hml/.env_"
    const resRel = "resources/resource.robot"

    // Act
    const [env, res] = await Promise.all([readProjectFile(envRel, FAKE), readProjectFile(resRel, FAKE)])

    // Assert
    expect([
      env?.content.includes("QA_APP_PASSWORD_HML=••••"),
      env?.content.includes("senha-exemplo-123"),
      env?.content.includes("qa.exemplo@example.com"),
      res?.content.includes("FAKE_BS_KEY_123456"),
      res?.content.includes(`\${ACCESS_KEY}       ${MASK}`),
      res?.content.includes("Log    ${ACCESS_KEY}"),
      [env?.masked, res?.masked],
    ]).toEqual([true, false, false, false, true, true, [true, true]])
  })

  it("arquivo binário não é mostrado", async () => {
    // Arrange
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "qafarm-view-"))
    dirs.push(root)
    await fs.writeFile(path.join(root, "img.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]))

    // Act
    const f = await readProjectFile("img.png", root)

    // Assert
    expect([f?.binary, f?.content]).toEqual([true, ""])
  })
})
