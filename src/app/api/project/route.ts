import { json, noStore } from "@/server/web/http"
import { readProject } from "@/server/web/project"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return json(await readProject(), noStore)
}
