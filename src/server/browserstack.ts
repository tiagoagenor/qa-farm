import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import { type BsDevice, BsDeviceSchema, type BsPlan, BsPlanSchema } from "@/core/browserstack"
import type { Config } from "@/core/config"

// Cliente da API do BrowserStack App Automate (credenciais só do .env do painel; nunca em log/arquivo).

export interface BsSessionInfo {
  status?: string
  publicUrl?: string
  videoUrl?: string
}

export interface BrowserStackApi {
  readonly configured: boolean
  readonly user: string
  /** segredos a redigir em arquivos/logs */
  readonly secrets: string[]
  readonly hubUrl: string
  plan(): Promise<BsPlan>
  devices(): Promise<BsDevice[]>
  /** envia o APK e devolve o app_url (bs://…) */
  upload(apkPath: string, customId: string): Promise<string>
  setSessionStatus(sessionId: string, status: "passed" | "failed", reason: string): Promise<void>
  session(sessionId: string): Promise<BsSessionInfo>
  /** encerra a sessão remota (caso morto por timeout/cancelamento não pode segurar a vaga) */
  deleteSession(sessionId: string): Promise<void>
}

export function realBrowserStack(cfg: Config): BrowserStackApi {
  const user = cfg.bsUser
  const key = cfg.bsKey
  const api = cfg.bsApiUrl.replace(/\/$/, "")
  const auth = `Basic ${Buffer.from(`${user}:${key}`).toString("base64")}`
  const call = async (method: string, p: string, body?: BodyInit, headers: Record<string, string> = {}, ms = 30_000) => {
    const r = await fetch(`${api}${p}`, { method, body, headers: { Authorization: auth, ...headers }, signal: AbortSignal.timeout(ms) })
    if (!r.ok) throw new Error(`BrowserStack ${method} ${p.split("?")[0]} → ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`)
    return r
  }
  return {
    configured: !!(user && key),
    user,
    secrets: [key],
    hubUrl: cfg.bsHubUrl,
    plan: async () => BsPlanSchema.parse(await (await call("GET", "/app-automate/plan.json")).json()),
    devices: async () => BsDeviceSchema.array().parse(await (await call("GET", "/app-automate/devices.json")).json()),
    async upload(apkPath, customId) {
      const form = new FormData()
      form.set("file", await fs.openAsBlob(apkPath), path.basename(apkPath))
      form.set("custom_id", customId)
      const r = await call("POST", "/app-automate/upload", form, {}, 15 * 60_000)
      const j = (await r.json()) as { app_url?: string }
      if (!j.app_url) throw new Error("BrowserStack não devolveu app_url no envio do APK")
      return j.app_url
    },
    async setSessionStatus(id, status, reason) {
      await call("PUT", `/app-automate/sessions/${encodeURIComponent(id)}.json`, JSON.stringify({ status, reason: reason.slice(0, 250) }), {
        "Content-Type": "application/json",
      })
    },
    async session(id) {
      const j = (await (await call("GET", `/app-automate/sessions/${encodeURIComponent(id)}.json`)).json()) as {
        automation_session?: { status?: string; public_url?: string; browser_url?: string; video_url?: string }
      }
      const s = j.automation_session ?? {}
      return { status: s.status, publicUrl: s.public_url ?? s.browser_url, videoUrl: s.video_url }
    },
    async deleteSession(id) {
      await fetch(`${cfg.bsHubUrl.replace(/\/$/, "")}/session/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(20_000),
      }).catch(() => undefined)
    },
  }
}

/** Fake (modo simulado): plano e sessões num arquivo do "mundo" simulado. */
export function fakeBrowserStack(cfg: Config): BrowserStackApi {
  const file = path.join(cfg.dataDir, "fake", "browserstack.json")
  type S = { running?: number; max?: number; uploads: string[]; statuses: Record<string, string>; deleted: string[] }
  const read = async (): Promise<S> => ({ uploads: [], statuses: {}, deleted: [], ...JSON.parse(await fsp.readFile(file, "utf8").catch(() => "{}")) })
  // leitura-alteração-gravação serializada (casos terminando juntos não podem perder registros)
  let chain: Promise<unknown> = Promise.resolve()
  const update = (fn: (s: S) => void) => {
    const next = chain.then(async () => {
      const s = await read()
      fn(s)
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, JSON.stringify(s))
    })
    chain = next.catch(() => undefined)
    return next
  }
  return {
    configured: true,
    user: "fake-user",
    secrets: ["fake-key-123456"],
    hubUrl: "https://hub.fake-browserstack.invalid/wd/hub",
    async plan() {
      const s = await read()
      return { parallel_sessions_running: s.running ?? 0, parallel_sessions_max_allowed: s.max ?? 8 }
    },
    async devices() {
      return [
        { device: "Samsung Galaxy S22", os: "android", os_version: "12.0", realMobile: true },
        { device: "Google Pixel 7", os: "android", os_version: "13.0", realMobile: true },
      ]
    },
    async upload(apkPath, customId) {
      await update((s) => s.uploads.push(customId))
      return `bs://fake-${customId}`
    },
    async setSessionStatus(id, status) {
      await update((s) => {
        s.statuses[id] = status
      })
    },
    async session(id) {
      return { status: "done", publicUrl: `https://app-automate.fake-browserstack.invalid/builds/x/sessions/${id}` }
    },
    async deleteSession(id) {
      await update((s) => s.deleted.push(id))
    },
  }
}
