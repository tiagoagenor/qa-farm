// Leitura das métricas da máquina a partir de /proc e /sys/class/hwmon (funções puras; sem sudo, sem pacotes).

export interface CpuTimes {
  /** tempo ocioso (idle + iowait) */
  idle: number
  iowait: number
  total: number
}

export interface CpuStat {
  total: CpuTimes
  /** uma posição por thread lógica (cpu0, cpu1, ...) */
  perCpu: CpuTimes[]
}

function times(fields: number[]): CpuTimes {
  // user nice system idle iowait irq softirq steal guest guest_nice — guest já está contado em user
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields
  return { idle: idle + iowait, iowait, total: user + nice + system + idle + iowait + irq + softirq + steal }
}

/** `/proc/stat` → tempos acumulados da CPU total e de cada thread. */
export function parseCpuStat(text: string): CpuStat {
  let total: CpuTimes = { idle: 0, iowait: 0, total: 0 }
  const perCpu: CpuTimes[] = []
  for (const line of text.split("\n")) {
    const m = /^cpu(\d*)\s+(.*)$/.exec(line.trim())
    if (!m) continue
    const t = times(m[2].split(/\s+/).map(Number))
    if (m[1] === "") total = t
    else perCpu[Number(m[1])] = t
  }
  return { total, perCpu: perCpu.filter(Boolean) }
}

const pct = (prev: CpuTimes, cur: CpuTimes) => {
  const dt = cur.total - prev.total
  if (dt <= 0) return 0
  return Math.min(100, Math.max(0, ((dt - (cur.idle - prev.idle)) / dt) * 100))
}

/** Uso da CPU entre duas leituras de `/proc/stat` (0–100). */
export function cpuUsage(prev: CpuStat, cur: CpuStat): { cpuPct: number; perCpuPct: number[]; iowaitPct: number } {
  const dt = cur.total.total - prev.total.total
  return {
    cpuPct: round1(pct(prev.total, cur.total)),
    perCpuPct: cur.perCpu.map((c, i) => round1(prev.perCpu[i] ? pct(prev.perCpu[i], c) : 0)),
    iowaitPct: round1(dt > 0 ? ((cur.total.iowait - prev.total.iowait) / dt) * 100 : 0),
  }
}

export interface MemInfo {
  memTotalMb: number
  memAvailableMb: number
  memUsedMb: number
  buffersCacheMb: number
  swapTotalMb: number
  swapUsedMb: number
}

/** `/proc/meminfo` → memória em MB (usada = total − disponível). */
export function parseMeminfo(text: string): MemInfo {
  const kb: Record<string, number> = {}
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line)
    if (m) kb[m[1]] = Number(m[2])
  }
  const mb = (k: string) => Math.round((kb[k] ?? 0) / 1024)
  const total = mb("MemTotal")
  const available = mb("MemAvailable")
  return {
    memTotalMb: total,
    memAvailableMb: available,
    memUsedMb: Math.max(0, total - available),
    buffersCacheMb: mb("Buffers") + mb("Cached"),
    swapTotalMb: mb("SwapTotal"),
    swapUsedMb: Math.max(0, mb("SwapTotal") - mb("SwapFree")),
  }
}

/** `/proc/loadavg` → médias de carga. */
export function parseLoadavg(text: string): { load1: number; load5: number; load15: number } {
  const [a = "0", b = "0", c = "0"] = text.trim().split(/\s+/)
  return { load1: Number(a), load5: Number(b), load15: Number(c) }
}

/** `/proc/vmstat` → páginas trocadas com o swap (acumulado). */
export function parseVmstatSwap(text: string): { pswpin: number; pswpout: number } {
  const get = (k: string) => Number(new RegExp(`^${k}\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0)
  return { pswpin: get("pswpin"), pswpout: get("pswpout") }
}

export interface HwmonReading {
  name: string
  temps: Array<{ label?: string; inputMilli: number; maxMilli?: number; critMilli?: number }>
}

export interface TempInfo {
  source: "coretemp" | null
  /** maior "Package id N" (máquina com 2 sockets tem vários) */
  packageC: number | null
  cores: Array<{ label: string; c: number }>
  highC: number | null
  critC: number | null
  gpu: { name: string; c: number } | null
}

const toC = (milli: number) => Math.round(milli / 100) / 10

/** Sensores do hwmon → temperatura do processador (coretemp) e, à parte, da GPU. */
export function parseHwmon(readings: HwmonReading[]): TempInfo {
  const core = readings.find((r) => r.name === "coretemp")
  const gpuR = readings.find((r) => ["nouveau", "amdgpu", "radeon", "nvidia"].includes(r.name) && r.temps.length > 0)
  const gpu = gpuR ? { name: gpuR.name, c: toC(gpuR.temps[0].inputMilli) } : null
  if (!core || core.temps.length === 0) return { source: null, packageC: null, cores: [], highC: null, critC: null, gpu }
  const packages = core.temps.filter((t) => /^Package id/i.test(t.label ?? ""))
  const cores = core.temps
    .filter((t) => /^Core /i.test(t.label ?? ""))
    .map((t) => ({ label: t.label!, c: toC(t.inputMilli) }))
    .sort((a, b) => Number(a.label.replace(/\D/g, "")) - Number(b.label.replace(/\D/g, "")))
  const ref = packages[0] ?? core.temps[0]
  return {
    source: "coretemp",
    packageC: packages.length ? Math.max(...packages.map((p) => toC(p.inputMilli))) : Math.max(...core.temps.map((t) => toC(t.inputMilli))),
    cores,
    highC: ref.maxMilli ? toC(ref.maxMilli) : null,
    critC: ref.critMilli ? toC(ref.critMilli) : null,
    gpu,
  }
}

function round1(n: number) {
  return Math.round(n * 10) / 10
}
