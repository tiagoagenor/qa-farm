import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { AdbServerClient } from "@yume-chan/adb"
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from "@yume-chan/adb-scrcpy"
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp"
import { AndroidKeyCode, AndroidKeyEventAction, AndroidMotionEventAction } from "@yume-chan/scrcpy"
import { ReadableStream, WritableStream } from "@yume-chan/stream-extra"

import type { VideoPacket } from "@/core/screen-protocol"

// De onde vem a tela: scrcpy-server v3.3.3 empurrado para o celular pelo adb server da máquina dele (mestre na
// 5037; worker pela porta do túnel). Sem efeito colateral nos testes: sem áudio, sem clipboard, não mantém
// acordado, não desliga a tela ao fechar, não mostra toques; o jar é apagado ao fechar. Acorda a tela ao abrir
// (apagada não gera imagem); quem apaga de volta é o serviço, só em emulador sem teste rodando.

export const SCRCPY_VERSION = "3.3.3"
/** SHA-256 publicado pelo projeto scrcpy para scrcpy-server-v3.3.3 (doc/build.md). */
export const SCRCPY_SERVER_SHA256 = "7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0"
const DEVICE_PATH = `/data/local/tmp/qafarm-scrcpy-${SCRCPY_VERSION}.jar`

export interface ScreenStream {
  width: number
  height: number
  onPacket(cb: (p: VideoPacket) => void): void
  onSize(cb: (w: number, h: number) => void): void
  touch(action: "down" | "move" | "up", x: number, y: number): Promise<void>
  key(key: "back" | "home" | "app_switch"): Promise<void>
  close(): Promise<void>
  /** apaga a tela (emulador parado: não gastar CPU desenhando) */
  sleep(): Promise<void>
  /** resolve quando a transmissão termina (celular sumiu, servidor caiu, close()) */
  closed: Promise<void>
}

export interface AdbEndpoint {
  host: string
  port: number
  serial: string
}

export interface ScreenSource {
  readonly fake: boolean
  open(ep: AdbEndpoint): Promise<ScreenStream>
}

/** Lê o scrcpy-server e confere o SHA-256 (arquivo alterado = não inicia). */
export function loadServerBin(file: string): Uint8Array {
  const bin = fs.readFileSync(file)
  const sha = createHash("sha256").update(bin).digest("hex")
  if (sha !== SCRCPY_SERVER_SHA256)
    throw new Error(`scrcpy-server com hash inesperado (${sha.slice(0, 12)}…): não será usado`)
  return new Uint8Array(bin)
}

export function scrcpyOptions(scid: string) {
  return new AdbScrcpyOptions3_3_3({
    audio: false,
    clipboardAutosync: false,
    powerOn: true,
    stayAwake: false,
    powerOffOnClose: false,
    showTouches: false,
    cleanup: true,
    control: true,
    maxSize: 800,
    videoBitRate: 2_000_000,
    maxFps: 24,
    videoCodec: "h264",
    // Baseline (o decodificador do navegador exige) e quadro-chave a cada 2 s (quem entra depois vê logo)
    videoCodecOptions: "profile=1,i-frame-interval=2",
    tunnelForward: true,
    sendDeviceMeta: true,
    scid,
  })
}

export function realScreenSource(repoRoot: string): ScreenSource {
  let bin: Uint8Array | null = null
  const serverBin = () =>
    (bin ??= loadServerBin(path.join(repoRoot, "vendor/scrcpy", `scrcpy-server-v${SCRCPY_VERSION}`)))
  return {
    fake: false,
    async open(ep) {
      const client = new AdbServerClient(new AdbServerNodeTcpConnector({ host: ep.host, port: ep.port }))
      const adb = await client.createAdb({ serial: ep.serial })
      const data = serverBin()
      await AdbScrcpyClient.pushServer(
        adb,
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(data)
            c.close()
          },
        }),
        DEVICE_PATH,
      )
      const scid = Math.floor(Math.random() * 0x7fffffff)
        .toString(16)
        .padStart(8, "0")
      const sc = await AdbScrcpyClient.start(adb, DEVICE_PATH, scrcpyOptions(scid))
      void sc.output.pipeTo(new WritableStream()).catch(() => undefined) // precisa ser consumido
      const video = await sc.videoStream
      if (!video) {
        await sc.close().catch(() => undefined)
        throw new Error("scrcpy não abriu o vídeo")
      }
      const packetCbs: Array<(p: VideoPacket) => void> = []
      const sizeCbs: Array<(w: number, h: number) => void> = []
      const stream: ScreenStream = {
        width: video.width,
        height: video.height,
        onPacket: (cb) => void packetCbs.push(cb),
        onSize: (cb) => void sizeCbs.push(cb),
        async touch(action, x, y) {
          const c = sc.controller
          if (!c || !stream.width) return
          await c.injectTouch({
            action:
              action === "down"
                ? AndroidMotionEventAction.Down
                : action === "up"
                  ? AndroidMotionEventAction.Up
                  : AndroidMotionEventAction.Move,
            pointerId: BigInt(-2), // dedo
            pointerX: Math.round(x * stream.width),
            pointerY: Math.round(y * stream.height),
            videoWidth: stream.width,
            videoHeight: stream.height,
            pressure: action === "up" ? 0 : 1,
            actionButton: 0,
            buttons: 0,
          })
        },
        async key(k) {
          const c = sc.controller
          if (!c) return
          const keyCode =
            k === "back"
              ? AndroidKeyCode.AndroidBack
              : k === "home"
                ? AndroidKeyCode.AndroidHome
                : AndroidKeyCode.AndroidAppSwitch
          for (const action of [AndroidKeyEventAction.Down, AndroidKeyEventAction.Up]) {
            await c.injectKeyCode({ action, keyCode, repeat: 0, metaState: 0 })
          }
        },
        async close() {
          await sc.close().catch(() => undefined)
        },
        async sleep() {
          await adb.subprocess.noneProtocol
            .spawnWaitText(["input", "keyevent", "SLEEP"])
            .catch(() => undefined)
        },
        closed: sc.exited.catch(() => undefined),
      }
      video.sizeChanged(({ width, height }) => {
        stream.width = width
        stream.height = height
        for (const cb of sizeCbs) cb(width, height)
      })
      void video.stream
        .pipeTo(
          new WritableStream({
            write(p) {
              const pkt: VideoPacket =
                p.type === "configuration"
                  ? { type: "configuration", data: p.data }
                  : { type: "data", keyframe: !!p.keyframe, pts: p.pts, data: p.data }
              for (const cb of packetCbs) cb(pkt)
            },
          }),
        )
        .catch(() => undefined)
      return stream
    },
  }
}

/** Fake (modo simulado): sem vídeo; manda um contador e guarda os comandos recebidos. */
export function fakeScreenSource(): ScreenSource & { inputs: string[] } {
  const inputs: string[] = []
  return {
    fake: true,
    inputs,
    async open(ep) {
      let done: () => void = () => undefined
      const closed = new Promise<void>((r) => (done = r))
      const packetCbs: Array<(p: VideoPacket) => void> = []
      let n = 0
      const timer = setInterval(() => {
        n++
        const data = new TextEncoder().encode(`fake:${ep.serial}:${n}`)
        for (const cb of packetCbs) cb({ type: "data", keyframe: n % 4 === 1, pts: BigInt(n), data })
      }, 250)
      return {
        width: 360,
        height: 800,
        onPacket: (cb) => void packetCbs.push(cb),
        onSize: () => undefined,
        async touch(action, x, y) {
          inputs.push(`${ep.serial} touch ${action} ${x.toFixed(2)},${y.toFixed(2)}`)
        },
        async key(k) {
          inputs.push(`${ep.serial} key ${k}`)
        },
        async close() {
          clearInterval(timer)
          done()
        },
        async sleep() {
          inputs.push(`${ep.serial} sleep`)
        },
        closed,
      }
    },
  }
}
