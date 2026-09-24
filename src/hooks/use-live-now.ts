"use client"

import { useEffect, useState } from "react"

/**
 * "Agora" que avança a cada segundo no navegador, alinhado ao relógio do servidor.
 * `serverNow` vem de cada resposta da API: a diferença para o relógio local é corrigida, então o
 * contador não pula quando o relógio do computador está adiantado/atrasado. `active = false` para de contar.
 */
export function useLiveNow(serverNow: string | undefined, active: boolean, intervalMs = 1000): number {
  const [offset, setOffset] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = serverNow ? Date.parse(serverNow) : NaN
    if (Number.isFinite(t)) setOffset(t - Date.now())
    setNow(Date.now())
  }, [serverNow])

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])

  return now + offset
}
