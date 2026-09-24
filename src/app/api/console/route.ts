import path from "node:path"

import { isSafeId } from "@/core/ids"
import { isSafeItemId } from "@/core/queue-logic"
import { readConsole, runsPath } from "@/server/web/data"
import { error, json, noStore } from "@/server/web/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Trecho do console.log de uma tentativa a partir de um offset (polling do log ao vivo). */
export async function GET(req: Request) {
  const u = new URL(req.url)
  const q = u.searchParams.get("queue") ?? ""
  const i = u.searchParams.get("item") ?? ""
  const n = Number(u.searchParams.get("attempt") ?? "1")
  const offset = Number(u.searchParams.get("offset") ?? "0")
  if (!isSafeId(q) || !isSafeItemId(i) || !Number.isInteger(n) || n < 1 || n > 100) return error("Parâmetros inválidos", 400)
  const file = path.join(runsPath(q, i, `a${n}`), "console.log")
  return json(await readConsole(file, Number.isFinite(offset) ? offset : 0), noStore)
}
