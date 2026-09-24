import { createHash, randomBytes } from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"

import type { Config } from "@/core/config"
import { dataPaths } from "@/core/paths"

import { run } from "./exec"

export interface Snapshot {
  hash: string
  dir: string
}

export interface SnapshotProvider {
  /** Garante um snapshot da revisão atual do projeto e devolve onde ele está. */
  ensure(): Promise<Snapshot>
  /** Remove snapshots antigos, mantendo os informados. */
  prune(keep: Set<string>): Promise<void>
}

const IMPORT_RE = /^[ \t]*(?:Resource|Variables|Library)[ \t]{2,}(\S+\.(?:robot|resource|py))/gim
const READY_MARK = ".qafarm-snapshot"

/**
 * No Mac/Windows os imports com letras trocadas (ex.: elements/Investimentos) funcionam; no Linux não.
 * Cria links simbólicos com o nome usado no import apontando para a pasta/arquivo real.
 * Retorna os links criados (relativos à raiz).
 */
export async function fixCaseLinks(root: string): Promise<string[]> {
  const created: string[] = []
  async function walk(dir: string): Promise<string[]> {
    const out: string[] = []
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...(await walk(p)))
      else if (/\.(robot|resource)$/.test(e.name)) out.push(p)
    }
    return out
  }
  for (const file of await walk(root)) {
    const text = await fsp.readFile(file, "utf8")
    for (const m of text.matchAll(IMPORT_RE)) {
      const rel = m[1]
      if (rel.includes("${") || !rel.includes("/")) continue
      let cur = path.dirname(file)
      for (const part of rel.split("/")) {
        if (part === "" || part === ".") continue
        if (part === "..") {
          cur = path.dirname(cur)
          continue
        }
        const next = path.join(cur, part)
        const exists = await fsp.lstat(next).then(
          () => true,
          () => false,
        )
        if (!exists) {
          const entries = await fsp.readdir(cur).catch(() => [] as string[])
          const match = entries.filter((e) => e.toLowerCase() === part.toLowerCase())
          if (match.length === 1) {
            await fsp.symlink(match[0], next)
            created.push(path.relative(root, next))
          }
        }
        cur = next
      }
    }
  }
  return created
}

async function sha256OfEnvFiles(project: string): Promise<string> {
  const h = createHash("sha256")
  const base = path.join(project, "testsData", "importEnvs")
  const envs = await fsp.readdir(base).catch(() => [] as string[])
  for (const env of envs.sort()) {
    for (const f of [".env", ".env_"]) {
      const content = await fsp.readFile(path.join(base, env, f)).catch(() => null)
      if (content) h.update(`${env}/${f}`).update(content)
    }
  }
  return h.digest("hex")
}

/** Hash da revisão do projeto: commit + alterações locais + arquivos de ambiente (ignorados pelo git). */
export async function projectRevisionHash(project: string): Promise<string> {
  const head = await run("git", ["-C", project, "rev-parse", "HEAD"], { timeoutMs: 15_000 })
  const status = await run("git", ["-C", project, "status", "--porcelain"], { timeoutMs: 15_000 })
  const diff = await run("git", ["-C", project, "diff", "HEAD"], { timeoutMs: 30_000 })
  return createHash("sha256")
    .update(head.stdout)
    .update(status.stdout)
    .update(diff.stdout)
    .update(await sha256OfEnvFiles(project))
    .digest("hex")
    .slice(0, 16)
}

export function realSnapshots(cfg: Config): SnapshotProvider {
  const paths = dataPaths(cfg.dataDir)
  return {
    async ensure() {
      const hash = await projectRevisionHash(cfg.robotProject)
      const dir = path.join(paths.workspaces, hash)
      const ready = await fsp.access(path.join(dir, READY_MARK)).then(
        () => true,
        () => false,
      )
      if (ready) return { hash, dir }
      const tmp = `${dir}.tmp-${randomBytes(3).toString("hex")}`
      await fsp.mkdir(paths.workspaces, { recursive: true })
      const r = await run(
        "rsync",
        [
          "-a", "--delete",
          "--exclude", ".git", "--exclude", ".venv", "--exclude", "results", "--exclude", "logs",
          "--exclude", "app/*.apk", "--exclude", "__pycache__",
          `${cfg.robotProject}/`, `${tmp}/`,
        ],
        { timeoutMs: 300_000 },
      )
      if (r.code !== 0) throw new Error(`rsync falhou: ${r.stderr.slice(0, 500)}`)
      const links = await fixCaseLinks(tmp)
      await fsp.writeFile(path.join(tmp, READY_MARK), JSON.stringify({ hash, links, createdAt: new Date().toISOString() }))
      await run("chmod", ["-R", "a-w", tmp])
      await fsp.rename(tmp, dir).catch(async () => {
        // outro processo criou antes: descarta o nosso
        await run("chmod", ["-R", "u+w", tmp])
        await fsp.rm(tmp, { recursive: true, force: true })
      })
      return { hash, dir }
    },
    async prune(keep) {
      const names = await fsp.readdir(paths.workspaces).catch(() => [] as string[])
      for (const n of names) {
        if (keep.has(n)) continue
        const p = path.join(paths.workspaces, n)
        await run("chmod", ["-R", "u+w", p])
        await fsp.rm(p, { recursive: true, force: true })
      }
    },
  }
}

export function fakeSnapshots(cfg: Config): SnapshotProvider {
  return {
    async ensure() {
      return { hash: "fake0000000000000", dir: path.join(cfg.repoRoot, "tests/fixtures/fake-project") }
    },
    async prune() {},
  }
}
