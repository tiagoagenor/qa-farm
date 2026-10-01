import { error, json, noStore } from "@/server/web/http"
import { readProjectFile, projectFromParam, rootOf } from "@/server/web/project"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const rel = url.searchParams.get("path") ?? ""
  const root = rootOf(projectFromParam(url.searchParams.get("project")))
  const file = rel ? await readProjectFile(rel, root) : null
  return file ? json(file, noStore) : error("Arquivo não encontrado ou não permitido", 404)
}
