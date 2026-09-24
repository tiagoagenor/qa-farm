import { isSafeId } from "@/core/ids"
import { devicesState, queueSummary, readQueue, withLiveMassa } from "@/server/web/data"
import { error, json, noStore } from "@/server/web/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isSafeId(id)) return error("Fila não encontrada", 404)
  const [q, devices] = await Promise.all([readQueue(id), devicesState()])
  if (!q) return error("Fila não encontrada", 404)
  const ready = devices.devices.filter((d) => d.kind === "emulator" && (d.state === "ready" || d.state === "busy")).length
  return json({ summary: queueSummary(q, ready), queue: await withLiveMassa(q), serverNow: new Date().toISOString() }, noStore)
}
