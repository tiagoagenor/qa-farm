import type { CatalogEntry } from "@/core/types"

// Árvore do catálogo igual à estrutura do projeto: pastas → arquivo .robot → casos.

/** O mínimo que a árvore precisa: serve para casos do catálogo e itens de uma fila. */
export type TreeEntry = Pick<CatalogEntry, "id" | "folder" | "file" | "line">

export type TreeRow<E extends TreeEntry = CatalogEntry> =
  | { kind: "folder"; key: string; name: string; depth: number; ids: string[] }
  | { kind: "file"; key: string; name: string; depth: number; ids: string[] }
  | { kind: "test"; key: string; entry: E; depth: number }

interface Folder<E extends TreeEntry> {
  name: string
  path: string
  folders: Map<string, Folder<E>>
  files: Map<string, E[]>
}

const ROOT = "scenarios"

function newFolder<E extends TreeEntry>(name: string, path: string): Folder<E> {
  return { name, path, folders: new Map(), files: new Map() }
}

function build<E extends TreeEntry>(entries: E[]): Folder<E> {
  const root = newFolder<E>(ROOT, ROOT)
  for (const e of entries) {
    const parts = e.folder.split("/").slice(1) // sem o "scenarios"
    let cur = root
    for (const p of parts) {
      if (!cur.folders.has(p)) cur.folders.set(p, newFolder<E>(p, `${cur.path}/${p}`))
      cur = cur.folders.get(p)!
    }
    const list = cur.files.get(e.file) ?? []
    list.push(e)
    cur.files.set(e.file, list)
  }
  return root
}

function allIds<E extends TreeEntry>(f: Folder<E>): string[] {
  return [...[...f.folders.values()].flatMap(allIds), ...[...f.files.values()].flat().map((e) => e.id)]
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" })
const baseName = (file: string) => file.slice(file.lastIndexOf("/") + 1)

/**
 * Linhas visíveis da árvore. `expanded` guarda as chaves abertas (caminho da pasta ou do arquivo);
 * com `expandAll` (busca/filtro ativo) tudo aparece aberto. Casos mantêm a ordem do arquivo.
 */
export function buildTreeRows<E extends TreeEntry>(entries: E[], expanded: ReadonlySet<string>, expandAll = false): TreeRow<E>[] {
  const rows: TreeRow<E>[] = []
  const walk = (f: Folder<E>, depth: number) => {
    const subfolders = [...f.folders.values()].sort(byName)
    for (const sub of subfolders) {
      rows.push({ kind: "folder", key: sub.path, name: sub.name, depth, ids: allIds(sub) })
      if (expandAll || expanded.has(sub.path)) walk(sub, depth + 1)
    }
    const files = [...f.files.entries()].map(([file, list]) => ({ name: baseName(file), file, list })).sort(byName)
    for (const { name, file, list } of files) {
      rows.push({ kind: "file", key: file, name, depth, ids: list.map((e) => e.id) })
      if (expandAll || expanded.has(file)) {
        for (const e of [...list].sort((a, b) => a.line - b.line)) rows.push({ kind: "test", key: e.id, entry: e, depth: depth + 1 })
      }
    }
  }
  walk(build(entries), 0)
  return rows
}

/** Todas as chaves de pastas e arquivos (para "expandir tudo"). */
export function allGroupKeys(entries: TreeEntry[]): string[] {
  const keys = new Set<string>()
  for (const e of entries) {
    const parts = e.folder.split("/")
    for (let i = 2; i <= parts.length; i++) keys.add(parts.slice(0, i).join("/"))
    keys.add(e.file)
  }
  return [...keys]
}

/** Estado do checkbox de um grupo: todos, alguns ou nenhum selecionado. */
export function groupCheck(ids: string[], selected: ReadonlySet<string>): boolean | "indeterminate" {
  const n = ids.filter((id) => selected.has(id)).length
  return n === 0 ? false : n === ids.length ? true : "indeterminate"
}

/** Marca/desmarca todos os casos de um grupo (se todos estavam marcados, desmarca). */
export function toggleGroup(ids: string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected)
  const all = ids.every((id) => selected.has(id))
  for (const id of ids) {
    if (all) next.delete(id)
    else next.add(id)
  }
  return next
}
