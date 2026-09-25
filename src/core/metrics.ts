import { z } from "zod"

/** Uma leitura da saúde da máquina (mesmo formato no mestre e no agente dos workers). */
export const HostSampleSchema = z.object({
  at: z.string(),
  memTotalMb: z.number(),
  memAvailableMb: z.number(),
  memUsedMb: z.number(),
  buffersCacheMb: z.number(),
  swapTotalMb: z.number(),
  swapUsedMb: z.number(),
  swapInPerSec: z.number(),
  swapOutPerSec: z.number(),
  cpuPct: z.number(),
  perCpuPct: z.array(z.number()),
  iowaitPct: z.number(),
  threads: z.number(),
  load1: z.number(),
  load5: z.number(),
  load15: z.number(),
  temp: z.object({
    source: z.enum(["coretemp"]).nullable(),
    packageC: z.number().nullable(),
    cores: z.array(z.object({ label: z.string(), c: z.number() })),
    highC: z.number().nullable(),
    critC: z.number().nullable(),
    gpu: z.object({ name: z.string(), c: z.number() }).nullable(),
  }),
  diskRootFreeGb: z.number(),
  emulatorsRunning: z.number().optional(),
})
export type HostSample = z.infer<typeof HostSampleSchema>

/** Ponto do histórico (10 s): média de CPU/carga, mínimo de memória livre, máximo de temperatura e de swap. */
export const HistoryPointSchema = z.object({
  at: z.string(),
  cpuPct: z.number(),
  memAvailableMb: z.number(),
  tempC: z.number().nullable(),
  swapUsedMb: z.number(),
  load1: z.number(),
})
export type HistoryPoint = z.infer<typeof HistoryPointSchema>

export const HISTORY_POINT_MS = 10_000
export const HISTORY_MAX_POINTS = 180 // 30 min

/** Agrupa amostras num ponto do histórico. */
export function aggregate(samples: HostSample[]): HistoryPoint {
  const avg = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)) * 10) / 10
  const temps = samples.map((s) => s.temp.packageC).filter((t): t is number => t !== null)
  return {
    at: samples[samples.length - 1].at,
    cpuPct: avg(samples.map((s) => s.cpuPct)),
    memAvailableMb: Math.min(...samples.map((s) => s.memAvailableMb)),
    tempC: temps.length ? Math.max(...temps) : null,
    swapUsedMb: Math.max(...samples.map((s) => s.swapUsedMb)),
    load1: avg(samples.map((s) => s.load1)),
  }
}

/** Histórico curto em memória: amostras viram pontos de 10 s; guarda os últimos 30 min. */
export class MetricsHistory {
  private pending: HostSample[] = []
  private points: HistoryPoint[] = []

  constructor(initial: HistoryPoint[] = [], now = Date.now()) {
    this.points = initial.filter((p) => now - Date.parse(p.at) <= HISTORY_MAX_POINTS * HISTORY_POINT_MS).slice(-HISTORY_MAX_POINTS)
  }

  add(sample: HostSample): void {
    this.pending.push(sample)
    const first = Date.parse(this.pending[0].at)
    if (Date.parse(sample.at) - first >= HISTORY_POINT_MS - 1000 || this.pending.length >= 5) {
      this.points.push(aggregate(this.pending))
      this.pending = []
      if (this.points.length > HISTORY_MAX_POINTS) this.points.splice(0, this.points.length - HISTORY_MAX_POINTS)
    }
  }

  list(): HistoryPoint[] {
    return [...this.points]
  }
}

export const MachineHealthSchema = z.object({
  level: z.enum(["ok", "warn", "crit"]),
  alerts: z.array(z.object({ id: z.string(), level: z.enum(["warn", "crit"]), message: z.string() })),
  brake: z.boolean(),
  blockStart: z.boolean(),
})

/** state/metrics.json — gravado só pelo runner; a web só lê. */
export const MetricsFileSchema = z.object({
  updatedAt: z.string(),
  machines: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: z.enum(["master", "worker"]),
      sample: HostSampleSchema.nullable(),
      history: z.array(HistoryPointSchema),
      health: MachineHealthSchema,
      /** estado da conexão (só workers) */
      state: z.string().optional(),
    }),
  ),
})
export type MetricsFile = z.infer<typeof MetricsFileSchema>
