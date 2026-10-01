import { error, json, noStore } from "@/server/web/http"
import { listProjectDir, projectFromParam, rootOf } from "@/server/web/project"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const rel = url.searchParams.get("path") ?? ""
  const root = rootOf(projectFromParam(url.searchParams.get("project")))
  const entries = await listProjectDir(rel, root)
  return entries ? json({ path: rel, entries }, noStore) : error("Pasta não encontrada ou não permitida", 404)
}
