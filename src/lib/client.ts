"use client"

import { toast } from "sonner"

import type { Command, CommandResult } from "@/core/types"

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init })
  if (r.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`
    throw new Error("Não autenticado")
  }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `Erro ${r.status}`)
  return data as T
}

const COMMAND_TIMEOUT_MS = 30_000

/**
 * Envia um comando ao runner e espera o resultado (polling de 1 s).
 * Mostra um toast com o desfecho. Retorna o resultado ou null se o runner não respondeu.
 */
export async function sendCommand(command: Command, opts: { quiet?: boolean } = {}): Promise<CommandResult | null> {
  let id: string
  try {
    id = (await getJson<{ id: string }>("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    })).id
  } catch (e) {
    toast.error((e as Error).message)
    return null
  }
  const deadline = Date.now() + COMMAND_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    const res = await getJson<{ status: string; result: CommandResult | null }>(`/api/commands/${id}`).catch(() => null)
    if (res?.status === "done" && res.result) {
      if (res.result.ok) {
        if (!opts.quiet) toast.success(res.result.message)
      } else toast.error(res.result.message)
      return res.result
    }
  }
  toast.error("O runner não respondeu em 30 s. Veja se ele está rodando (banner no topo).")
  return null
}
