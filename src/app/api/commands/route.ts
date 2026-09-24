import { CommandSchema } from "@/core/types"
import { createCommand } from "@/server/web/data"
import { error, json } from "@/server/web/http"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const parsed = CommandSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return error(`Comando inválido: ${parsed.error.issues[0]?.message ?? ""}`, 400)
  const id = await createCommand(parsed.data)
  return json({ id }, 202)
}
