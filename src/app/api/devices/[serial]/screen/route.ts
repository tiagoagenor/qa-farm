import { slotIdFromKey } from "@/core/browserstack"
import { bsRunningSession, devicesState, remoteDevice } from "@/server/web/data"
import { ctx } from "@/server/web/context"
import { error } from "@/server/web/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const cache = new Map<string, { at: number; png: Buffer }>()
const TTL_MS = 10_000
/** BrowserStack: cada print é um comando na sessão do teste (aparece no log dela) — cache curto, só manual */
const BS_TTL_MS = 3_000

export async function GET(_req: Request, { params }: { params: Promise<{ serial: string }> }) {
  const { serial } = await params
  // só aparelhos que o adb listou ou vagas do BrowserStack (evita passar texto arbitrário ao adb)
  const known = (await devicesState()).devices.some((d) => d.serial === serial)
  if (!known) return error("Celular não encontrado", 404)
  const cloud = slotIdFromKey(serial) !== null
  const hit = cache.get(serial)
  let png = hit && Date.now() - hit.at < (cloud ? BS_TTL_MS : TTL_MS) ? hit.png : null
  if (!png) {
    if (cloud) {
      const session = await bsRunningSession(serial)
      if (!session) {
        return error(
          "Sem caso rodando nesta vaga agora: o celular do BrowserStack só existe durante um caso.",
          409,
        )
      }
      png = await ctx().ad.browserstack.screenshot(session)
    } else {
      const remote = await remoteDevice(serial)
      png = remote ? await remote.client.screen(remote.serial) : await ctx().ad.adb.screencap(serial)
    }
    if (!png || png.length < 8) return error("Não foi possível capturar a tela", 502)
    cache.set(serial, { at: Date.now(), png })
  }
  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "X-Captured-At": String(cache.get(serial)?.at ?? Date.now()),
    },
  })
}
