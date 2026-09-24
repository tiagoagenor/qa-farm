import { isSafeId } from "@/core/ids"
import { commandResult } from "@/server/web/data"
import { error, json, noStore } from "@/server/web/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isSafeId(id)) return error("Comando não encontrado", 404)
  return json(await commandResult(id), noStore)
}
