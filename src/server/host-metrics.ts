import fsp from "node:fs/promises"
import path from "node:path"

import type { Config } from "@/core/config"
import type { HostSample } from "@/core/metrics"
import {
  type CpuStat,
  cpuUsage,
  type HwmonReading,
  parseCpuStat,
  parseHwmon,
  parseLoadavg,
  parseMeminfo,
  parseVmstatSwap,
} from "@/core/parsers/host-metrics"

import { readWorld } from "./fake-world"

/** Coletor da saúde da própria máquina (guarda a leitura anterior para os deltas de CPU e swap). */
export interface HostMetrics {
  sample(): Promise<HostSample>
}

const HWMON = "/sys/class/hwmon"

async function readHwmon(): Promise<HwmonReading[]> {
  const dirs = await fsp.readdir(HWMON).catch(() => [] as string[])
  const out: HwmonReading[] = []
  for (const d of dirs) {
    const base = path.join(HWMON, d)
    const name = (await fsp.readFile(path.join(base, "name"), "utf8").catch(() => "")).trim()
    if (!name) continue
    const files = await fsp.readdir(base).catch(() => [] as string[])
    const temps: HwmonReading["temps"] = []
    for (const f of files.filter((x) => /^temp\d+_input$/.test(x))) {
      const pre = f.replace(/_input$/, "")
      const num = async (suffix: string) => {
        const v = Number((await fsp.readFile(path.join(base, `${pre}_${suffix}`), "utf8").catch(() => "")).trim())
        return Number.isFinite(v) && v > 0 ? v : undefined
      }
      const input = await num("input")
      if (input === undefined) continue
      const label = (await fsp.readFile(path.join(base, `${pre}_label`), "utf8").catch(() => "")).trim() || undefined
      temps.push({ label, inputMilli: input, maxMilli: await num("max"), critMilli: await num("crit") })
    }
    out.push({ name, temps })
  }
  return out
}

export function realHostMetrics(): HostMetrics {
  let prevStat: CpuStat | null = null
  let prevSwap: { pswpin: number; pswpout: number; at: number } | null = null
  return {
    async sample() {
      const read = (f: string) => fsp.readFile(f, "utf8").catch(() => "")
      const [statTxt, memTxt, loadTxt, vmTxt, hw, fs] = await Promise.all([
        read("/proc/stat"),
        read("/proc/meminfo"),
        read("/proc/loadavg"),
        read("/proc/vmstat"),
        readHwmon(),
        fsp.statfs("/").catch(() => null),
      ])
      const now = Date.now()
      const stat = parseCpuStat(statTxt)
      const cpu = prevStat ? cpuUsage(prevStat, stat) : { cpuPct: 0, perCpuPct: stat.perCpu.map(() => 0), iowaitPct: 0 }
      prevStat = stat
      const swap = parseVmstatSwap(vmTxt)
      const secs = prevSwap ? Math.max(0.001, (now - prevSwap.at) / 1000) : 0
      const swapIn = prevSwap ? Math.max(0, (swap.pswpin - prevSwap.pswpin) / secs) : 0
      const swapOut = prevSwap ? Math.max(0, (swap.pswpout - prevSwap.pswpout) / secs) : 0
      prevSwap = { ...swap, at: now }
      return {
        at: new Date(now).toISOString(),
        ...parseMeminfo(memTxt),
        swapInPerSec: Math.round(swapIn),
        swapOutPerSec: Math.round(swapOut),
        ...cpu,
        threads: stat.perCpu.length,
        ...parseLoadavg(loadTxt),
        temp: parseHwmon(hw),
        diskRootFreeGb: fs ? Math.round((Number(fs.bavail) * Number(fs.bsize)) / 1024 ** 3) : 0,
      }
    },
  }
}

/** Fake: valores do "mundo" simulado (memAvailableMb, cpuPct, tempC, swapUsedPct). */
export function fakeHostMetrics(cfg: Config): HostMetrics {
  return {
    async sample() {
      const w = await readWorld(cfg.dataDir, cfg.fakeScenario)
      const total = 64_000
      const avail = w.memAvailableMb ?? 48_000
      const cpu = w.cpuPct ?? 20
      const swapTotal = 4096
      return {
        at: new Date().toISOString(),
        memTotalMb: total,
        memAvailableMb: avail,
        memUsedMb: Math.max(0, total - avail),
        buffersCacheMb: 4000,
        swapTotalMb: swapTotal,
        swapUsedMb: Math.round(((w.swapUsedPct ?? 0) / 100) * swapTotal),
        swapInPerSec: 0,
        swapOutPerSec: 0,
        cpuPct: cpu,
        perCpuPct: Array.from({ length: 8 }, () => cpu),
        iowaitPct: 0,
        threads: 8,
        load1: 2,
        load5: 2,
        load15: 2,
        temp: {
          source: "coretemp",
          packageC: w.tempC ?? 40,
          cores: Array.from({ length: 4 }, (_, i) => ({ label: `Core ${i}`, c: (w.tempC ?? 40) - 2 })),
          highC: 84,
          critC: 94,
          gpu: null,
        },
        diskRootFreeGb: 500,
      }
    },
  }
}
