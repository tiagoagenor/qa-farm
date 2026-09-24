import { cookies } from "next/headers"

import { SESSION_COOKIE } from "@/core/auth"
import { json } from "@/server/web/http"

export const runtime = "nodejs"

export async function POST() {
  ;(await cookies()).delete(SESSION_COOKIE)
  return json({ ok: true })
}
