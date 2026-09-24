import { cookies } from "next/headers"
import { z } from "zod"

import { createSessionToken, passwordMatches, SESSION_COOKIE, SESSION_TTL_SEC } from "@/core/auth"
import { ctx } from "@/server/web/context"
import { error, json } from "@/server/web/http"

export const runtime = "nodejs"

const Body = z.object({ password: z.string().max(500) })

export async function POST(req: Request) {
  const { cfg } = ctx()
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return error("Senha inválida", 400)
  if (!cfg.secret || !cfg.password) return error("Painel sem senha configurada (QAFARM_PASSWORD/QAFARM_SECRET)", 500)
  if (!(await passwordMatches(cfg.secret, cfg.password, parsed.data.password))) {
    await new Promise((r) => setTimeout(r, 400)) // freia tentativa e erro
    return error("Senha incorreta", 401)
  }
  ;(await cookies()).set(SESSION_COOKIE, await createSessionToken(cfg.secret), {
    httpOnly: true,
    sameSite: "strict",
    secure: false, // painel roda em HTTP na rede interna
    path: "/",
    maxAge: SESSION_TTL_SEC,
  })
  return json({ ok: true })
}
