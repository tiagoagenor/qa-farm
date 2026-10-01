import fsp from "node:fs/promises"
import path from "node:path"

import { giatEntry, validGiatTest } from "@/core/giat"
import type { Catalog } from "@/core/types"

import { run } from "./exec"

/** Casos do GI-App-Test: todos os tests/**\/*.mjs (caminhos relativos a tests/). */
export async function listGiatTests(dir: string): Promise<string[]> {
  const root = path.join(dir, "tests")
  const out: string[] = []
  const walk = async (rel: string) => {
    const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(r)
      else if (e.isFile() && validGiatTest(r)) out.push(r)
    }
  }
  await walk("")
  return out.sort()
}

/**
 * Nomes bonitos pelo `node run.mjs --list --json` ([{rel, name}]), se o projeto tiver; senão, o nome do arquivo.
 * Nunca falha: sem a listagem, o catálogo usa só os arquivos.
 */
async function giatNames(dir: string, env: Record<string, string>): Promise<Map<string, { name: string; tags: string[] }>> {
  const r = await run(process.execPath, ["run.mjs", "--list", "--json"], { cwd: dir, env: env as unknown as NodeJS.ProcessEnv, timeoutMs: 30_000 }).catch(() => null)
  const names = new Map<string, { name: string; tags: string[] }>()
  if (!r || r.code !== 0) return names
  try {
    const list = JSON.parse(r.stdout) as Array<{ rel?: unknown; name?: unknown; tags?: unknown }>
    for (const x of Array.isArray(list) ? list : [])
      if (typeof x.rel === "string" && typeof x.name === "string")
        names.set(x.rel, { name: x.name, tags: Array.isArray(x.tags) ? x.tags.filter((t): t is string => typeof t === "string") : [] })
  } catch {
    /* saída não é JSON: fica o nome do arquivo */
  }
  return names
}

export async function buildGiatCatalog(dir: string, env: Record<string, string>, hash: string): Promise<Catalog> {
  const tests = await listGiatTests(dir)
  const names = tests.length ? await giatNames(dir, env) : new Map<string, { name: string; tags: string[] }>()
  const entries = tests.map((rel) => giatEntry(rel, names.get(rel)?.name, names.get(rel)?.tags))
  return { generatedAt: new Date().toISOString(), snapshotHash: hash, total: entries.length, entries }
}
