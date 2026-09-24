import type { CatalogEntry } from "@/core/types"

export interface CatalogFilter {
  search: string
  folders: ReadonlySet<string>
  tags: ReadonlySet<string>
  onlySelected: boolean
}

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
}

/** Filtra o catálogo: busca (nome, arquivo, tags, contas; sem acento), pastas e tags (qualquer uma). */
export function filterEntries(entries: CatalogEntry[], f: CatalogFilter, selected: ReadonlySet<string>): CatalogEntry[] {
  const terms = norm(f.search).split(/\s+/).filter(Boolean)
  return entries.filter((e) => {
    if (f.onlySelected && !selected.has(e.id)) return false
    if (f.folders.size && ![...f.folders].some((d) => e.folder === d || e.folder.startsWith(`${d}/`))) return false
    if (f.tags.size && !e.tags.some((t) => f.tags.has(t))) return false
    if (terms.length) {
      const hay = norm(`${e.name} ${e.file} ${e.tags.join(" ")} ${e.accounts.join(" ")}`)
      if (!terms.every((t) => hay.includes(t))) return false
    }
    return true
  })
}

/** Pastas de primeiro e segundo nível (ex.: scenarios/pix, scenarios/pix/envio) com contagem de casos. */
export function folderOptions(entries: CatalogEntry[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>()
  for (const e of entries) {
    const parts = e.folder.split("/")
    for (let i = 2; i <= parts.length; i++) {
      const key = parts.slice(0, i).join("/")
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value))
}

export function tagOptions(entries: CatalogEntry[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>()
  for (const e of entries) for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** Seleção com shift: marca/desmarca o intervalo entre o último clique e o atual (na lista filtrada). */
export function toggleRange(
  selected: ReadonlySet<string>,
  visible: CatalogEntry[],
  fromIndex: number | null,
  toIndex: number,
  shift: boolean,
): Set<string> {
  const next = new Set(selected)
  const target = visible[toIndex]
  if (!target) return next
  const turnOn = !selected.has(target.id)
  const [a, b] = shift && fromIndex !== null ? [Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex)] : [toIndex, toIndex]
  for (let i = a; i <= b; i++) {
    const id = visible[i]?.id
    if (!id) continue
    if (turnOn) next.add(id)
    else next.delete(id)
  }
  return next
}
