import { spawn } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import type { Config } from "@/core/config"
import { appiumGroup } from "@/core/parsers/adb-devices"

import { isAlive, run, sleep } from "./exec"

/**
 * Servidores Appium compartilhados por grupo de celulares (padrão: 5 por servidor).
 * Um Appium por celular custava ~210 MB × 15 — no limite da RAM do server01.
 * Sem --session-override (derrubaria as sessões dos vizinhos): as sessões de um celular são
 * apagadas explicitamente ao fim de cada tentativa (cleanupSessions).
 */
export interface AppiumPool {
  url(index: number): string
  ensure(index: number): Promise<void>
  isReady(index: number): Promise<boolean>
  /** Apaga as sessões abertas para o celular (sessão órfã de caso morto por timeout/cancelamento). */
  cleanupSessions(index: number, serial: string): Promise<number>
  stopAll(): Promise<void>
  /** Mata Appiums que sobraram de uma execução anterior do runner. */
  killStray(): Promise<void>
  openSessions(index: number): Promise<number>
}

interface SessionInfo {
  id: string
  capabilities?: Record<string, unknown>
}

export function realAppium(cfg: Config): AppiumPool {
  const procs = new Map<number, number>() // grupo → pid
  const starting = new Map<number, Promise<void>>() // grupo → subida em andamento
  const group = (i: number) => appiumGroup(i, cfg.devicesPerAppium)
  const port = (i: number) => cfg.appiumBasePort + group(i)
  const url = (i: number) => `http://127.0.0.1:${port(i)}/wd/hub`
  const env = {
    ...process.env,
    PATH: `${path.dirname(cfg.appiumBin)}:${path.join(cfg.sdkRoot, "platform-tools")}:${path.join(cfg.javaHome, "bin")}:${process.env.PATH ?? ""}`,
    ANDROID_HOME: cfg.sdkRoot,
    ANDROID_SDK_ROOT: cfg.sdkRoot,
    JAVA_HOME: cfg.javaHome,
  }
  async function sessions(i: number): Promise<SessionInfo[]> {
    try {
      const r = await fetch(`${url(i)}/appium/sessions`, { signal: AbortSignal.timeout(3000) })
      const j = (await r.json()) as { value?: SessionInfo[] }
      return Array.isArray(j.value) ? j.value : []
    } catch {
      return []
    }
  }
  async function ready(i: number): Promise<boolean> {
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
    isReady: ready,
    async ensure(i) {
      const g = group(i)
      // um único "subir Appium" por grupo em andamento (os 5 celulares do grupo chamam ao mesmo tempo)
      const pending = starting.get(g)
      if (pending) return pending
      const task = (async () => {
        const pid = procs.get(g)
        if (pid && isAlive(pid)) return
        if (await ready(i)) return // já há um Appium servindo esta porta
        const logFile = path.join(cfg.dataDir, "logs", `appium-g${g}.log`)
        await fsp.mkdir(path.dirname(logFile), { recursive: true })
        const out = fs.openSync(logFile, "a")
        const child = spawn(
          cfg.appiumBin,
          ["--address", "127.0.0.1", "--port", String(port(i)), "--base-path", "/wd/hub", "--relaxed-security", "--log-no-colors", "--log-timestamp"],
          { stdio: ["ignore", out, out], env, detached: true },
        )
        fs.closeSync(out)
        child.unref()
        if (child.pid) procs.set(g, child.pid)
        // espera o servidor responder (ou desistir) antes de liberar o próximo ensure do grupo
        for (let k = 0; k < 40 && !(await ready(i)); k++) {
          if (child.pid && !isAlive(child.pid)) break
          await sleep(250)
        }
      })().finally(() => starting.delete(g))
      starting.set(g, task)
      return task
    },
    async cleanupSessions(i, serial) {
      let removed = 0
      for (const s of await sessions(i)) {
        const caps = s.capabilities ?? {}
        const udid = caps.udid ?? caps["appium:udid"] ?? caps.deviceUDID
        if (udid !== serial) continue
        try {
          await fetch(`${url(i)}/session/${s.id}`, { method: "DELETE", signal: AbortSignal.timeout(20_000) })
          removed++
        } catch {
          /* o Appium derruba sozinho pelo newCommandTimeout */
        }
      }
      return removed
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
      for (let p = cfg.appiumBasePort + 1; p <= cfg.appiumBasePort + cfg.maxDevices; p++) {
        await run("pkill", ["-u", uid, "-f", `appium --address 127\\.0\\.0\\.1 --port ${p} `])
      }
    },
    async openSessions(i) {
      return (await sessions(i)).length
    },
  }
}

export function fakeAppium(cfg: Config): AppiumPool {
  const started = new Set<number>()
  const group = (i: number) => appiumGroup(i, cfg.devicesPerAppium)
  return {
    url: (i) => `http://127.0.0.1:${cfg.appiumBasePort + group(i)}/wd/hub`,
    async ensure(i) {
      started.add(group(i))
    },
    async isReady(i) {
      return started.has(group(i))
    },
    async cleanupSessions() {
      return 0
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
