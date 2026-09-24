import type { Queue } from "./types"

interface Interval {
  key: string // conta ou serial
  itemId: string
  n: number
  start: number
  end: number
}

function intervals(queues: Queue[], keyOf: (accounts: string[], serial: string) => string[]): Interval[] {
  const out: Interval[] = []
  for (const q of queues) {
    for (const it of q.items) {
      for (const a of it.attempts) {
        const start = Date.parse(a.startedAt)
        const end = a.endedAt ? Date.parse(a.endedAt) : Date.now()
        for (const key of keyOf(it.accounts, a.serial)) out.push({ key, itemId: `${q.id}/${it.id}`, n: a.n, start, end })
      }
    }
  }
  return out
}

function overlapsBy(list: Interval[]): Array<{ key: string; a: string; b: string }> {
  const byKey = new Map<string, Interval[]>()
  for (const iv of list) byKey.set(iv.key, [...(byKey.get(iv.key) ?? []), iv])
  const found: Array<{ key: string; a: string; b: string }> = []
  for (const [key, ivs] of byKey) {
    ivs.sort((x, y) => x.start - y.start)
    for (let i = 1; i < ivs.length; i++) {
      if (ivs[i].start < ivs[i - 1].end) {
        found.push({ key, a: `${ivs[i - 1].itemId}#${ivs[i - 1].n}`, b: `${ivs[i].itemId}#${ivs[i].n}` })
      }
    }
  }
  return found
}

/** Tentativas com a mesma conta de teste que se sobrepuseram no tempo (deve ser vazio). */
export function accountOverlaps(queues: Queue[]) {
  return overlapsBy(intervals(queues, (accounts) => accounts))
}

/** Tentativas no mesmo celular que se sobrepuseram (deve ser vazio). */
export function deviceOverlaps(queues: Queue[]) {
  return overlapsBy(intervals(queues, (_, serial) => [serial]))
}

/** Maior número de tentativas rodando ao mesmo tempo. */
export function peakConcurrency(queues: Queue[]): number {
  const events: Array<[number, number]> = []
  for (const iv of intervals(queues, () => ["*"])) {
    events.push([iv.start, 1], [iv.end, -1])
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let cur = 0
  let peak = 0
  for (const [, d] of events) {
    cur += d
    peak = Math.max(peak, cur)
  }
  return peak
}
