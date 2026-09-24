import { type NextRequest, NextResponse } from "next/server"

import { SESSION_COOKIE, verifySessionToken } from "@/core/auth"

export const config = {
  runtime: "nodejs",
  // upload fica de fora (corpo de ~250 MB não pode passar pelo middleware); ele checa a sessão no próprio handler
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/upload|api/auth/login|login).*)"],
}

export async function middleware(req: NextRequest) {
  const ok = await verifySessionToken(process.env.QAFARM_SECRET ?? "", req.cookies.get(SESSION_COOKIE)?.value)
  if (ok) return NextResponse.next()
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 })
  }
  const url = req.nextUrl.clone()
  url.pathname = "/login"
  url.search = req.nextUrl.pathname === "/" ? "" : `?next=${encodeURIComponent(req.nextUrl.pathname)}`
  return NextResponse.redirect(url)
}
