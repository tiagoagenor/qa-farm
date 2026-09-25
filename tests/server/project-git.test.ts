import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { run } from "@/server/exec"
import { cleanRemoteUrl, realProjectGit } from "@/server/project-git"

// Adaptador git real contra repositórios temporários: "origin" é um repositório bare local (sem rede).

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "QA",
  GIT_AUTHOR_EMAIL: "qa@example.com",
  GIT_COMMITTER_NAME: "QA",
  GIT_COMMITTER_EMAIL: "qa@example.com",
}
async function git(cwd: string, ...args: string[]) {
  const r = await run("git", ["-C", cwd, ...args], { env: ENV })
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}
async function commit(cwd: string, file: string, text: string, msg: string) {
  await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true })
  await fs.writeFile(path.join(cwd, file), text)
  await git(cwd, "add", "-A")
  await git(cwd, "commit", "-q", "-m", msg)
}

/** origin (bare) com main e develop; "project" = clone em main; "dev" = outra cópia para empurrar novidades. */
async function repos() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "qafarm-git-"))
  dirs.push(base)
  const origin = path.join(base, "origin.git")
  const seed = path.join(base, "seed")
  await run("git", ["init", "-q", "--bare", "-b", "main", origin])
  await run("git", ["init", "-q", "-b", "main", seed])
  await commit(seed, "scenarios/login.robot", "v1\n", "inicial")
  await git(seed, "remote", "add", "origin", origin)
  await git(seed, "push", "-q", "origin", "main")
  await git(seed, "switch", "-q", "-c", "develop")
  await commit(seed, "scenarios/pix.robot", "pix\n", "develop: pix")
  await git(seed, "push", "-q", "origin", "develop")
  await git(seed, "switch", "-q", "main")
  const project = path.join(base, "project")
  await run("git", ["clone", "-q", origin, project])
  const pushMain = async (msg: string) => {
    await commit(seed, "scenarios/login.robot", `${msg}\n`, msg)
    await git(seed, "push", "-q", "origin", "main")
  }
  return { origin, seed, project, pushMain }
}

describe("git do projeto (adaptador real)", () => {
  it("buscar lista as branches do servidor e mostra quantos commits a atual está atrás e o que viria", async () => {
    // Arrange
    const r = await repos()
    await r.pushMain("main: ajuste 2")
    const g = realProjectGit(r.project)

    // Act
    await g.fetch(() => undefined)
    const snap = await g.snapshot()

    // Assert
    expect([
      snap.branch,
      snap.behind,
      snap.remoteBranches.map((b) => b.name).sort(),
      snap.incoming?.commits.map((c) => c.subject),
      snap.incoming?.files,
    ]).toEqual([
      "main",
      1,
      ["develop", "main"],
      ["main: ajuste 2"],
      [{ status: "M", path: "scenarios/login.robot" }],
    ])
  })

  it("atualizar a branch atual avança por fast-forward", async () => {
    // Arrange
    const r = await repos()
    await r.pushMain("main: ajuste 2")
    const g = realProjectGit(r.project)
    const log: string[] = []

    // Act
    const res = await g.update("main", (l) => log.push(l))

    // Assert
    expect([
      res.ok,
      await fs.readFile(path.join(r.project, "scenarios/login.robot"), "utf8"),
      log.some((l) => l.includes("merge --ff-only")),
    ]).toEqual([true, "main: ajuste 2\n", true])
  })

  it("trocar para uma branch que só existe no servidor cria a local já rastreando a remota", async () => {
    // Arrange
    const r = await repos()
    const g = realProjectGit(r.project)

    // Act
    const res = await g.update("develop", () => undefined)

    // Assert
    expect([
      res.ok,
      await git(r.project, "rev-parse", "--abbrev-ref", "HEAD"),
      await git(r.project, "rev-parse", "--abbrev-ref", "@{u}"),
    ]).toEqual([true, "develop", "origin/develop"])
  })

  it("alteração local em arquivo do projeto: recusa e não mexe em nada", async () => {
    // Arrange
    const r = await repos()
    await r.pushMain("main: ajuste 2")
    await fs.writeFile(path.join(r.project, "scenarios/login.robot"), "editado no servidor\n")
    const before = await git(r.project, "rev-parse", "HEAD")
    const g = realProjectGit(r.project)

    // Act
    const res = await g.update("main", () => undefined)

    // Assert
    expect([
      res.ok,
      res.message.includes("alterações locais"),
      await git(r.project, "rev-parse", "HEAD"),
      await fs.readFile(path.join(r.project, "scenarios/login.robot"), "utf8"),
    ]).toEqual([false, true, before, "editado no servidor\n"])
  })

  it("branch local divergente (commit local que não está no servidor): recusa e HEAD fica igual", async () => {
    // Arrange
    const r = await repos()
    await r.pushMain("main: ajuste 2")
    await commit(r.project, "local.txt", "x\n", "commit só no servidor de testes")
    const before = await git(r.project, "rev-parse", "HEAD")
    const g = realProjectGit(r.project)

    // Act
    const res = await g.update("main", () => undefined)

    // Assert
    expect([res.ok, res.message.includes("divergiu"), await git(r.project, "rev-parse", "HEAD")]).toEqual([
      false,
      true,
      before,
    ])
  })

  it("branch inexistente ou nome malicioso: recusa", async () => {
    // Arrange
    const r = await repos()
    const g = realProjectGit(r.project)

    // Act
    const res = await Promise.all(
      ["nao-existe", "--upload-pack=touch /tmp/x"].map((b) => g.update(b, () => undefined)),
    )

    // Assert
    expect(res.map((x) => x.ok)).toEqual([false, false])
  })

  it("URL do remoto nunca mostra usuário/senha embutidos", () => {
    // Arrange
    const urls = ["https://user:token123@dev.azure.com/org/p/_git/r", "git@ssh.dev.azure.com:v3/org/p/r"]

    // Act
    const out = urls.map(cleanRemoteUrl)

    // Assert
    expect(out).toEqual(["https://dev.azure.com/org/p/_git/r", "git@ssh.dev.azure.com:v3/org/p/r"])
  })
})
