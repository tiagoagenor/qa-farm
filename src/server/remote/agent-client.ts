import fs from "node:fs"
import fsp from "node:fs/promises"
import { createHash } from "node:crypto"

import {
  AGENT_PROTOCOL,
  AgentHealthSchema,
  AgentMetricsSchema,
  AgentStateSchema,
  type DeviceAction,
  FarmOpStatusSchema,
  PROTOCOL_HEADER,
} from "@/core/agent-protocol"
import type { FarmOp } from "@/server/farm"

// Cliente HTTP do agente de um worker (o mestre chama pelo lado local do túnel SSH).

export class AgentError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface AgentClient {
  readonly baseUrl: string
  health(): Promise<import("@/core/agent-protocol").AgentHealth>
  state(): Promise<import("@/core/agent-protocol").AgentState>
  metrics(since?: string): Promise<import("@/core/metrics").HistoryPoint[]>
  farmOp(opId: string, op: FarmOp): Promise<{ state: "running" | "ok" | "failed"; code: number | null }>
  farmOpStatus(opId: string): Promise<{ state: "running" | "ok" | "failed"; code: number | null }>
  bootCompleted(serial: string): Promise<boolean>
  versionCode(serial: string, pkg: string): Promise<number | undefined>
  ensureApk(apkPath: string): Promise<string>
  install(serial: string, apkMd5: string, pkg: string, versionCode: number, allowUninstall: boolean): Promise<{ ok: boolean; output: string }>
  focusedWindow(serial: string): Promise<string>
  action(serial: string, action: DeviceAction): Promise<void>
  screen(serial: string): Promise<Buffer | null>
  appiumEnsure(index: number): Promise<void>
  appiumReady(index: number): Promise<boolean>
  appiumSessions(index: number): Promise<number>
  appiumCleanup(index: number, serial: string): Promise<number>
  appiumStopAll(): Promise<void>
}

const md5Cache = new Map<string, { mtimeMs: number; size: number; md5: string }>()

export async function fileMd5(file: string): Promise<string> {
  const st = await fsp.stat(file)
  const c = md5Cache.get(file)
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.md5
  const md5 = await new Promise<string>((resolve, reject) => {
    const h = createHash("md5")
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject)
  })
  md5Cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, md5 })
  return md5
}

export function agentClient(baseUrl: string, token: string, timeoutMs = 3000): AgentClient {
  const headers = { Authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(AGENT_PROTOCOL) }
  const call = async (method: string, p: string, body?: unknown, ms = timeoutMs) => {
    let r: Response
    try {
      r = await fetch(`${baseUrl}${p}`, {
        method,
        headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(ms),
      })
    } catch (e) {
      throw new AgentError(`agente sem resposta (${(e as Error).name === "TimeoutError" ? "tempo esgotado" : (e as Error).message})`)
    }
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string }
      throw new AgentError(j.error ?? `agente respondeu ${r.status}`, r.status)
    }
    return r
  }
  const json = async <T>(method: string, p: string, body?: unknown, ms?: number) => (await (await call(method, p, body, ms)).json()) as T
  const dev = (serial: string) => `/v1/devices/${encodeURIComponent(serial)}`
  const uploading = new Map<string, Promise<void>>()

  return {
    baseUrl,
    health: async () => AgentHealthSchema.parse(await json("GET", "/v1/health")),
    state: async () => AgentStateSchema.parse(await json("GET", "/v1/state")),
    metrics: async (since) => AgentMetricsSchema.parse(await json("GET", `/v1/metrics${since ? `?since=${encodeURIComponent(since)}` : ""}`)).points,
    farmOp: async (opId, op) => FarmOpStatusSchema.parse(await json("POST", "/v1/farm/ops", { opId, op })),
    farmOpStatus: async (opId) => FarmOpStatusSchema.parse(await json("GET", `/v1/farm/ops/${encodeURIComponent(opId)}`)),
    bootCompleted: async (s) => (await json<{ booted: boolean }>("GET", `${dev(s)}/boot-completed`, undefined, 15_000)).booted,
    versionCode: async (s, pkg) => (await json<{ versionCode: number | null }>("GET", `${dev(s)}/version?package=${encodeURIComponent(pkg)}`, undefined, 25_000)).versionCode ?? undefined,
    /** Envia o APK uma vez por worker (cache por md5; várias instalações simultâneas esperam o mesmo envio). */
    async ensureApk(apkPath) {
      const md5 = await fileMd5(apkPath)
      const head = await fetch(`${baseUrl}/v1/apks/${md5}`, { method: "HEAD", headers, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null)
      if (head?.ok) return md5
      if (!uploading.has(md5)) {
        uploading.set(
          md5,
          (async () => {
            const size = (await fsp.stat(apkPath)).size
            const r = await fetch(`${baseUrl}/v1/apks/${md5}`, {
              method: "PUT",
              headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": String(size) },
              body: fs.createReadStream(apkPath) as unknown as BodyInit,
              duplex: "half",
              signal: AbortSignal.timeout(10 * 60_000),
            } as RequestInit)
            if (!r.ok) throw new AgentError(`falha ao enviar o APK (${r.status})`, r.status)
          })().finally(() => uploading.delete(md5)),
        )
      }
      await uploading.get(md5)
      return md5
    },
    install: async (s, apkMd5, pkg, versionCode, allowUninstall) =>
      json("POST", `${dev(s)}/install`, { apkMd5, package: pkg, versionCode, allowUninstall }, 11 * 60_000),
    focusedWindow: async (s) => (await json<{ focus: string }>("GET", `${dev(s)}/focused-window`, undefined, 20_000)).focus,
    action: async (s, a) => {
      await call("POST", `${dev(s)}/actions`, a, 20_000)
    },
    screen: async (s) => {
      const r = await call("GET", `${dev(s)}/screen`, undefined, 20_000).catch(() => null)
      return r ? Buffer.from(await r.arrayBuffer()) : null
    },
    appiumEnsure: async (i) => {
      await call("POST", `/v1/appium/${i}/ensure`, {}, 60_000)
    },
    appiumReady: async (i) => (await json<{ ready: boolean }>("GET", `/v1/appium/${i}/ready`)).ready,
    appiumSessions: async (i) => (await json<{ sessions: number }>("GET", `/v1/appium/${i}/sessions`)).sessions,
    appiumCleanup: async (i, serial) => (await json<{ removed: number }>("POST", `/v1/appium/${i}/cleanup`, { serial }, 20_000)).removed,
    appiumStopAll: async () => {
      await call("POST", "/v1/appium/stop-all", {}, 30_000)
    },
  }
}
