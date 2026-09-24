import { type MassaEntry, MassaEntrySchema } from "./types"

/** Conteúdo de massa.json → entradas válidas (arquivo ausente, quebrado ou pela metade → []). */
export function parseMassa(text: string | undefined | null): MassaEntry[] {
  if (!text) return []
  try {
    const raw = JSON.parse(text) as { entries?: unknown }
    if (!Array.isArray(raw.entries)) return []
    return raw.entries.flatMap((e) => {
      const r = MassaEntrySchema.safeParse(e)
      return r.success ? [r.data] : []
    })
  } catch {
    return []
  }
}

const SECRET = /senha|password|pass|token|pin/i

export function isSecretField(name: string): boolean {
  return SECRET.test(name)
}

const LOGIN = /^(username|login|usuario|email|cpf)$/i

/** Resumo curto para a tabela: "usuario_ana · ana@teste.com" (várias contas separadas por vírgula). */
export function massaLabel(entries: MassaEntry[] | undefined): string | null {
  const contas = (entries ?? []).filter((e) => e.kind === "conta")
  if (contas.length === 0) return null
  return contas
    .map((c) => {
      const login = Object.entries(c.fields).find(([k]) => LOGIN.test(k))?.[1]
      return login ? `${c.account} · ${login}` : c.account
    })
    .join(", ")
}
