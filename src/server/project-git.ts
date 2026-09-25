import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import type { Config } from "@/core/config"
import {
  BranchNameSchema,
  type Commit,
  envValues,
  type GitSnapshot,
  LOG_FORMAT,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseStatus,
  REF_FORMAT,
} from "@/core/project-git"

import { run, sleep } from "./exec"

// git do projeto Robot. Só o runner chama (um por vez): leitura local para a página Projeto, fetch e
// "atualizar" = trocar de branch + avançar só por fast-forward. Nunca descarta nada (sem reset/stash/clean):
// árvore alterada ou branch local divergente → recusa com a explicação, repositório intocado.

export interface ProjectGit {
  readonly root: string
  snapshot(incomingBranch?: string): Promise<GitSnapshot>
  remoteUrl(): Promise<string>
  fetch(log: (line: string) => void): Promise<void>
  update(branch: string, log: (line: string) => void): Promise<{ ok: boolean; message: string }>
}

export class GitRefused extends Error {}

/** URL do remoto sem usuário/senha embutidos (https://user:token@… → https://…). */
export function cleanRemoteUrl(url: string): string {
  return url.trim().replace(/^(https?:\/\/)[^@/]*@/i, "$1")
}

export function realProjectGit(root: string): ProjectGit {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new",
  }
  const git = (args: string[], timeoutMs = 15_000) => run("git", ["-C", root, ...args], { env, timeoutMs })
  const ok = async (args: string[], timeoutMs?: number) => (await git(args, timeoutMs)).code === 0
  const must = async (args: string[], log: (l: string) => void, timeoutMs = 60_000) => {
    log(`$ git ${args.join(" ")}`)
    const r = await git(args, timeoutMs)
    for (const l of `${r.stdout}\n${r.stderr}`
      .split("\n")
      .map((x) => x.trimEnd())
      .filter(Boolean)) {
      if (!/post-quantum|store now, decrypt later|server may need to be upgraded|^\*\* /i.test(l)) log(l)
    }
    if (r.code !== 0) throw new Error(`git ${args[0]} falhou (código ${r.code})`)
    return r.stdout
  }
  const exists = (ref: string) => ok(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])

  return {
    root,
    async snapshot(incomingBranch) {
      const st = parseStatus(
        (await git(["status", "--porcelain=v1", "-b", "--untracked-files=normal"])).stdout,
      )
      const commits = parseLog(
        (await git(["log", "-n", "30", `--format=${LOG_FORMAT}`, "HEAD", "--"])).stdout,
      )
      const remoteBranches = parseRefs(
        (await git(["for-each-ref", "refs/remotes/origin", `--format=${REF_FORMAT}`])).stdout,
      )
      const target = incomingBranch ?? st.branch
      let incoming: GitSnapshot["incoming"] = null
      if (
        target &&
        BranchNameSchema.safeParse(target).success &&
        (await exists(`refs/remotes/origin/${target}`))
      ) {
        const up = `refs/remotes/origin/${target}`
        incoming = {
          branch: target,
          commits: parseLog(
            (await git(["log", "-n", "50", `--format=${LOG_FORMAT}`, `HEAD..${up}`, "--"])).stdout,
          ),
          files: parseNameStatus((await git(["diff", "--name-status", `HEAD...${up}`, "--"])).stdout).slice(
            0,
            300,
          ),
        }
      }
      return { ...st, head: commits[0] ?? null, commits, remoteBranches, incoming }
    },
    async remoteUrl() {
      return cleanRemoteUrl((await git(["config", "--get", "remote.origin.url"])).stdout)
    },
    async fetch(log) {
      await must(["fetch", "--prune", "origin"], log, 120_000)
    },
    async update(branch, log) {
      try {
        const b = BranchNameSchema.parse(branch)
        if (!(await ok(["check-ref-format", "--branch", b])))
          throw new GitRefused(`Nome de branch inválido: ${b}`)
        await must(["fetch", "--prune", "origin"], log, 120_000)
        const remoteRef = `refs/remotes/origin/${b}`
        if (!(await exists(remoteRef))) throw new GitRefused(`A branch ${b} não existe no servidor git`)
        const dirty = (await git(["status", "--porcelain", "--untracked-files=no"])).stdout.trim()
        if (dirty) {
          throw new GitRefused(
            `Há alterações locais no projeto do servidor (${dirty.split("\n").length} arquivo(s)): nada foi mudado. Resolva no servidor (commit ou descarte) antes de atualizar.`,
          )
        }
        for (const f of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
          const p = (await git(["rev-parse", "--git-path", f])).stdout.trim()
          if (p && fs.existsSync(path.resolve(root, p)))
            throw new GitRefused(`Há uma operação git pela metade no servidor (${f}): nada foi mudado`)
        }
        const local = `refs/heads/${b}`
        if (await exists(local)) {
          if (!(await ok(["merge-base", "--is-ancestor", local, remoteRef]))) {
            throw new GitRefused(
              `A branch local ${b} tem commits que não estão no servidor git (divergiu): nada foi mudado`,
            )
          }
          const current = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim()
          if (current !== b) await must(["switch", b], log)
        } else {
          await must(["switch", "-c", b, "--track", `origin/${b}`], log)
        }
        await must(["merge", "--ff-only", `origin/${b}`], log)
        const head = parseLog(
          (await git(["log", "-n", "1", `--format=${LOG_FORMAT}`, "HEAD", "--"])).stdout,
        )[0]
        return { ok: true, message: `Projeto em ${b} @ ${head?.hash.slice(0, 7)} — ${head?.subject ?? ""}` }
      } catch (e) {
        const msg = e instanceof GitRefused ? e.message : (e as Error).message
        log(`✖ ${msg}`)
        return { ok: false, message: msg }
      }
    },
  }
}

// ----------------------------------------------------------------------- fake ---
/** Fake (modo simulado): branches em memória; QAFARM_FAKE_GIT=dirty simula alteração local no servidor. */
export function fakeProjectGit(cfg: Config, root: string): ProjectGit {
  const at = (h: number) => new Date(Date.UTC(2026, 0, 1, 12, 0) + h * 3600_000).toISOString()
  const mk = (branch: string, n: number, base: number): Commit[] =>
    Array.from({ length: n }, (_, i) => ({
      hash: `${branch.replace(/\W/g, "")}${String(n - i).padStart(3, "0")}`.padEnd(40, "0").slice(0, 40),
      subject: `${branch}: ajuste ${n - i}`,
      author: "QA",
      date: at(base + n - i),
    }))
  const remote: Record<string, Commit[]> = {
    main: mk("main", 5, 0),
    develop: mk("develop", 8, 10),
    "feature/exemplo": mk("feature/exemplo", 3, 20),
  }
  let current = "main"
  let local: Commit[] = remote.main.slice(2) // 2 commits atrás do servidor
  const dirty = () =>
    process.env.QAFARM_FAKE_GIT === "dirty" ? [{ code: "M", path: "scenarios/login/login.robot" }] : []
  return {
    root,
    async snapshot(incomingBranch) {
      const target = incomingBranch ?? current
      const up = remote[target]
      const have = new Set(local.map((c) => c.hash))
      const incomingCommits = up ? up.filter((c) => !have.has(c.hash)) : []
      return {
        branch: current,
        upstream: `origin/${current}`,
        ahead: 0,
        behind: remote[current].filter((c) => !have.has(c.hash)).length,
        head: local[0] ?? null,
        dirty: dirty(),
        commits: local,
        remoteBranches: Object.entries(remote).map(([name, cs]) => ({
          name,
          hash: cs[0].hash,
          date: cs[0].date,
          subject: cs[0].subject,
        })),
        incoming: up
          ? {
              branch: target,
              commits: incomingCommits,
              files: incomingCommits.length ? [{ status: "M", path: "scenarios/login/login.robot" }] : [],
            }
          : null,
      }
    },
    async remoteUrl() {
      return "git@git.example.invalid:qa/projeto-robot"
    },
    async fetch(log) {
      log("$ git fetch --prune origin")
      await sleep(200 * cfg.fakeSpeed)
    },
    async update(branch, log) {
      log("$ git fetch --prune origin")
      await sleep(200 * cfg.fakeSpeed)
      if (!BranchNameSchema.safeParse(branch).success || !remote[branch]) {
        log(`✖ A branch ${branch} não existe no servidor git`)
        return { ok: false, message: `A branch ${branch} não existe no servidor git` }
      }
      if (dirty().length) {
        const msg =
          "Há alterações locais no projeto do servidor (1 arquivo(s)): nada foi mudado. Resolva no servidor (commit ou descarte) antes de atualizar."
        log(`✖ ${msg}`)
        return { ok: false, message: msg }
      }
      if (branch !== current) log(`$ git switch ${branch}`)
      log(`$ git merge --ff-only origin/${branch}`)
      current = branch
      local = [...remote[branch]]
      return {
        ok: true,
        message: `Projeto em ${branch} @ ${local[0].hash.slice(0, 7)} — ${local[0].subject}`,
      }
    },
  }
}

/** Raiz do projeto mostrada na página (no modo simulado, o projeto de exemplo dos testes). */
export function projectRoot(cfg: Config): string {
  return cfg.fake ? path.join(cfg.repoRoot, "tests/fixtures/fake-project") : cfg.robotProject
}

/** Segredos do projeto a mascarar: chave do BrowserStack do painel e valores dos arquivos de ambiente. */
export async function projectSecrets(cfg: Config, root = projectRoot(cfg)): Promise<string[]> {
  const out = [cfg.bsKey].filter(Boolean)
  const base = path.join(root, "testsData", "importEnvs")
  for (const env of await fsp.readdir(base).catch(() => [] as string[])) {
    for (const f of await fsp.readdir(path.join(base, env)).catch(() => [] as string[])) {
      if (!/^\.env/i.test(f)) continue
      out.push(...envValues(await fsp.readFile(path.join(base, env, f), "utf8").catch(() => "")))
    }
  }
  return out
}
