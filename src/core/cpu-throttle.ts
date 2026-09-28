import type { HostSample } from "./metrics"

// Limite gradual de casos por CPU. CPU saturada não para a máquina inteira: corta o limite de casos ao mesmo
// tempo em `step` por vez e, com a CPU folgada, devolve 1 caso por vez. Temperatura e swap continuam no freio
// total (health.ts). Função pura: o estado anterior entra e o novo sai.

export interface ThrottleConfig {
  /** CPU a partir da qual a leitura conta como saturada */
  hotPct: number
  /** CPU abaixo da qual a leitura conta como folgada */
  coolPct: number
  /** quanto a CPU precisa ficar saturada para cortar */
  hotMs: number
  /** quanto a CPU precisa ficar folgada para devolver um caso */
  coolMs: number
  /** casos cortados de cada vez */
  step: number
  /** o limite nunca fica abaixo disto */
  min: number
  /** intervalo mínimo entre dois cortes (dar tempo de o corte fazer efeito) */
  cutEveryMs: number
  /** intervalo mínimo entre duas devoluções */
  growEveryMs: number
}

export const DEFAULT_THROTTLE: ThrottleConfig = {
  hotPct: 95,
  coolPct: 85,
  hotMs: 30_000,
  coolMs: 60_000,
  step: 2,
  min: 2,
  cutEveryMs: 60_000,
  growEveryMs: 60_000,
}

export interface ThrottleState {
  /** limite de casos ao mesmo tempo; null = sem limite por CPU */
  cap: number | null
  hotSince?: number
  coolSince?: number
  lastChange?: number
}

export interface ThrottleInput {
  sample: HostSample
  /** casos rodando agora nesta máquina */
  running: number
  /** celulares desta máquina: com o limite chegando aqui, ele sai */
  devices: number
  now: number
}

export interface ThrottleResult {
  state: ThrottleState
  /** mensagem para o log quando o limite mudou */
  change?: string
}

export function stepThrottle(prev: ThrottleState, i: ThrottleInput, c: ThrottleConfig = DEFAULT_THROTTLE): ThrottleResult {
  const cpu = Math.round(i.sample.cpuPct)
  const hot = i.sample.cpuPct >= c.hotPct
  const cool = i.sample.cpuPct < c.coolPct
  const s: ThrottleState = {
    cap: prev.cap,
    lastChange: prev.lastChange,
    hotSince: hot ? (prev.hotSince ?? i.now) : undefined,
    coolSince: cool ? (prev.coolSince ?? i.now) : undefined,
  }
  const since = (t?: number) => (t === undefined ? Infinity : i.now - t)

  if (hot && i.now - s.hotSince! >= c.hotMs && since(s.lastChange) >= c.cutEveryMs) {
    const base = s.cap ?? i.running
    const cap = Math.max(c.min, base - c.step)
    if (s.cap === null || cap < s.cap) {
      s.cap = cap
      s.lastChange = i.now
      return { state: s, change: `CPU em ${cpu}%: limite de ${cap} caso(s) ao mesmo tempo nesta máquina (antes ${base})` }
    }
  }

  if (s.cap !== null && cool && i.now - s.coolSince! >= c.coolMs && since(s.lastChange) >= c.growEveryMs) {
    const cap = s.cap + 1
    s.lastChange = i.now
    if (cap >= i.devices) {
      s.cap = null
      return { state: s, change: `CPU em ${cpu}%: limite por CPU removido` }
    }
    s.cap = cap
    return { state: s, change: `CPU em ${cpu}%: limite sobe para ${cap} caso(s) ao mesmo tempo` }
  }

  return { state: s }
}

/** Quantos casos novos cabem nesta máquina pelo limite de CPU. */
export function throttleRoom(state: ThrottleState, running: number): number {
  return state.cap === null ? Infinity : Math.max(0, state.cap - running)
}

/** Configuração a partir do ambiente (QAFARM_CPU_THROTTLE_*); valores ausentes ficam no padrão. */
export function throttleConfigFromEnv(env: Record<string, string | undefined>): ThrottleConfig {
  const out = { ...DEFAULT_THROTTLE }
  const map: Array<[keyof ThrottleConfig, string]> = [
    ["hotPct", "QAFARM_CPU_THROTTLE_HOT_PCT"],
    ["coolPct", "QAFARM_CPU_THROTTLE_COOL_PCT"],
    ["hotMs", "QAFARM_CPU_THROTTLE_HOT_MS"],
    ["coolMs", "QAFARM_CPU_THROTTLE_COOL_MS"],
    ["step", "QAFARM_CPU_THROTTLE_STEP"],
    ["min", "QAFARM_CPU_THROTTLE_MIN"],
    ["cutEveryMs", "QAFARM_CPU_THROTTLE_CUT_EVERY_MS"],
    ["growEveryMs", "QAFARM_CPU_THROTTLE_GROW_EVERY_MS"],
  ]
  for (const [k, e] of map) {
    const v = Number(env[e])
    if (env[e] !== undefined && env[e] !== "" && Number.isFinite(v)) out[k] = v
  }
  return out
}
