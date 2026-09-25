import { z } from "zod"

// BrowserStack como mais uma fonte de celulares: "vagas" (slots) com modelo/versão escolhidos no painel,
// limitadas pelas sessões paralelas da conta (compartilhadas com o time). Funções puras + schemas.

export const BS_MACHINE_ID = "browserstack"
/** índice global das vagas: 9900 + n (fora das faixas do mestre 1..99 e dos workers 100·slot) */
export const BS_INDEX_BASE = 9900

export const BsSlotSchema = z.object({
  id: z.number().int().min(1).max(50),
  device: z.string().min(1).max(80),
  osVersion: z.string().min(1).max(20),
  enabled: z.boolean(),
})
export type BsSlot = z.infer<typeof BsSlotSchema>

/** state/browserstack.json — gravado só pelo runner. */
export const BsStateSchema = z.object({
  enabled: z.boolean().default(false),
  slots: z.array(BsSlotSchema).default([]),
})
export type BsState = z.infer<typeof BsStateSchema>

export const BsPlanSchema = z.object({
  automate_plan: z.string().optional(),
  parallel_sessions_running: z.number(),
  parallel_sessions_max_allowed: z.number(),
  team_parallel_sessions_max_allowed: z.number().optional(),
  queued_sessions: z.number().optional(),
  queued_sessions_max_allowed: z.number().optional(),
})
export type BsPlan = z.infer<typeof BsPlanSchema>

export const BsDeviceSchema = z.object({ device: z.string(), os: z.string(), os_version: z.string(), realMobile: z.boolean().optional() })
export type BsDevice = z.infer<typeof BsDeviceSchema>

/** Cache de APKs enviados (md5 → app_url bs://…), para enviar uma vez por versão. */
export const BsAppsSchema = z.object({ apps: z.record(z.string(), z.object({ appUrl: z.string(), uploadedAt: z.string() })) })
export const BS_APP_MAX_AGE_MS = 25 * 24 * 3600 * 1000 // o BrowserStack apaga depois de 30 dias

export function slotKey(id: number): string {
  return `${BS_MACHINE_ID}:${id}`
}
export function slotIndex(id: number): number {
  return BS_INDEX_BASE + id
}
export function slotIdFromKey(key: string): number | null {
  const m = /^browserstack:(\d+)$/.exec(key)
  return m ? Number(m[1]) : null
}
export function isBsIndex(index: number): boolean {
  return index > BS_INDEX_BASE && index < BS_INDEX_BASE + 100
}

/**
 * Quantos casos novos cabem agora no BrowserStack: vagas ativadas livres, limitadas pelas sessões paralelas
 * que sobram na conta (o time também usa: running inclui as nossas + as dos outros).
 */
export function bsBudget(opts: { freeSlots: number; ourRunning: number; plan: BsPlan | null; reserve?: number }): number {
  if (!opts.plan) return 0
  const others = Math.max(0, opts.plan.parallel_sessions_running - opts.ourRunning)
  const room = opts.plan.parallel_sessions_max_allowed - (opts.reserve ?? 0) - others - opts.ourRunning
  return Math.max(0, Math.min(opts.freeSlots, room))
}

export function nextSlotId(slots: BsSlot[]): number {
  let i = 1
  const used = new Set(slots.map((s) => s.id))
  while (used.has(i)) i++
  return i
}

/** Remove credenciais de URLs/capabilities antes de gravar em arquivo ou log. */
export function redactSecrets<T>(value: T, secrets: string[]): T {
  const list = secrets.filter((s) => s && s.length >= 4)
  if (!list.length) return value
  let text = JSON.stringify(value)
  for (const s of list) text = text.split(s).join("***")
  return JSON.parse(text) as T
}
