import { type NextRequest, NextResponse } from "next/server"

import { SESSION_COOKIE, verifySessionToken } from "@/core/auth"

export const config = {
  runtime: "nodejs",
  // Rotas com corpo ficam de fora e checam a sessão no próprio handler: upload (~250 MB) e commands (fila grande).
  // Bug do Next 15.5: com middleware Node, corpo que chega em pedaços pela rede dá 500
  // ("Response body object should not be disturbed or locked") — fila de 400+ casos já passa disso.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/upload|api/commands|api/auth/login|login).*)"],
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
