import { isSafeId } from "@/core/ids"
import { commandResult } from "@/server/web/data"
import { error, isAuthed, json, noStore } from "@/server/web/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed())) return error("Não autenticado", 401)
  const { id } = await params
  if (!isSafeId(id)) return error("Comando não encontrado", 404)
  return json(await commandResult(id), noStore)
}
