import "server-only"

import { cookies } from "next/headers"
import { NextResponse } from "next/server"

import { SESSION_COOKIE, verifySessionToken } from "@/core/auth"

import { ctx } from "./context"

export function json(data: unknown, init?: number | ResponseInit): NextResponse {
  return NextResponse.json(data, typeof init === "number" ? { status: init } : init)
}

export function error(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status })
}

/** Checagem de sessão para rotas fora do middleware (upload). */
export async function isAuthed(): Promise<boolean> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  return verifySessionToken(ctx().cfg.secret, token)
}

export const noStore = { headers: { "Cache-Control": "no-store" } }
