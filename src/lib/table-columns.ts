/** Colunas de tabela com largura ajustável (arrastar) e visibilidade escolhida pelo usuário. */
export interface ColumnDef<K extends string = string> {
  key: K
  label: string
  /** largura padrão em px */
  width: number
  /** pode ser escondida no seletor de colunas (padrão: sim) */
  hideable?: boolean
  /** pode ter a largura ajustada (padrão: sim) */
  resizable?: boolean
  align?: "left" | "right" | "center"
}

export interface ColumnPrefs {
  hidden: string[]
  widths: Record<string, number>
}

export const MIN_COL_WIDTH = 40
export const MAX_COL_WIDTH = 1600

export function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return MIN_COL_WIDTH
  return Math.round(Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, w)))
}

/** Preferências salvas → só o que ainda vale para as colunas atuais (texto inválido ou antigo é ignorado). */
export function parseColumnPrefs(raw: string | null | undefined, defs: ColumnDef[]): ColumnPrefs {
  const keys = new Set(defs.map((d) => d.key))
  const hideable = new Set(defs.filter((d) => d.hideable !== false).map((d) => d.key))
  try {
    const p = JSON.parse(raw ?? "{}") as Partial<ColumnPrefs>
    const hidden = Array.isArray(p.hidden)
      ? p.hidden.filter((k): k is string => typeof k === "string" && hideable.has(k))
      : []
    const widths: Record<string, number> = {}
    for (const [k, v] of Object.entries(p.widths ?? {}))
      if (keys.has(k) && typeof v === "number") widths[k] = clampWidth(v)
    return { hidden, widths }
  } catch {
    return { hidden: [], widths: {} }
  }
}

/** Colunas que aparecem, com a largura final (preferência do usuário ou padrão). */
export function visibleColumns<K extends string>(
  defs: ColumnDef<K>[],
  prefs: ColumnPrefs,
): Array<ColumnDef<K> & { px: number }> {
  return defs
    .filter((d) => !prefs.hidden.includes(d.key))
    .map((d) => ({ ...d, px: prefs.widths[d.key] ?? d.width }))
}

export function toggleHidden(prefs: ColumnPrefs, key: string): ColumnPrefs {
  const hidden = prefs.hidden.includes(key) ? prefs.hidden.filter((k) => k !== key) : [...prefs.hidden, key]
  return { ...prefs, hidden }
}

export function setWidth(prefs: ColumnPrefs, key: string, width: number | null): ColumnPrefs {
  const widths = { ...prefs.widths }
  if (width === null) delete widths[key]
  else widths[key] = clampWidth(width)
  return { ...prefs, widths }
}
