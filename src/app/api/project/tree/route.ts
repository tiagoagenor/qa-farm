import { error, json, noStore } from "@/server/web/http"
import { listProjectDir } from "@/server/web/project"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const rel = new URL(req.url).searchParams.get("path") ?? ""
  const entries = await listProjectDir(rel)
  return entries ? json({ path: rel, entries }, noStore) : error("Pasta não encontrada ou não permitida", 404)
}
