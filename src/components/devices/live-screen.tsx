"use client"

import { ArrowLeft, Circle, Loader2, Square } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  type ClientMessage,
  decodeVideoPacket,
  SCREEN_CLOSE_DEVICE,
  SCREEN_CLOSE_IDLE,
  SCREEN_CLOSE_LIMIT,
  type ServerMessage,
} from "@/core/screen-protocol"
import { usePoll } from "@/hooks/use-poll"

// Tela ao vivo (scrcpy) no navegador: vídeo H.264 decodificado em WebAssembly (funciona em http na rede local),
// toques e teclas só com "Controlar" ligado. Fecha sozinha: aba escondida por 30 s ou 10 min sem mexer.

export interface ScreenInfo {
  alive: boolean
  max: number
  used: number
  port: number
  sessions: Array<{ device: string; viewers: number }>
}

const HIDDEN_CLOSE_MS = 30_000
const IDLE_ASK_MS = 10 * 60_000
const IDLE_CLOSE_MS = 60_000

type Status = { kind: "connecting" } | { kind: "live" } | { kind: "closed"; message: string }

function closeMessage(code: number, reason: string): string {
  if (code === SCREEN_CLOSE_LIMIT)
    return reason || "Limite de celulares ao vivo atingido. Feche outra tela ou aumente o limite em Máquinas."
  if (code === SCREEN_CLOSE_DEVICE) return reason || "Celular indisponível para tela ao vivo."
  if (code === SCREEN_CLOSE_IDLE) return reason || "Tela encerrada por inatividade."
  if (code === 1006) return "Sem conexão com o serviço de tela (está rodando?)."
  return reason || "Tela encerrada."
}

export function LiveScreen({ serial, onClose }: { serial: string; onClose?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<Status>({ kind: "connecting" })
  const [fakeText, setFakeText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [control, setControl] = useState<{ you: boolean; other: boolean }>({ you: false, other: false })
  const [idleAsk, setIdleAsk] = useState(false)
  const lastInput = useRef(Date.now())
  const pressed = useRef(false)

  const send = useCallback((m: ClientMessage) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
  }, [])

  useEffect(() => {
    let disposed = false
    let decoder: { writable: WritableStream<unknown>; dispose(): void } | null = null
    let writer: WritableStreamDefaultWriter<unknown> | null = null
    const pending: unknown[] = []
    let fake = false

    void (async () => {
      const info = (await fetch("/api/screen", { cache: "no-store" }).then((r) => r.json())) as ScreenInfo
      if (disposed) return
      if (!info.alive) return setStatus({ kind: "closed", message: "Serviço de tela ao vivo fora do ar." })
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:${info.port}/ws?device=${encodeURIComponent(serial)}`,
      )
      ws.binaryType = "arraybuffer"
      wsRef.current = ws
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          const m = JSON.parse(ev.data) as ServerMessage
          if (m.t === "hello") {
            fake = m.fake
            setBusy(m.busy)
            setStatus({ kind: "live" })
            if (!fake) {
              void import("@yume-chan/scrcpy-decoder-tinyh264").then(({ TinyH264Decoder }) => {
                if (disposed || !canvasRef.current) return
                const d = new TinyH264Decoder({ canvas: canvasRef.current })
                decoder = d as unknown as typeof decoder
                writer = (d.writable as unknown as WritableStream<unknown>).getWriter()
                for (const p of pending.splice(0)) void writer.write(p).catch(() => undefined)
              })
            }
          } else if (m.t === "controller") setControl({ you: m.you, other: m.other })
          else if (m.t === "error") setStatus({ kind: "closed", message: m.message })
          return
        }
        const pkt = decodeVideoPacket(new Uint8Array(ev.data as ArrayBuffer))
        if (!pkt) return
        if (fake) {
          setFakeText(new TextDecoder().decode(pkt.data))
          return
        }
        if (writer) void writer.write(pkt).catch(() => undefined)
        else if (pending.length < 120) pending.push(pkt)
      }
      ws.onclose = (ev) => {
        if (!disposed) setStatus({ kind: "closed", message: closeMessage(ev.code, ev.reason) })
      }
    })().catch(() => setStatus({ kind: "closed", message: "Não foi possível falar com o serviço de tela." }))

    const ping = setInterval(() => send({ t: "ping" }), 15_000)
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null
    const onVis = () => {
      if (document.hidden)
        hiddenTimer = setTimeout(() => wsRef.current?.close(1000, "aba escondida"), HIDDEN_CLOSE_MS)
      else if (hiddenTimer) clearTimeout(hiddenTimer)
    }
    document.addEventListener("visibilitychange", onVis)
    const idle = setInterval(() => {
      if (Date.now() - lastInput.current > IDLE_ASK_MS) setIdleAsk(true)
      if (Date.now() - lastInput.current > IDLE_ASK_MS + IDLE_CLOSE_MS)
        wsRef.current?.close(1000, "inatividade")
    }, 5000)

    return () => {
      disposed = true
      clearInterval(ping)
      clearInterval(idle)
      if (hiddenTimer) clearTimeout(hiddenTimer)
      document.removeEventListener("visibilitychange", onVis)
      wsRef.current?.close(1000, "fechado")
      wsRef.current = null
      try {
        decoder?.dispose()
      } catch {
        /* já descartado */
      }
    }
  }, [serial, send])

  const touched = () => {
    lastInput.current = Date.now()
    setIdleAsk(false)
  }

  /** Posição do ponteiro → 0..1 dentro da imagem (o canvas mantém a proporção dentro da caixa). */
  const norm = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget
    const r = c.getBoundingClientRect()
    const cw = c.width || 1
    const ch = c.height || 1
    const scale = Math.min(r.width / cw, r.height / ch)
    const w = cw * scale
    const h = ch * scale
    const x = (e.clientX - r.left - (r.width - w) / 2) / w
    const y = (e.clientY - r.top - (r.height - h) / 2) / h
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
  }
  const onPointer = (action: "down" | "move" | "up") => (e: React.PointerEvent<HTMLCanvasElement>) => {
    touched()
    if (!control.you) return
    if (action === "down") {
      pressed.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
    } else if (!pressed.current) return
    if (action === "up") pressed.current = false
    send({ t: "touch", action, ...norm(e) })
  }

  const toggleControl = (on: boolean) => {
    touched()
    if (
      on &&
      busy &&
      !window.confirm(
        "Um teste está rodando neste celular. Tocar na tela pode quebrar o caso. Controlar mesmo assim?",
      )
    )
      return
    send({ t: "control", on })
  }

  return (
    <div className="grid gap-3" data-testid="live-screen" data-status={status.kind}>
      <div className="relative mx-auto flex h-[65vh] w-full items-center justify-center overflow-hidden rounded-md border bg-black">
        {fakeText !== null ? (
          <p className="font-mono text-sm text-white" data-testid="live-fake">
            {fakeText}
          </p>
        ) : (
          <canvas
            ref={canvasRef}
            className={`h-full w-full object-contain ${control.you ? "cursor-pointer" : ""}`}
            style={{ touchAction: "none" }}
            onPointerDown={onPointer("down")}
            onPointerMove={onPointer("move")}
            onPointerUp={onPointer("up")}
            onPointerCancel={onPointer("up")}
            data-testid="live-canvas"
          />
        )}
        {status.kind === "connecting" && (
          <p className="absolute flex items-center gap-2 text-sm text-white">
            <Loader2 className="size-4 animate-spin" /> Conectando…
          </p>
        )}
        {status.kind === "closed" && (
          <p className="absolute max-w-xs text-center text-sm text-white" data-testid="live-closed">
            {status.message}
          </p>
        )}
        {idleAsk && status.kind === "live" && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-black/70 p-3 text-sm text-white">
            Ainda assistindo?{" "}
            <Button size="sm" onClick={touched}>
              Sim
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!control.you}
          onClick={() => (touched(), send({ t: "key", key: "back" }))}
          data-testid="live-back"
        >
          <ArrowLeft /> Voltar
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!control.you}
          onClick={() => (touched(), send({ t: "key", key: "home" }))}
          data-testid="live-home"
        >
          <Circle /> Início
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!control.you}
          onClick={() => (touched(), send({ t: "key", key: "app_switch" }))}
          data-testid="live-apps"
        >
          <Square /> Apps
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor="live-control" className="text-sm">
            Controlar
          </Label>
          <Switch
            id="live-control"
            checked={control.you}
            disabled={status.kind !== "live"}
            onCheckedChange={toggleControl}
            data-testid="live-control"
          />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        {control.you
          ? "Você está controlando: toques e botões vão para o celular."
          : control.other
            ? "Outra pessoa está controlando; você só assiste (ligar Controlar passa o controle para você)."
            : "Só assistindo. Ligue Controlar para tocar na tela."}
        {busy && " Há um teste rodando neste celular."}
        {onClose && (
          <Button variant="link" size="sm" className="h-auto p-0 pl-2 text-xs" onClick={onClose}>
            Fechar
          </Button>
        )}
      </p>
    </div>
  )
}

/** Diálogo "Ao vivo" com o uso do limite (ex.: 2/3 em uso). */
export function LiveScreenDialog({ serial, onClose }: { serial: string | null; onClose: () => void }) {
  const { data } = usePoll<ScreenInfo>(serial ? "/api/screen" : null, 5000)
  return (
    <Dialog open={!!serial} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ao vivo — {serial}</DialogTitle>
          <DialogDescription data-testid="live-usage">
            {data ? `${data.used}/${data.max} celular(es) ao vivo agora` : "…"} · fecha sozinha com a aba
            escondida ou sem uso
          </DialogDescription>
        </DialogHeader>
        {serial && <LiveScreen key={serial} serial={serial} />}
      </DialogContent>
    </Dialog>
  )
}
