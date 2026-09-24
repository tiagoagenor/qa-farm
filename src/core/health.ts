import type { HostSample } from "./metrics"

// Saúde da máquina a partir das leituras: alertas com histerese (tempo para entrar e para sair) e o "freio"
// que segura casos NOVOS naquela máquina. Função pura: o estado anterior entra e o novo sai.

export type HealthLevel = "ok" | "warn" | "crit"

export interface HealthConfig {
  tempWarnC: number
  tempCritC: number
  tempClearC: number
  coreWarnC: number
  coreCritC: number
  coreClearC: number
  memWarnMb: number
  memCritMb: number
  swapWarnPct: number
  swapCritPct: number
  swapClearPct: number
  swapInWarn: number
  swapInCrit: number
  swapInClear: number
  cpuWarnPct: number
  cpuCritPct: number
  cpuClearPct: number
  diskWarnGb: number
  diskCritGb: number
  /** quanto tempo a leitura precisa ficar boa para sair de um alerta de temperatura/CPU/swap ativo */
  clearHoldMs: number
}

export const DEFAULT_HEALTH: HealthConfig = {
  tempWarnC: 80,
  tempCritC: 85,
  tempClearC: 78,
  coreWarnC: 85,
  coreCritC: 90,
  coreClearC: 80,
  memWarnMb: 3000,
  memCritMb: 1500,
  swapWarnPct: 50,
  swapCritPct: 90,
  swapClearPct: 80,
  swapInWarn: 100,
  swapInCrit: 1000,
  swapInClear: 50,
  cpuWarnPct: 90,
  cpuCritPct: 98,
  cpuClearPct: 85,
  diskWarnGb: 15,
  diskCritGb: 5,
  clearHoldMs: 60_000,
}

export type AlertId = "temp" | "coreTemp" | "mem" | "swap" | "swapActive" | "cpu" | "disk"

export interface Alert {
  id: AlertId
  level: Exclude<HealthLevel, "ok">
  message: string
}

/** Estado de cada regra entre avaliações (para a histerese). */
export interface RuleState {
  level: HealthLevel
  /** desde quando a condição de subir para `target` vale */
  upSince?: number
  upTarget?: HealthLevel
  /** desde quando a condição de sair do nível atual vale */
  clearSince?: number
}
export type HealthState = Partial<Record<AlertId, RuleState>>

export interface HealthResult {
  level: HealthLevel
  alerts: Alert[]
  /** segura casos novos (temperatura, swap, CPU). Memória tem freio próprio no runner; disco só bloqueia ligar emuladores */
  brake: boolean
  /** disco quase cheio: não ligar novos emuladores */
  blockStart: boolean
  state: HealthState
}

interface Rule {
  id: AlertId
  /** nível "bruto" pela leitura atual (sem histerese) */
  raw: (s: HostSample, c: HealthConfig) => HealthLevel
  /** tempo que o nível bruto precisa durar para subir */
  upMs: (to: HealthLevel) => number
  /** condição para sair do nível atual e quanto tempo ela precisa durar */
  clear: (s: HostSample, c: HealthConfig) => boolean
  /** "hold" = clearHoldMs da configuração */
  clearMs: number | "hold"
  message: (s: HostSample, level: HealthLevel, c: HealthConfig) => string
  brakes: boolean
}

const RANK: Record<HealthLevel, number> = { ok: 0, warn: 1, crit: 2 }
const critTemp = (s: HostSample, c: HealthConfig) => Math.min(c.tempCritC, s.temp.critC !== null ? s.temp.critC - 5 : Infinity)
const hottestCore = (s: HostSample) => (s.temp.cores.length ? Math.max(...s.temp.cores.map((x) => x.c)) : null)
const swapPct = (s: HostSample) => (s.swapTotalMb > 0 ? (s.swapUsedMb / s.swapTotalMb) * 100 : 0)

const RULES: Rule[] = [
  {
    id: "temp",
    raw: (s, c) => (s.temp.packageC === null ? "ok" : s.temp.packageC >= critTemp(s, c) ? "crit" : s.temp.packageC >= c.tempWarnC ? "warn" : "ok"),
    upMs: () => 0,
    clear: (s, c) => s.temp.packageC === null || s.temp.packageC < c.tempClearC,
    clearMs: "hold",
    message: (s) => `Processador a ${s.temp.packageC} °C`,
    brakes: true,
  },
  {
    id: "coreTemp",
    raw: (s, c) => {
      const t = hottestCore(s)
      return t === null ? "ok" : t >= c.coreCritC ? "crit" : t >= c.coreWarnC ? "warn" : "ok"
    },
    upMs: () => 0,
    clear: (s, c) => (hottestCore(s) ?? 0) < c.coreClearC,
    clearMs: "hold",
    message: (s) => `Núcleo mais quente a ${hottestCore(s)} °C`,
    brakes: true,
  },
  {
    id: "mem",
    raw: (s, c) => (s.memAvailableMb < c.memCritMb ? "crit" : s.memAvailableMb < c.memWarnMb ? "warn" : "ok"),
    upMs: () => 0,
    clear: (s, c) => s.memAvailableMb >= c.memWarnMb + 500,
    clearMs: 0,
    message: (s) => `${(s.memAvailableMb / 1024).toFixed(1)} GB de memória disponível`,
    brakes: false, // o runner já freia por memória (com desconto por caso iniciado)
  },
  {
    id: "swap",
    raw: (s, c) => (swapPct(s) > c.swapCritPct ? "crit" : swapPct(s) > c.swapWarnPct ? "warn" : "ok"),
    upMs: () => 0,
    clear: (s, c) => swapPct(s) < c.swapClearPct,
    clearMs: 0,
    message: (s) => `Swap ${Math.round(swapPct(s))}% ocupado`,
    brakes: true,
  },
  {
    id: "swapActive",
    raw: (s, c) => (s.swapInPerSec > c.swapInCrit ? "crit" : s.swapInPerSec > c.swapInWarn ? "warn" : "ok"),
    upMs: () => 30_000,
    clear: (s, c) => s.swapInPerSec < c.swapInClear,
    clearMs: "hold",
    message: (s) => `Trocando com o swap: ${Math.round(s.swapInPerSec)} páginas/s`,
    brakes: true,
  },
  {
    id: "cpu",
    raw: (s, c) => (s.cpuPct >= c.cpuCritPct || (s.threads > 0 && s.load5 > 1.5 * s.threads) ? "crit" : s.cpuPct >= c.cpuWarnPct ? "warn" : "ok"),
    upMs: (to) => (to === "crit" ? 120_000 : 60_000),
    clear: (s, c) => s.cpuPct < c.cpuClearPct && !(s.threads > 0 && s.load5 > 1.5 * s.threads),
    clearMs: "hold",
    message: (s) => `CPU em ${Math.round(s.cpuPct)}% (load ${s.load5})`,
    brakes: true,
  },
  {
    id: "disk",
    raw: (s, c) => (s.diskRootFreeGb < c.diskCritGb ? "crit" : s.diskRootFreeGb < c.diskWarnGb ? "warn" : "ok"),
    upMs: () => 0,
    clear: (s, c) => s.diskRootFreeGb >= c.diskWarnGb + 2,
    clearMs: 0,
    message: (s) => `${Math.round(s.diskRootFreeGb)} GB livres no disco`,
    brakes: false,
  },
]

function step(rule: Rule, prev: RuleState | undefined, s: HostSample, c: HealthConfig, now: number): RuleState {
  const cur: RuleState = { level: prev?.level ?? "ok", upSince: prev?.upSince, upTarget: prev?.upTarget, clearSince: prev?.clearSince }
  const raw = rule.raw(s, c)

  // subir: o nível bruto acima do atual precisa durar upMs
  if (RANK[raw] > RANK[cur.level]) {
    if (cur.upTarget !== raw) {
      cur.upTarget = raw
      cur.upSince = now
    }
    if (now - (cur.upSince ?? now) >= rule.upMs(raw)) {
      return { level: raw }
    }
  } else {
    cur.upTarget = undefined
    cur.upSince = undefined
  }

  // descer: a condição de saída precisa durar clearMs; desce para o nível bruto atual
  if (cur.level !== "ok" && RANK[raw] < RANK[cur.level]) {
    if (rule.clear(s, c)) {
      cur.clearSince ??= now
      const hold = rule.clearMs === "hold" ? c.clearHoldMs : rule.clearMs
      if (now - cur.clearSince >= hold) return { level: raw }
    } else cur.clearSince = undefined
  } else cur.clearSince = undefined
  return cur
}

/** Avalia a leitura com o estado anterior (histerese). `now` em ms. */
export function evaluateHealth(sample: HostSample, prev: HealthState, now: number, cfg: HealthConfig = DEFAULT_HEALTH): HealthResult {
  const state: HealthState = {}
  const alerts: Alert[] = []
  for (const rule of RULES) {
    const st = step(rule, prev[rule.id], sample, cfg, now)
    state[rule.id] = st
    if (st.level !== "ok") alerts.push({ id: rule.id, level: st.level, message: rule.message(sample, st.level, cfg) })
  }
  const level: HealthLevel = alerts.some((a) => a.level === "crit") ? "crit" : alerts.length ? "warn" : "ok"
  const brake = alerts.some((a) => a.level === "crit" && RULES.find((r) => r.id === a.id)!.brakes)
  const blockStart = alerts.some((a) => a.id === "disk" && a.level === "crit")
  return { level, alerts, brake, blockStart, state }
}

/** Configuração a partir do ambiente (QAFARM_HEALTH_TEMP_CRIT_C etc.); valores ausentes ficam no padrão. */
export function healthConfigFromEnv(env: Record<string, string | undefined>): HealthConfig {
  const out = { ...DEFAULT_HEALTH }
  const map: Array<[keyof HealthConfig, string]> = [
    ["tempWarnC", "QAFARM_HEALTH_TEMP_WARN_C"],
    ["tempCritC", "QAFARM_HEALTH_TEMP_CRIT_C"],
    ["tempClearC", "QAFARM_HEALTH_TEMP_CLEAR_C"],
    ["cpuCritPct", "QAFARM_HEALTH_CPU_CRIT_PCT"],
    ["swapCritPct", "QAFARM_HEALTH_SWAP_CRIT_PCT"],
    ["clearHoldMs", "QAFARM_HEALTH_CLEAR_HOLD_MS"],
  ]
  for (const [k, e] of map) {
    const v = Number(env[e])
    if (env[e] !== undefined && env[e] !== "" && Number.isFinite(v)) out[k] = v
  }
  return out
}
