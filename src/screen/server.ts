import { randomUUID } from "node:crypto"
import http from "node:http"

import { type WebSocket, WebSocketServer } from "ws"

import { SESSION_COOKIE, verifySessionToken } from "@/core/auth"
import type { Config } from "@/core/config"
import { ADB_SERVER_PORT, localPorts, MachinesFileSchema, parseDeviceKey } from "@/core/machines"
import { dataPaths } from "@/core/paths"
import {
  ClientMessageSchema,
  encodeVideoPacket,
  SCREEN_CLOSE_DEVICE,
  SCREEN_CLOSE_IDLE,
  SCREEN_CLOSE_LIMIT,
  ScreenSessions,
  type ServerMessage,
  type VideoPacket,
} from "@/core/screen-protocol"
import { readJson, writeJsonAtomic } from "@/core/store"
import { DevicesStateSchema, SettingsSchema } from "@/core/types"

import type { AdbEndpoint, ScreenSource, ScreenStream } from "./source"

// Serviço de tela ao vivo (processo próprio, porta 3001): WebSocket só para quem está logado no painel e vindo do
// próprio painel; no máximo N celulares transmitindo ao mesmo tempo (Máquinas → limite; 0 = desligado). Quem assiste
// o mesmo celular divide a transmissão. Só um espectador por celular controla (toques/teclas) por vez.

export interface ScreenServerOptions {
  cfg: Config
  source: ScreenSource
  port: number
  host?: string
  /** porta do painel (Origin aceito) */
  panelPort: number
  log?: (m: string) => void
  /** sem ping do navegador por este tempo → espectador sai */
  pingTimeoutMs?: number
  /** limite duro de uma transmissão */
  maxStreamMs?: number
  /** porta do adb server do mestre (padrão 5037; diagnóstico por túnel usa outra) */
  adbPort?: number
}

interface Viewer {
  id: string
  ws: WebSocket
  lastPing: number
  /** só manda quadros depois do próximo quadro-chave (entrou no meio ou atrasou) */
  needKey: boolean
  lastMove: number
}

interface DeviceStream {
  key: string
  stream: Promise<ScreenStream>
  config: VideoPacket | null
  viewers: Map<string, Viewer>
  timer: NodeJS.Timeout
}

const MAX_BUFFERED = 2 * 1024 * 1024
const MOVE_INTERVAL_MS = 16 // ~60 toques de arraste por segundo

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=")
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/** Origin precisa ser o painel: mesmo host da conexão e porta do painel (evita outro site abrir a tela). */
export function originAllowed(
  origin: string | undefined,
  hostHeader: string | undefined,
  panelPort: number,
): boolean {
  if (!origin || !hostHeader) return false
  try {
    const o = new URL(origin)
    const host = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "")
    const port = o.port || (o.protocol === "https:" ? "443" : "80")
    return o.hostname.replace(/^\[|\]$/g, "") === host && Number(port) === panelPort
  } catch {
    return false
  }
}

export async function startScreenServer(o: ScreenServerOptions) {
  const log = o.log ?? ((m: string) => console.log(`[screen ${new Date().toISOString()}] ${m}`))
  const p = dataPaths(o.cfg.dataDir)
  const pingTimeout = o.pingTimeoutMs ?? 45_000
  const maxStream = o.maxStreamMs ?? 30 * 60_000

  let max = 3
  const loadSettings = async () => {
    max = (await readJson(p.settings, SettingsSchema, { maxParallel: 0, maxScreenSessions: 3 }))
      .maxScreenSessions
  }
  await loadSettings()
  const sessions = new ScreenSessions(() => max)
  const streams = new Map<string, DeviceStream>()

  const writeState = async () => {
    await writeJsonAtomic(p.screen, {
      updatedAt: new Date().toISOString(),
      max,
      port: o.port,
      sessions: sessions.list(),
    }).catch(() => undefined)
  }
  const send = (v: Viewer, m: ServerMessage) => {
    if (v.ws.readyState === v.ws.OPEN) v.ws.send(JSON.stringify(m))
  }

  /** Celular aceito: existe, não é da nuvem e está ligado. Devolve onde está o adb dele. */
  const resolveDevice = async (
    key: string,
  ): Promise<{ ep: AdbEndpoint; busy: boolean } | { error: string }> => {
    const devices = await readJson(p.devicesState, DevicesStateSchema.nullable(), null)
    const d = devices?.devices.find((x) => x.serial === key)
    if (!d || d.kind === "cloud" || key.startsWith("browserstack:"))
      return { error: "Celular não encontrado (ou é da nuvem)" }
    if (d.adbState !== "device") return { error: "Celular desligado ou desconectado" }
    const file = await readJson(p.machines, MachinesFileSchema, { machines: [] })
    const parsed = parseDeviceKey(key, new Set(file.machines.map((m) => m.id)))
    if (!parsed.machineId)
      return {
        ep: { host: "127.0.0.1", port: o.adbPort ?? ADB_SERVER_PORT, serial: key },
        busy: d.state === "busy" || d.state === "reserved",
      }
    const m = file.machines.find((x) => x.id === parsed.machineId)!
    if (m.transport !== "ssh" && !o.source.fake) return { error: "Máquina sem túnel SSH" }
    return {
      ep: { host: "127.0.0.1", port: localPorts(m.slot).adb, serial: parsed.serial },
      busy: d.state === "busy" || d.state === "reserved",
    }
  }

  /** Emulador sem teste rodando volta a dormir quando ninguém mais assiste (físico, em teste e reservado ficam como estão). */
  const sleepIfIdle = async (key: string, s: ScreenStream) => {
    const devices = await readJson(p.devicesState, DevicesStateSchema.nullable(), null)
    const d = devices?.devices.find((x) => x.serial === key)
    if (d?.kind === "emulator" && d.state !== "busy" && d.state !== "reserved") await s.sleep()
  }

  const stopStream = (ds: DeviceStream, code: number, reason: string) => {
    clearTimeout(ds.timer)
    streams.delete(ds.key)
    for (const v of ds.viewers.values()) {
      sessions.leave(ds.key, v.id)
      v.ws.close(code, reason)
    }
    void ds.stream
      .then(async (s) => {
        await sleepIfIdle(ds.key, s).catch(() => undefined)
        await s.close()
      })
      .catch(() => undefined)
    log(`tela de ${ds.key} encerrada (${reason})`)
    void writeState()
  }

  const leave = (ds: DeviceStream, v: Viewer) => {
    ds.viewers.delete(v.id)
    const last = sessions.leave(ds.key, v.id)
    if (last) stopStream(ds, 1000, "sem espectadores")
    else broadcastController(ds)
    void writeState()
  }

  const broadcastController = (ds: DeviceStream) => {
    const c = sessions.controller(ds.key)
    for (const v of ds.viewers.values())
      send(v, { t: "controller", you: c === v.id, other: !!c && c !== v.id })
  }

  const deliver = (ds: DeviceStream, pkt: VideoPacket) => {
    if (pkt.type === "configuration") ds.config = pkt
    const bin = encodeVideoPacket(pkt)
    for (const v of ds.viewers.values()) {
      if (v.ws.readyState !== v.ws.OPEN) continue
      if (pkt.type === "data") {
        if (v.ws.bufferedAmount > MAX_BUFFERED) {
          v.needKey = true // rede lenta: descarta até o próximo quadro-chave em vez de acumular atraso
          continue
        }
        if (v.needKey && !pkt.keyframe) continue
        v.needKey = false
      }
      v.ws.send(bin)
    }
  }

  const openStream = (key: string, ep: AdbEndpoint): DeviceStream => {
    const ds: DeviceStream = {
      key,
      config: null,
      viewers: new Map(),
      stream: o.source.open(ep),
      timer: setTimeout(() => stopStream(ds, SCREEN_CLOSE_IDLE, "tempo máximo de 30 min"), maxStream),
    }
    streams.set(key, ds)
    ds.stream.then(
      (s) => {
        log(`tela de ${key} iniciada (${s.width}x${s.height})`)
        s.onPacket((pkt) => deliver(ds, pkt))
        s.onSize((width, height) => {
          for (const v of ds.viewers.values()) send(v, { t: "size", width, height })
        })
        for (const v of ds.viewers.values()) send(v, { t: "size", width: s.width, height: s.height })
        void s.closed.then(() => {
          if (streams.get(key) === ds) stopStream(ds, 1011, "transmissão terminou")
        })
      },
      (e: Error) => {
        log(`não consegui abrir a tela de ${key}: ${e.message}`)
        for (const v of ds.viewers.values())
          send(v, { t: "error", message: `Não foi possível abrir a tela: ${e.message}` })
        if (streams.get(key) === ds) stopStream(ds, 1011, "falha ao abrir")
      },
    )
    return ds
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({ ok: true, max, used: sessions.used }))
    }
    res.writeHead(404)
    res.end()
  })

  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      const reject = (status: number, msg: string) => {
        socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\n\r\n`)
        socket.destroy()
      }
      const url = new URL(req.url ?? "/", "http://screen")
      if (url.pathname !== "/ws") return reject(404, "Not Found")
      if (!(await verifySessionToken(o.cfg.secret, parseCookies(req.headers.cookie)[SESSION_COOKIE])))
        return reject(401, "Unauthorized")
      if (!originAllowed(req.headers.origin, req.headers.host, o.panelPort)) return reject(403, "Forbidden")
      const key = url.searchParams.get("device") ?? ""
      wss.handleUpgrade(req, socket, head, (ws) => void onConnection(ws, key))
    })().catch(() => socket.destroy())
  })

  const onConnection = async (ws: WebSocket, key: string) => {
    const dev = await resolveDevice(key)
    if ("error" in dev) return ws.close(SCREEN_CLOSE_DEVICE, dev.error)
    await loadSettings()
    const can = sessions.canJoin(key)
    if (!can.ok) return ws.close(SCREEN_CLOSE_LIMIT, can.reason)
    const v: Viewer = { id: randomUUID(), ws, lastPing: Date.now(), needKey: true, lastMove: 0 }
    const isNew = sessions.join(key, v.id)
    const ds = isNew || !streams.get(key) ? openStream(key, dev.ep) : streams.get(key)!
    ds.viewers.set(v.id, v)
    log(
      `${isNew ? "abrindo" : "entrando na"} tela de ${key} (${ds.viewers.size} espectador(es), ${sessions.used}/${max} celulares)`,
    )
    send(v, {
      t: "hello",
      device: key,
      fake: o.source.fake,
      busy: dev.busy,
      controlling: false,
      viewers: ds.viewers.size,
    })
    if (ds.config) ws.send(encodeVideoPacket(ds.config))
    void ds.stream
      .then((s) => send(v, { t: "size", width: s.width, height: s.height }))
      .catch(() => undefined)
    broadcastController(ds)
    void writeState()

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return
      let msg
      try {
        msg = ClientMessageSchema.parse(JSON.parse(raw.toString()))
      } catch {
        return
      }
      v.lastPing = Date.now()
      if (msg.t === "ping") return
      if (msg.t === "control") {
        sessions.setControl(key, v.id, msg.on)
        broadcastController(ds)
        void writeState()
        return
      }
      // só quem está com o controle mexe no celular (os outros só assistem)
      if (sessions.controller(key) !== v.id) return
      if (msg.t === "touch" && msg.action === "move") {
        if (Date.now() - v.lastMove < MOVE_INTERVAL_MS) return
        v.lastMove = Date.now()
      }
      void ds.stream
        .then((s) =>
          msg.t === "touch"
            ? s.touch(msg.action, msg.x, msg.y)
            : msg.t === "key"
              ? s.key(msg.key)
              : undefined,
        )
        .catch((e: Error) => log(`comando na tela de ${key} falhou: ${e.message}`))
    })
    ws.on("close", () => leave(ds, v))
    ws.on("error", () => undefined)
  }

  // espectador sem ping (aba fechada/sem rede) sai; configuração e estado atualizados a cada 5–10 s
  const housekeeping = setInterval(() => {
    void loadSettings()
    for (const ds of streams.values()) {
      for (const v of ds.viewers.values())
        if (Date.now() - v.lastPing > pingTimeout) v.ws.close(SCREEN_CLOSE_IDLE, "sem resposta do navegador")
    }
    void writeState()
  }, 5000)

  await new Promise<void>((r) => server.listen(o.port, o.host ?? "0.0.0.0", r))
  const port = (server.address() as { port: number }).port
  log(`serviço de tela ouvindo na porta ${port} (até ${max} celulares ao vivo)`)
  await writeState()
  return {
    port,
    sessions,
    close: async () => {
      clearInterval(housekeeping)
      for (const ds of [...streams.values()]) stopStream(ds, 1001, "serviço encerrado")
      wss.close()
      const closed = new Promise<void>((r) => server.close(() => r()))
      server.closeAllConnections()
      await closed
    },
  }
}
