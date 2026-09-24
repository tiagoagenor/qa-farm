import { readCatalog, runnerStatus } from "@/server/web/data"
import { json, noStore } from "@/server/web/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const [catalog, runner] = await Promise.all([readCatalog(), runnerStatus()])
  return json(
    {
      status: runner.state?.catalogStatus ?? (catalog ? "ready" : "missing"),
      error: runner.state?.catalogError ?? null,
      generatedAt: catalog?.generatedAt ?? null,
      total: catalog?.total ?? 0,
      entries: catalog?.entries ?? [],
    },
    noStore,
  )
}
