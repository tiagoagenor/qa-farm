import { readMetrics } from "@/server/web/data"
import { json, noStore } from "@/server/web/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return json(await readMetrics(), noStore)
}
