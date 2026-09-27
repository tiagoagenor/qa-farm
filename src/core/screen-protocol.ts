import { z } from "zod"

// Tela ao vivo (scrcpy no painel): mensagens navegador ↔ serviço de tela e o controle das sessões.
// Uma "sessão" = um celular transmitindo (vários espectadores do mesmo celular dividem a mesma sessão).

export const SCREEN_CLOSE_LIMIT = 4429
export const SCREEN_CLOSE_AUTH = 4401
export const SCREEN_CLOSE_DEVICE = 4404
export const SCREEN_CLOSE_IDLE = 4408

/** Mensagens do navegador (validadas no servidor; coordenadas normalizadas 0..1). */
export const ClientMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("touch"),
    action: z.enum(["down", "move", "up"]),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
  z.object({ t: z.literal("key"), key: z.enum(["back", "home", "app_switch"]) }),
  z.object({ t: z.literal("control"), on: z.boolean() }),
  z.object({ t: z.literal("ping") }),
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>

/** Mensagens de texto do servidor. */
export type ServerMessage =
  | { t: "hello"; device: string; fake: boolean; busy: boolean; controlling: boolean; viewers: number }
  | { t: "size"; width: number; height: number }
  | { t: "controller"; you: boolean; other: boolean }
  | { t: "fake"; n: number }
  | { t: "error"; message: string }

// ------------------------------------------------------------ vídeo (binário) ---
/** Pacote de vídeo do scrcpy: configuração (SPS/PPS) ou quadro (chave ou não). */
export interface VideoPacket {
  type: "configuration" | "data"
  keyframe?: boolean
  pts?: bigint
  data: Uint8Array
}

/** [tipo u8: 0 config, 1 quadro-chave, 2 quadro][pts i64 BE][dados] */
export function encodeVideoPacket(p: VideoPacket): Uint8Array {
  const out = new Uint8Array(9 + p.data.length)
  out[0] = p.type === "configuration" ? 0 : p.keyframe ? 1 : 2
  new DataView(out.buffer).setBigInt64(1, p.pts ?? BigInt(0))
  out.set(p.data, 9)
  return out
}

export function decodeVideoPacket(buf: Uint8Array): VideoPacket | null {
  if (buf.length < 9 || buf[0] > 2) return null
  const pts = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getBigInt64(1)
  const data = buf.slice(9)
  if (buf[0] === 0) return { type: "configuration", data }
  return { type: "data", keyframe: buf[0] === 1, pts, data }
}

// ------------------------------------------------------------ limite de sessões ---
/**
 * Controle das sessões abertas (sem E/S). O limite vale por CELULAR transmitindo: um segundo espectador do
 * mesmo celular não conta. `max` 0 = tela ao vivo desligada.
 */
export class ScreenSessions {
  private devices = new Map<string, { viewers: Set<string>; startedAt: string; controller: string | null }>()

  constructor(private readonly max: () => number) {}

  get used(): number {
    return this.devices.size
  }

  /** Pode abrir/entrar neste celular agora? */
  canJoin(device: string): { ok: true } | { ok: false; reason: string } {
    if (this.devices.has(device)) return { ok: true }
    const max = this.max()
    if (max <= 0) return { ok: false, reason: "Tela ao vivo desligada (limite 0 em Máquinas)" }
    if (this.devices.size >= max)
      return { ok: false, reason: `Limite de ${max} celular(es) ao vivo ao mesmo tempo atingido` }
    return { ok: true }
  }

  /** Registra o espectador; true = celular novo (precisa iniciar a transmissão). */
  join(device: string, viewer: string, now = new Date()): boolean {
    const cur = this.devices.get(device)
    if (cur) {
      cur.viewers.add(viewer)
      return false
    }
    this.devices.set(device, { viewers: new Set([viewer]), startedAt: now.toISOString(), controller: null })
    return true
  }

  /** Tira o espectador; true = era o último (encerrar a transmissão). */
  leave(device: string, viewer: string): boolean {
    const cur = this.devices.get(device)
    if (!cur) return false
    cur.viewers.delete(viewer)
    if (cur.controller === viewer) cur.controller = null
    if (cur.viewers.size) return false
    this.devices.delete(device)
    return true
  }

  /** Um controlador por celular: pedir controle tira de quem tinha. */
  setControl(device: string, viewer: string, on: boolean): string | null {
    const cur = this.devices.get(device)
    if (!cur || !cur.viewers.has(viewer)) return null
    if (on) cur.controller = viewer
    else if (cur.controller === viewer) cur.controller = null
    return cur.controller
  }

  controller(device: string): string | null {
    return this.devices.get(device)?.controller ?? null
  }

  viewers(device: string): string[] {
    return [...(this.devices.get(device)?.viewers ?? [])]
  }

  list(): Array<{ device: string; viewers: number; startedAt: string; controlling: boolean }> {
    return [...this.devices.entries()].map(([device, d]) => ({
      device,
      viewers: d.viewers.size,
      startedAt: d.startedAt,
      controlling: !!d.controller,
    }))
  }
}

/** state/screen.json — gravado pelo serviço de tela. */
export const ScreenStateSchema = z.object({
  updatedAt: z.string(),
  max: z.number(),
  port: z.number(),
  sessions: z.array(
    z.object({ device: z.string(), viewers: z.number(), startedAt: z.string(), controlling: z.boolean() }),
  ),
})
export type ScreenState = z.infer<typeof ScreenStateSchema>
