import "server-only"

import fsp from "node:fs/promises"
import path from "node:path"

import { isBlockedPath, isEnvFile, MASK, maskSecrets, ProjectGitStateSchema } from "@/core/project-git"
import { readJson } from "@/core/store"
import { projectRoot, projectSecrets } from "@/server/project-git"

import { ctx } from "./context"
import { runnerStatus } from "./data"

// Página Projeto: estado do git (gravado pelo runner) e visualizador de código SOMENTE LEITURA da pasta do
// projeto. Nada aqui chama git nem escreve: o web só lê arquivos.

export const MAX_VIEW_BYTES = 512 * 1024

export async function readProject() {
  const { p } = ctx()
  const [state, runner] = await Promise.all([
    readJson(p.projectGit, ProjectGitStateSchema.nullable(), null),
    runnerStatus(),
  ])
  return { state, runnerAlive: runner.alive }
}

/** Caminho relativo (da URL) → absoluto dentro do projeto, ou null (fora da pasta, bloqueado, link para fora). */
export async function resolveProjectPath(root: string, rel: string): Promise<string | null> {
  const clean = rel.replace(/^\/+|\/+$/g, "")
  if (clean.includes("\0") || clean.split("/").some((s) => s === ".." || s === ".")) return null
  if (clean && isBlockedPath(clean)) return null
  const base = await fsp.realpath(root).catch(() => null)
  if (!base) return null
  const full = await fsp.realpath(path.join(base, clean)).catch(() => null)
  if (!full || (full !== base && !full.startsWith(base + path.sep))) return null
  return full
}

export interface TreeEntry {
  name: string
  path: string
  type: "dir" | "file"
  size?: number
}

export async function listProjectDir(
  rel: string,
  root = projectRoot(ctx().cfg),
): Promise<TreeEntry[] | null> {
  const dir = await resolveProjectPath(root, rel)
  if (!dir) return null
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null)
  if (!entries) return null
  const base = rel.replace(/^\/+|\/+$/g, "")
  const out: TreeEntry[] = []
  for (const e of entries) {
    const p = base ? `${base}/${e.name}` : e.name
    if (isBlockedPath(p)) continue
    const isDir =
      e.isDirectory() ||
      (e.isSymbolicLink() && (await fsp.stat(path.join(dir, e.name)).catch(() => null))?.isDirectory())
    out.push({
      name: e.name,
      path: p,
      type: isDir ? "dir" : "file",
      size: isDir ? undefined : (await fsp.stat(path.join(dir, e.name)).catch(() => null))?.size,
    })
  }
  return out.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name, "pt-BR") : a.type === "dir" ? -1 : 1,
  )
}

export interface ProjectFile {
  path: string
  size: number
  binary: boolean
  truncated: boolean
  masked: boolean
  content: string
}

export async function readProjectFile(
  rel: string,
  root = projectRoot(ctx().cfg),
): Promise<ProjectFile | null> {
  const file = await resolveProjectPath(root, rel)
  if (!file) return null
  const st = await fsp.stat(file).catch(() => null)
  if (!st?.isFile()) return null
  const fh = await fsp.open(file, "r")
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_VIEW_BYTES))
    await fh.read(buf, 0, buf.length, 0)
    const binary = buf.subarray(0, 8192).includes(0)
    if (binary)
      return { path: rel, size: st.size, binary: true, truncated: false, masked: false, content: "" }
    let text = buf.toString("utf8")
    let masked = false
    if (isEnvFile(path.basename(file))) {
      // arquivo de ambiente: mostra só os nomes (todo valor vira ••••)
      const out = text.replace(
        /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.+)$/gm,
        (_m, k: string) => `${k}${MASK}`,
      )
      masked = out !== text
      text = out
    }
    const r = maskSecrets(text, await projectSecrets(ctx().cfg, root))
    return {
      path: rel,
      size: st.size,
      binary: false,
      truncated: st.size > MAX_VIEW_BYTES,
      masked: masked || r.masked,
      content: r.text,
    }
  } finally {
    await fh.close()
  }
}
