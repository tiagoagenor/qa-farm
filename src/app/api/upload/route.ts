import { ctx } from "@/server/web/context"
import { error, isAuthed, json } from "@/server/web/http"
import { receiveApk } from "@/server/web/upload"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 900

export async function POST(req: Request) {
  if (!(await isAuthed())) return error("Não autenticado", 401)
  if (!req.body) return error("Envie o arquivo no corpo da requisição", 400)
  const name = new URL(req.url).searchParams.get("name") ?? "app.apk"
  const { p, ad } = ctx()
  const r = await receiveApk(req.body, name, { p, aapt2: ad.aapt2 })
  return r.ok ? json({ app: r.app }, 201) : json({ error: r.error, existingId: r.existingId }, r.status)
}
