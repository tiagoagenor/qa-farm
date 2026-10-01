import { json, noStore } from "@/server/web/http"
import { readGiat } from "@/server/web/giat"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return json(await readGiat(), noStore)
}
