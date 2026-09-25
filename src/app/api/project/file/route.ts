import { error, json, noStore } from "@/server/web/http"
import { readProjectFile } from "@/server/web/project"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const rel = new URL(req.url).searchParams.get("path") ?? ""
  const file = rel ? await readProjectFile(rel) : null
  return file ? json(file, noStore) : error("Arquivo não encontrado ou não permitido", 404)
}
