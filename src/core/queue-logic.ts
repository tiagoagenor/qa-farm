import type {
  AttemptStatus,
  CatalogEntry,
  CreateQueueInput,
  Item,
  ItemStatus,
  Queue,
  QueueOptions,
  RunResult,
} from "./types"

export const MAX_INFRA_REQUEUES = 3

export const TERMINAL_ITEM_STATUSES: ReadonlySet<ItemStatus> = new Set([
  "passed",
  "failed",
  "timeout",
  "infra_error",
  "config_error",
  "canceled",
])

export const RERUNNABLE_STATUSES: ReadonlySet<ItemStatus> = new Set(["failed", "timeout", "infra_error"])

export function itemId(n: number): string {
  return `i${String(n).padStart(4, "0")}`
}

export function isSafeItemId(id: string): boolean {
  return /^i\d{4,5}$/.test(id)
}

/** Monta a fila a partir do pedido da UI e do catálogo. Ids desconhecidos vão para `missing`. */
export function buildQueue(
  id: string,
  input: CreateQueueInput,
  catalog: Map<string, CatalogEntry>,
  now: Date,
): { queue: Queue; missing: string[] } {
  const missing: string[] = []
  const seen = new Set<string>()
  const items: Item[] = []
  for (const testId of input.testIds) {
    if (seen.has(testId)) continue
    seen.add(testId)
    const e = catalog.get(testId)
    if (!e) {
      missing.push(testId)
      continue
    }
    items.push({
      id: itemId(items.length + 1),
      testId,
      name: e.name,
      fileLongName: e.fileLongName,
      file: e.file,
      accounts: e.accounts,
      status: "queued",
      infraRequeues: 0,
      failRetries: 0,
      attempts: [],
    })
  }
  const options: QueueOptions = { timeoutSec: input.timeoutSec, retries: input.retries }
  return {
    queue: {
      id,
      name: input.name,
      createdAt: now.toISOString(),
      appId: input.appId,
      env: input.env,
      status: "running",
      options,
      items,
    },
    missing,
  }
}

/** Status final do item depois de uma tentativa, aplicando re-enfileiramento de infra e retries. */
export function nextItemStatus(
  item: Item,
  result: AttemptStatus,
  retries: number,
): { status: ItemStatus; infraRequeues: number; failRetries: number } {
  const base = { infraRequeues: item.infraRequeues, failRetries: item.failRetries }
  switch (result) {
    case "infra_error":
      return item.infraRequeues < MAX_INFRA_REQUEUES
        ? { ...base, status: "queued", infraRequeues: item.infraRequeues + 1 }
        : { ...base, status: "infra_error" }
    case "failed":
    case "timeout":
      return item.failRetries < retries
        ? { ...base, status: "queued", failRetries: item.failRetries + 1 }
        : { ...base, status: result }
    case "running":
      return { ...base, status: "running" }
    default:
      return { ...base, status: result }
  }
}

/** Aplica o resultado de uma tentativa ao item (imutável). */
export function applyResult(queue: Queue, itemIdValue: string, n: number, res: RunResult, endedAt: Date): Queue {
  const items = queue.items.map((it) => {
    if (it.id !== itemIdValue) return it
    const attempts = it.attempts.map((a) =>
      a.n === n
        ? {
            ...a,
            status: res.status,
            endedAt: endedAt.toISOString(),
            message: res.message,
            teardownMessage: res.teardownMessage,
            screenshots: res.screenshots,
            pgid: undefined,
          }
        : a,
    )
    const next =
      queue.status === "canceled"
        ? { status: "canceled" as const, infraRequeues: it.infraRequeues, failRetries: it.failRetries }
        : nextItemStatus(it, res.status, queue.options.retries)
    return { ...it, ...next, attempts }
  })
  return finalizeIfDone({ ...queue, items }, endedAt)
}

export function isQueueFinished(queue: Queue): boolean {
  return queue.items.every((i) => TERMINAL_ITEM_STATUSES.has(i.status))
}

export function finalizeIfDone(queue: Queue, now: Date): Queue {
  if (queue.status === "done") return queue
  if (!isQueueFinished(queue)) return queue
  return {
    ...queue,
    status: queue.status === "canceled" ? "canceled" : "done",
    finishedAt: queue.finishedAt ?? now.toISOString(),
  }
}

/** Cancela: itens na fila viram `canceled`; os rodando continuam até o runner matá-los. */
export function cancelQueue(queue: Queue, now: Date): Queue {
  const items = queue.items.map((i) => (i.status === "queued" ? { ...i, status: "canceled" as const } : i))
  return finalizeIfDone({ ...queue, status: "canceled", items }, now)
}

export interface QueueSummary {
  total: number
  counts: Record<ItemStatus, number>
  finished: number
  progress: number // 0..1
  avgDurationSec: number | null
  minDurationSec: number | null
  maxDurationSec: number | null
  startedAt?: string
  lastEndedAt?: string
}

export function summarize(queue: Queue): QueueSummary {
  const counts = Object.fromEntries(
    ["queued", "running", "passed", "failed", "timeout", "infra_error", "config_error", "canceled"].map((s) => [
      s,
      0,
    ]),
  ) as Record<ItemStatus, number>
  const durations: number[] = []
  let startedAt: string | undefined
  let lastEndedAt: string | undefined
  for (const it of queue.items) {
    counts[it.status] += 1
    for (const a of it.attempts) {
      if (!startedAt || a.startedAt < startedAt) startedAt = a.startedAt
      if (a.endedAt) {
        if (!lastEndedAt || a.endedAt > lastEndedAt) lastEndedAt = a.endedAt
        if (a.status === "passed" || a.status === "failed") {
          durations.push((Date.parse(a.endedAt) - Date.parse(a.startedAt)) / 1000)
        }
      }
    }
  }
  const total = queue.items.length
  const finished = queue.items.filter((i) => TERMINAL_ITEM_STATUSES.has(i.status)).length
  return {
    total,
    counts,
    finished,
    progress: total === 0 ? 1 : finished / total,
    avgDurationSec: durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : null,
    minDurationSec: durations.length ? Math.min(...durations) : null,
    maxDurationSec: durations.length ? Math.max(...durations) : null,
    startedAt,
    lastEndedAt,
  }
}

/** Tempo total da fila: desde a criação até terminar (ou até `now`, se ainda está ativa). */
export function queueElapsedSec(queue: { createdAt: string; finishedAt?: string | null }, nowMs: number): number {
  const end = queue.finishedAt ? Date.parse(queue.finishedAt) : nowMs
  return Math.max(0, (end - Date.parse(queue.createdAt)) / 1000)
}

/**
 * Tempo mínimo teórico (s) para itens ainda não terminados: o maior entre
 * (itens ÷ celulares) e (maior carga de uma única conta), vezes a duração média.
 */
export function minTheoreticalSec(
  items: Pick<Item, "accounts" | "status">[],
  devices: number,
  avgSec: number,
): number {
  const pending = items.filter((i) => !TERMINAL_ITEM_STATUSES.has(i.status as ItemStatus))
  if (pending.length === 0 || devices <= 0) return 0
  const perAccount = new Map<string, number>()
  for (const it of pending) for (const a of it.accounts) perAccount.set(a, (perAccount.get(a) ?? 0) + 1)
  const maxAccount = Math.max(0, ...perAccount.values())
  const rounds = Math.max(Math.ceil(pending.length / devices), maxAccount)
  return rounds * avgSec
}

/** Status de caso que pode ser rodado de novo individualmente. */
export const RETRYABLE_ITEM_STATUSES: ReadonlySet<ItemStatus> = new Set(["failed", "timeout", "infra_error", "config_error"])

/**
 * Coloca um caso que falhou de volta na fila (mesma fila, nova tentativa; o histórico é mantido).
 * A fila volta a rodar. Retorna null se o caso não existe ou não está numa situação de falha.
 */
export function reopenItem(queue: Queue, itemIdValue: string): Queue | null {
  const it = queue.items.find((i) => i.id === itemIdValue)
  if (!it || !RETRYABLE_ITEM_STATUSES.has(it.status)) return null
  return {
    ...queue,
    status: "running",
    finishedAt: undefined,
    items: queue.items.map((i) => (i.id === itemIdValue ? { ...i, status: "queued", infraRequeues: 0, failRetries: 0 } : i)),
  }
}

/** Ids dos casos que devem entrar em "re-rodar falhas". */
export function failedTestIds(queue: Queue): string[] {
  return queue.items.filter((i) => RERUNNABLE_STATUSES.has(i.status)).map((i) => i.testId)
}
