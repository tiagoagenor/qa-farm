import { devicesState } from "@/server/web/data"
import { ctx } from "@/server/web/context"
import { error } from "@/server/web/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const cache = new Map<string, { at: number; png: Buffer }>()
const TTL_MS = 10_000

export async function GET(_req: Request, { params }: { params: Promise<{ serial: string }> }) {
  const { serial } = await params
  // só aparelhos que o adb listou (evita passar texto arbitrário ao adb)
  const known = (await devicesState()).devices.some((d) => d.serial === serial)
  if (!known) return error("Celular não encontrado", 404)
  const hit = cache.get(serial)
  let png = hit && Date.now() - hit.at < TTL_MS ? hit.png : null
  if (!png) {
    png = await ctx().ad.adb.screencap(serial)
    if (!png || png.length < 8) return error("Não foi possível capturar a tela", 502)
    cache.set(serial, { at: Date.now(), png })
  }
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Captured-At": String(cache.get(serial)?.at ?? Date.now()) },
  })
}
