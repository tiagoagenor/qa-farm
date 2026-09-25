import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import {
  AGENT_PROTOCOL,
  type AgentHealth,
  type AgentState,
  DeviceActionSchema,
  FarmOpRequestSchema,
  InstallRequestSchema,
  PROTOCOL_HEADER,
} from "@/core/agent-protocol"
import type { Config } from "@/core/config"
import { MetricsHistory } from "@/core/metrics"
import { parseAdbDevices } from "@/core/parsers/adb-devices"
import type { Adapters } from "@/server/adapters"
import { describeOp, type FarmOp } from "@/server/farm"

// Agente do worker: HTTP em 127.0.0.1 (o mestre chega por túnel SSH). Implementa, remotamente, as mesmas
// operações que o runner faz localmente: adb, fazenda de emuladores, Appium, cache de APK e métricas.

export interface AgentOptions {
  cfg: Config
  ad: Adapters
  token: string
  host?: string
  port: number
  version: string
  commit: string
  /** pasta dos APKs recebidos do mestre (guarda os 3 últimos) */
  apkDir: string
  log?: (m: string) => void
}

const MD5_RE = /^[a-f0-9]{32}$/
const KEEP_APKS = 3

export async function startAgent(o: AgentOptions): Promise<{ server: http.Server; url: string; close: () => Promise<void> }> {
  const log = o.log ?? ((m: string) => console.log(`[agent ${new Date().toISOString()}] ${m}`))
  await fsp.mkdir(o.apkDir, { recursive: true })
  const bootId = (await fsp.readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => randomUUID())).trim()
  const startedAt = new Date().toISOString()

  // ---- métricas: lê a cada intervalo e guarda 30 min (o mestre completa buracos por /v1/metrics?since=)
  const history = new MetricsHistory()
  let lastSample: AgentState["metrics"] = null
  const collect = async () => {
    try {
      lastSample = await o.ad.metrics.sample()
      history.add(lastSample)
    } catch (e) {
      log(`falha ao ler métricas: ${(e as Error).message}`)
    }
  }
  await collect()
  const metricsTimer = setInterval(() => void collect(), Math.max(500, o.cfg.metricsIntervalMs))

  // ---- fazenda: uma operação por vez, idempotente por opId
  const ops = new Map<string, { state: "running" | "ok" | "failed"; code: number | null; op: FarmOp; startedAt: string }>()
  let farmChain: Promise<unknown> = Promise.resolve()
  let farmJob: AgentState["farmJob"] = null
  const runOp = (opId: string, op: FarmOp) => {
    ops.set(opId, { state: "running", code: null, op, startedAt: new Date().toISOString() })
    farmChain = farmChain.then(async () => {
      farmJob = { opId, command: describeOp(op), startedAt: new Date().toISOString() }
      log(`fazenda: ${describeOp(op)}`)
      const r = await o.ad.farm.exec(op, path.join(o.cfg.dataDir, "logs", "farm.log")).catch(() => ({ ok: false, code: null }))
      ops.set(opId, { ...ops.get(opId)!, state: r.ok ? "ok" : "failed", code: r.code })
      log(`fazenda: ${describeOp(op)} → ${r.ok ? "ok" : `código ${r.code}`}`)
      farmJob = null
    })
  }

  // ---- serial válido = aparece no adb devices do próprio worker (cache de 2 s)
  let adbCache = { at: 0, raw: "" }
  const adbRaw = async () => {
    if (Date.now() - adbCache.at > 2000) adbCache = { at: Date.now(), raw: await o.ad.adb.devicesRaw() }
    return adbCache.raw
  }
  const knownSerial = async (serial: string) => parseAdbDevices(await adbRaw()).some((d) => d.serial === serial)

  const listApks = async () => (await fsp.readdir(o.apkDir).catch(() => [] as string[])).filter((f) => /^[a-f0-9]{32}\.apk$/.test(f)).map((f) => f.slice(0, 32))
  const pruneApks = async () => {
    const files = await Promise.all(
      (await listApks()).map(async (m) => ({ m, t: (await fsp.stat(path.join(o.apkDir, `${m}.apk`))).mtimeMs })),
    )
    for (const f of files.sort((a, b) => b.t - a.t).slice(KEEP_APKS)) await fsp.rm(path.join(o.apkDir, `${f.m}.apk`), { force: true })
  }

  const qemuPids = async () => Object.fromEntries([...(await o.ad.farm.qemuPids()).entries()].map(([k, v]) => [String(k), v]))

  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" })
      res.end(type === "application/json" ? JSON.stringify(body) : (body as Buffer | string))
    }
    try {
      if (req.headers.authorization !== `Bearer ${o.token}`) return send(401, { error: "token inválido" })
      if (Number(req.headers[PROTOCOL_HEADER]) !== AGENT_PROTOCOL) return send(409, { error: `protocolo ${req.headers[PROTOCOL_HEADER]} ≠ ${AGENT_PROTOCOL}` })
      const url = new URL(req.url ?? "/", "http://agent")
      const parts = url.pathname.split("/").filter(Boolean) // ["v1", ...]
      const body = async () => {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
      }
      const m = req.method ?? "GET"
      if (parts[0] !== "v1") return send(404, { error: "rota desconhecida" })
      const [, a, b, c] = parts

      if (m === "GET" && a === "health") {
        const h: AgentHealth = { protocol: AGENT_PROTOCOL, agentVersion: o.version, commit: o.commit, hostname: os.hostname(), bootId, startedAt, now: new Date().toISOString() }
        return send(200, h)
      }
      if (m === "GET" && a === "state") {
        const st: AgentState = {
          protocol: AGENT_PROTOCOL,
          bootId,
          now: new Date().toISOString(),
          adbRaw: await adbRaw(),
          qemuPids: await qemuPids(),
          farmJob,
          apks: await listApks(),
          metrics: lastSample,
          versions: {},
        }
        return send(200, st)
      }
      if (m === "GET" && a === "metrics") {
        const since = Date.parse(url.searchParams.get("since") ?? "")
        return send(200, { points: history.list().filter((p) => !Number.isFinite(since) || Date.parse(p.at) > since) })
      }

      // ---- fazenda
      if (a === "farm" && b === "ops") {
        if (m === "POST" && !c) {
          const r = FarmOpRequestSchema.safeParse(await body())
          if (!r.success) return send(400, { error: r.error.issues[0]?.message })
          if (!ops.has(r.data.opId)) runOp(r.data.opId, r.data.op as FarmOp)
          const s = ops.get(r.data.opId)!
          return send(202, { opId: r.data.opId, state: s.state, code: s.code })
        }
        if (m === "GET" && c) {
          const s = ops.get(c)
          return s ? send(200, { opId: c, state: s.state, code: s.code }) : send(404, { error: "operação desconhecida" })
        }
      }

      // ---- APKs
      if (a === "apks" && b) {
        if (!MD5_RE.test(b)) return send(400, { error: "md5 inválido" })
        const file = path.join(o.apkDir, `${b}.apk`)
        if (m === "HEAD") {
          res.writeHead(fs.existsSync(file) ? 200 : 404)
          return res.end()
        }
        if (m === "PUT") {
          const tmp = `${file}.${process.pid}.tmp`
          const hash = createHash("md5")
          await new Promise<void>((resolve, reject) => {
            const out = fs.createWriteStream(tmp)
            req.on("data", (d: Buffer) => hash.update(d))
            req.pipe(out)
            out.on("finish", resolve)
            out.on("error", reject)
            req.on("error", reject)
          })
          if (hash.digest("hex") !== b) {
            await fsp.rm(tmp, { force: true })
            return send(400, { error: "md5 do arquivo recebido não confere" })
          }
          await fsp.rename(tmp, file)
          await pruneApks()
          return send(201, { ok: true })
        }
      }

      // ---- Appium
      if (a === "appium") {
        if (m === "POST" && b === "stop-all") {
          await o.ad.appium.stopAll()
          return send(200, { ok: true })
        }
        const index = Number(b)
        if (!Number.isInteger(index) || index < 1 || index > 99) return send(400, { error: "índice inválido" })
        if (m === "POST" && c === "ensure") {
          await o.ad.appium.ensure(index)
          return send(200, { ok: true })
        }
        if (m === "GET" && c === "ready") return send(200, { ready: await o.ad.appium.isReady(index) })
        if (m === "GET" && c === "sessions") return send(200, { sessions: await o.ad.appium.openSessions(index) })
        if (m === "POST" && c === "cleanup") {
          const { serial } = (await body()) as { serial?: string }
          if (!serial) return send(400, { error: "serial ausente" })
          return send(200, { removed: await o.ad.appium.cleanupSessions(index, serial) })
        }
      }

      // ---- celulares
      if (a === "devices" && b) {
        const serial = decodeURIComponent(b)
        if (!(await knownSerial(serial))) return send(404, { error: "celular desconhecido neste worker" })
        if (m === "GET" && c === "boot-completed") return send(200, { booted: await o.ad.adb.bootCompleted(serial) })
        if (m === "GET" && c === "version") return send(200, { versionCode: (await o.ad.adb.versionCode(serial, url.searchParams.get("package") ?? "")) ?? null })
        if (m === "GET" && c === "focused-window") return send(200, { focus: await o.ad.adb.focusedWindow(serial) })
        if (m === "GET" && c === "screen") {
          const png = await o.ad.adb.screencap(serial)
          return png ? send(200, png, "image/png") : send(404, { error: "sem imagem" })
        }
        if (m === "POST" && c === "install") {
          const r = InstallRequestSchema.safeParse(await body())
          if (!r.success) return send(400, { error: r.error.issues[0]?.message })
          const apk = path.join(o.apkDir, `${r.data.apkMd5}.apk`)
          if (!fs.existsSync(apk)) return send(409, { error: "APK não está no cache do worker (envie antes)" })
          const out = await o.ad.adb.install(serial, apk, r.data.package, r.data.versionCode, { allowUninstall: r.data.allowUninstall })
          return send(200, out)
        }
        if (m === "POST" && c === "actions") {
          const r = DeviceActionSchema.safeParse(await body())
          if (!r.success) return send(400, { error: "ação não permitida" })
          const act = r.data
          if (act.action === "closeSystemDialogs") await o.ad.adb.closeSystemDialogs(serial)
          else if (act.action === "disableLockscreen") await o.ad.adb.disableLockscreen(serial)
          else if (act.action === "forceStop") await o.ad.adb.forceStop(serial, act.package)
          else if (act.action === "keyevent") await o.ad.adb.keyevent(serial, act.key)
          else await o.ad.adb.putGlobalSetting(serial, act.key, act.value)
          return send(200, { ok: true })
        }
      }

      // ---- logs (diagnóstico)
      if (m === "GET" && a === "logs" && b && /^[a-z0-9-]+$/.test(b)) {
        const file = path.join(o.cfg.dataDir, "logs", `${b}.log`)
        const text = await fsp.readFile(file, "utf8").catch(() => "")
        const tail = Math.min(2000, Number(url.searchParams.get("tail") ?? 200))
        return send(200, text.split("\n").slice(-tail).join("\n"), "text/plain; charset=utf-8")
      }
      return send(404, { error: "rota desconhecida" })
    } catch (e) {
      log(`erro: ${(e as Error).stack ?? e}`)
      if (!res.headersSent) send(500, { error: (e as Error).message })
    }
  })

  await new Promise<void>((resolve) => server.listen(o.port, o.host ?? "127.0.0.1", resolve))
  const addr = server.address() as { port: number }
  log(`agente ouvindo em ${o.host ?? "127.0.0.1"}:${addr.port} (protocolo ${AGENT_PROTOCOL})`)
  return {
    server,
    url: `http://${o.host ?? "127.0.0.1"}:${addr.port}`,
    close: async () => {
      clearInterval(metricsTimer)
      // fecha também as conexões keep-alive do mestre: sem isso o agente "parado" seguia respondendo nelas
      // e o mestre continuava vendo a máquina online
      const closed = new Promise<void>((r) => server.close(() => r()))
      server.closeAllConnections()
      await closed
    },
  }
}
