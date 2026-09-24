import { devicesState, listQueues, queueSummary } from "@/server/web/data"
import { json, noStore } from "@/server/web/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const [queues, devices] = await Promise.all([listQueues(), devicesState()])
  const ready = devices.devices.filter((d) => d.kind === "emulator" && (d.state === "ready" || d.state === "busy")).length
  return json({ queues: queues.map((q) => queueSummary(q, ready)), serverNow: new Date().toISOString() }, noStore)
}
