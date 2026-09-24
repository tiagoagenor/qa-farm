import { spawn } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import type { Config } from "@/core/config"
import { portsFor } from "@/core/parsers/adb-devices"

import { isAlive, run } from "./exec"

export interface AppiumPool {
  url(index: number): string
  ensure(index: number, serial: string): Promise<void>
  isReady(index: number): Promise<boolean>
  stopAll(): Promise<void>
  /** Mata Appiums que sobraram de uma execução anterior do runner. */
  killStray(): Promise<void>
  openSessions(index: number): Promise<number>
}

export function realAppium(cfg: Config): AppiumPool {
  const procs = new Map<number, number>() // índice → pid
  const url = (i: number) => `http://127.0.0.1:${portsFor(i, cfg.appiumBasePort).appium}/wd/hub`
  const env = {
    ...process.env,
    PATH: `${path.dirname(cfg.appiumBin)}:${path.join(cfg.sdkRoot, "platform-tools")}:${path.join(cfg.javaHome, "bin")}:${process.env.PATH ?? ""}`,
    ANDROID_HOME: cfg.sdkRoot,
    ANDROID_SDK_ROOT: cfg.sdkRoot,
    JAVA_HOME: cfg.javaHome,
  }
  async function isReady(i: number) {
    try {
      const r = await fetch(`${url(i)}/status`, { signal: AbortSignal.timeout(3000) })
      const j = (await r.json()) as { value?: { ready?: boolean } }
      return j.value?.ready === true
    } catch {
      return false
    }
  }
  return {
    url,
    isReady,
    async ensure(i, serial) {
      const pid = procs.get(i)
      if (pid && isAlive(pid)) return
      const logFile = path.join(cfg.dataDir, "logs", `appium-${serial}.log`)
      await fsp.mkdir(path.dirname(logFile), { recursive: true })
      const out = fs.openSync(logFile, "a")
      const child = spawn(
        cfg.appiumBin,
        [
          "--address", "127.0.0.1",
          "--port", String(portsFor(i, cfg.appiumBasePort).appium),
          "--base-path", "/wd/hub",
          "--session-override",
          "--relaxed-security",
          "--log-no-colors",
          "--log-timestamp",
        ],
        { stdio: ["ignore", out, out], env, detached: true },
      )
      fs.closeSync(out)
      child.unref()
      if (child.pid) procs.set(i, child.pid)
    },
    async stopAll() {
      for (const pid of procs.values()) {
        try {
          process.kill(-pid, "SIGTERM")
        } catch {
          /* já morreu */
        }
      }
      procs.clear()
      await this.killStray()
    },
    async killStray() {
      const uid = String(process.getuid?.() ?? "")
      for (let i = 1; i <= cfg.maxDevices; i++) {
        const port = portsFor(i, cfg.appiumBasePort).appium
        await run("pkill", ["-u", uid, "-f", `appium --address 127\\.0\\.0\\.1 --port ${port} `])
      }
    },
    async openSessions(i) {
      try {
        const r = await fetch(`${url(i)}/appium/sessions`, { signal: AbortSignal.timeout(3000) })
        const j = (await r.json()) as { value?: unknown[] }
        return Array.isArray(j.value) ? j.value.length : 0
      } catch {
        return 0
      }
    },
  }
}

export function fakeAppium(cfg: Config): AppiumPool {
  const started = new Set<number>()
  return {
    url: (i) => `http://127.0.0.1:${portsFor(i, cfg.appiumBasePort).appium}/wd/hub`,
    async ensure(i) {
      started.add(i)
    },
    async isReady(i) {
      return started.has(i)
    },
    async stopAll() {
      started.clear()
    },
    async killStray() {},
    async openSessions() {
      return 0
    },
  }
}
