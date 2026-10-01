import { json, noStore } from "@/server/web/http"
import { projectFromParam, readProject } from "@/server/web/project"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  return json(await readProject(projectFromParam(new URL(req.url).searchParams.get("project"))), noStore)
}
