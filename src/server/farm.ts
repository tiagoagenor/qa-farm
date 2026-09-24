import { spawn } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import type { Config } from "@/core/config"
import { serialFromIndex } from "@/core/parsers/adb-devices"

import { isAlive, sleep } from "./exec"
import { readWorld, updateWorld } from "./fake-world"

export type FarmOp = { kind: "start"; count: number } | { kind: "startOne"; index: number } | { kind: "stopOne"; index: number } | { kind: "stopAll" }

export interface Farm {
  /** Executa uma operação e resolve quando termina (o runner faz uma por vez). */
  exec(op: FarmOp, logFile: string): Promise<{ ok: boolean; code: number | null }>
  /** PID do qemu de cada emulador ligado (índice → pid). */
  qemuPids(): Promise<Map<number, number>>
}

export function describeOp(op: FarmOp): string {
  switch (op.kind) {
    case "start":
      return `ligar ${op.count} celular(es)`
    case "startOne":
      return `ligar farm-${String(op.index).padStart(2, "0")}`
    case "stopOne":
      return `desligar farm-${String(op.index).padStart(2, "0")}`
    case "stopAll":
      return "desligar todos"
  }
}

export function realFarm(cfg: Config, timeoutMs = 20 * 60_000): Farm {
  const script = path.join(cfg.repoRoot, "scripts/farm/android-farm.sh")
  const down = path.join(cfg.repoRoot, "scripts/farm/android-farm-down.sh")
  // farm-ops.lock (não farm.lock): emuladores antigos, iniciados antes do "flock -o", ainda seguram o lock antigo
  const lock = path.join(cfg.farmHome, "run", "farm-ops.lock")
  return {
    async exec(op, logFile) {
      await fsp.mkdir(path.dirname(lock), { recursive: true })
      await fsp.mkdir(path.dirname(logFile), { recursive: true })
      const args =
        op.kind === "start"
          ? [script, "start", "-n", String(op.count)]
          : op.kind === "startOne"
            ? [script, "start", "--only", String(op.index)]
            : op.kind === "stopOne"
              ? [script, "stop", "--only", String(op.index)]
              : [down]
      const out = fs.openSync(logFile, "a")
      fs.writeSync(out, `\n=== ${new Date().toISOString()} ${describeOp(op)}\n`)
      // detached: grupo de processos próprio — reiniciar o runner (kill no grupo dele) não derruba os emuladores.
      // flock -o: o lock não é herdado pelo script — senão os emuladores (que vivem horas) seguram o lock
      // para sempre e toda operação seguinte da fazenda fica bloqueada (bug real).
      const child = spawn("flock", ["-o", lock, "bash", ...args], {
        stdio: ["ignore", out, out],
        env: { ...process.env, FARM_HOME: cfg.farmHome, ANDROID_SDK_ROOT: cfg.sdkRoot },
        detached: true,
      })
      fs.closeSync(out)
      return new Promise((resolve) => {
        // nenhuma operação pode travar a fazenda para sempre
        const timer = setTimeout(() => {
          fs.appendFileSync(logFile, `=== tempo máximo (${Math.round(timeoutMs / 60000)} min) excedido: ${describeOp(op)} interrompida\n`)
          try {
            process.kill(-(child.pid ?? 0), "SIGKILL")
          } catch {
            /* já terminou */
          }
        }, timeoutMs)
        child.on("exit", (code) => {
          clearTimeout(timer)
          resolve({ ok: code === 0, code })
        })
        child.on("error", () => {
          clearTimeout(timer)
          resolve({ ok: false, code: null })
        })
      })
    },
    async qemuPids() {
      const out = new Map<number, number>()
      const dir = path.join(cfg.farmHome, "run")
      let names: string[] = []
      try {
        names = await fsp.readdir(dir)
      } catch {
        return out
      }
      for (const n of names) {
        const m = /^farm-(\d+)\.pid$/.exec(n)
        if (!m) continue
        const pid = Number((await fsp.readFile(path.join(dir, n), "utf8").catch(() => "")).trim())
        if (isAlive(pid)) out.set(Number(m[1]), pid)
      }
      return out
    },
  }
}

export function fakeFarm(cfg: Config): Farm {
  const dir = cfg.dataDir
  let pidSeq = 300000
  const add = (w: Awaited<ReturnType<typeof readWorld>>, index: number) => {
    const serial = serialFromIndex(index)
    if (w.devices.some((d) => d.serial === serial)) return
    pidSeq += 1
    w.devices.push({ serial, kind: "emulator", adbState: "device", bootAt: Date.now() + w.bootDelayMs, pid: pidSeq, installed: {} })
  }
  return {
    async exec(op, logFile) {
      await fsp.mkdir(path.dirname(logFile), { recursive: true })
      await fsp.appendFile(logFile, `\n=== ${new Date().toISOString()} [fake] ${describeOp(op)}\n`)
      await sleep(200)
      await updateWorld(dir, (w) => {
        if (op.kind === "start") for (let i = 1; i <= op.count; i++) add(w, i)
        if (op.kind === "startOne") add(w, op.index)
        if (op.kind === "stopOne") w.devices = w.devices.filter((d) => d.serial !== serialFromIndex(op.index))
        if (op.kind === "stopAll") w.devices = w.devices.filter((d) => d.kind !== "emulator")
      })
      return { ok: true, code: 0 }
    },
    async qemuPids() {
      if (cfg.fakeIoDelayMs) await sleep(cfg.fakeIoDelayMs) // simula a leitura lenta dos pidfiles do servidor real
      const w = await readWorld(dir)
      const out = new Map<number, number>()
      for (const d of w.devices) {
        const m = /^emulator-(\d+)$/.exec(d.serial)
        if (m && d.pid) out.set((Number(m[1]) - 5554) / 2 + 1, d.pid)
      }
      return out
    },
  }
}
