import type { DeviceState, ItemStatus, QueueStatus } from "@/core/types"

export type Tone = "ok" | "fail" | "warn" | "info" | "muted" | "run"

export const ITEM_STATUS: Record<ItemStatus, { label: string; tone: Tone }> = {
  queued: { label: "Na fila", tone: "muted" },
  running: { label: "Rodando", tone: "run" },
  passed: { label: "Passou", tone: "ok" },
  failed: { label: "Falhou", tone: "fail" },
  timeout: { label: "Tempo esgotado", tone: "warn" },
  infra_error: { label: "Erro de infra", tone: "warn" },
  config_error: { label: "Erro de configuração", tone: "fail" },
  canceled: { label: "Cancelado", tone: "muted" },
}

export const QUEUE_STATUS: Record<QueueStatus, { label: string; tone: Tone }> = {
  running: { label: "Rodando", tone: "run" },
  paused: { label: "Pausada", tone: "warn" },
  canceled: { label: "Cancelada", tone: "muted" },
  done: { label: "Concluída", tone: "ok" },
}

export const DEVICE_STATE: Record<DeviceState, { label: string; tone: Tone }> = {
  offline: { label: "Desligado", tone: "muted" },
  booting: { label: "Iniciando", tone: "info" },
  installing: { label: "Preparando", tone: "info" },
  ready: { label: "Pronto", tone: "ok" },
  busy: { label: "Ocupado", tone: "run" },
  maintenance: { label: "Manutenção", tone: "warn" },
  external: { label: "Externo", tone: "muted" },
}

export const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  fail: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  info: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30",
  run: "bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/30",
  muted: "bg-muted text-muted-foreground border-border",
}

/** 75 → "1min 15s"; 3725 → "1h 2min". */
export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "—"
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}min ${s % 60}s` : `${m}min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}min` : `${h}h`
}

export function durationBetween(start?: string, end?: string, now: number = Date.now()): number | null {
  if (!start) return null
  const a = Date.parse(start)
  const b = end ? Date.parse(end) : now
  return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 1000 : null
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** URL de um arquivo de execução, com cada segmento codificado. */
export function runFileUrl(dir: string, file: string): string {
  return `/api/runs/${[...dir.split("/"), file].map(encodeURIComponent).join("/")}`
}
