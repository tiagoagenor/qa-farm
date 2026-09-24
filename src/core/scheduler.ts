import type { Item, Queue } from "./types"

export interface FreeDevice {
  serial: string
  index: number
}

export interface RunningItem {
  queueId: string
  itemId: string
  serial: string
  accounts: string[]
}

export interface Assignment {
  queueId: string
  itemId: string
  serial: string
}

/** Quantos itens pendentes (na fila ou rodando) usam cada conta, dentro de uma fila. */
function pendingByAccount(items: Item[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const it of items) {
    if (it.status !== "queued" && it.status !== "running") continue
    for (const acc of it.accounts) counts.set(acc, (counts.get(acc) ?? 0) + 1)
  }
  return counts
}

/**
 * Decide quais itens rodam agora e em qual celular. Função pura.
 *
 * Regras:
 * - só filas `running`, da mais antiga para a mais nova;
 * - dentro da fila, primeiro o item cuja conta tem mais trabalho pendente (encurta o caminho crítico);
 *   itens sem conta preenchem as sobras; empates mantêm a ordem original;
 * - nunca dois itens com conta em comum ao mesmo tempo (considerando os que já estão rodando),
 *   exceto em fila com `allowSameAccount`: lá os casos saem em sequência, na ordem da fila, para qualquer
 *   celular livre (cada caso faz o próprio login) — nenhum celular fica parado;
 * - nova tentativa prefere um celular onde o item ainda não rodou.
 */
export function schedule(queues: Queue[], freeDevices: FreeDevice[], running: RunningItem[]): Assignment[] {
  const locked = new Set(running.flatMap((r) => r.accounts))
  const free = [...freeDevices]
  const out: Assignment[] = []

  const ordered = queues
    .filter((q) => q.status === "running")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))

  for (const q of ordered) {
    if (free.length === 0) break
    const shared = q.options.allowSameAccount === true
    const pending = pendingByAccount(q.items)
    const candidates = q.items
      .map((it, pos) => ({ it, pos, weight: shared ? 0 : Math.max(0, ...it.accounts.map((a) => pending.get(a) ?? 0)) }))
      .filter(({ it }) => it.status === "queued")
      .sort((a, b) => b.weight - a.weight || a.pos - b.pos)

    for (const { it } of candidates) {
      if (free.length === 0) break
      if (!shared && it.accounts.some((a) => locked.has(a))) continue

      const used = new Set(it.attempts.map((a) => a.serial))
      const idx = Math.max(
        0,
        free.findIndex((d) => !used.has(d.serial)),
      )
      const [dev] = free.splice(idx, 1)
      for (const a of it.accounts) locked.add(a)
      out.push({ queueId: q.id, itemId: it.id, serial: dev.serial })
    }
  }
  return out
}
