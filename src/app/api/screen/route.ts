import { ScreenStateSchema } from "@/core/screen-protocol"
import { readJson } from "@/core/store"
import { ctx } from "@/server/web/context"
import { json, noStore } from "@/server/web/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Tela ao vivo: limite, celulares transmitindo e a porta do serviço (alive = serviço respondeu há < 30 s). */
export async function GET() {
  const s = await readJson(ctx().p.screen, ScreenStateSchema.nullable(), null)
  const alive = !!s && Date.now() - Date.parse(s.updatedAt) < 30_000
  return json(
    {
      alive,
      max: s?.max ?? 0,
      used: s?.sessions.length ?? 0,
      sessions: s?.sessions ?? [],
      port: s?.port ?? 3001,
    },
    noStore,
  )
}
