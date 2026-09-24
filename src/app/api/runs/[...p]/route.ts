import fs from "node:fs"
import fsp from "node:fs/promises"
import { Readable } from "node:stream"

import { contentTypeFor, safeJoin } from "@/core/paths"
import { ctx } from "@/server/web/context"
import { error } from "@/server/web/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Serve arquivos das execuções preservando a estrutura (links relativos do log.html funcionam). */
export async function GET(_req: Request, { params }: { params: Promise<{ p: string[] }> }) {
  const { p } = await params
  const file = safeJoin(ctx().p.runs, p)
  if (!file) return error("Caminho inválido", 400)
  const st = await fsp.stat(file).catch(() => null)
  if (!st?.isFile()) return error("Arquivo não encontrado", 404)
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream
  return new Response(stream, {
    headers: {
      "Content-Type": contentTypeFor(file),
      "Content-Length": String(st.size),
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=60",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
