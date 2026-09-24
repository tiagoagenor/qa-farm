"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { getJson } from "@/lib/client"

/** Busca `url` a cada `intervalMs` (pausa com a aba escondida). `url = null` desliga. */
export function usePoll<T>(url: string | null, intervalMs: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const alive = useRef(true)

  const load = useCallback(async () => {
    if (!url) return
    try {
      const d = await getJson<T>(url)
      if (!alive.current) return
      setData(d)
      setError(null)
    } catch (e) {
      if (alive.current) setError((e as Error).message)
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [url])

  useEffect(() => {
    alive.current = true
    if (!url) return
    void load()
    const t = setInterval(() => {
      if (!document.hidden) void load()
    }, intervalMs)
    const onVis = () => {
      if (!document.hidden) void load()
    }
    document.addEventListener("visibilitychange", onVis)
    return () => {
      alive.current = false
      clearInterval(t)
      document.removeEventListener("visibilitychange", onVis)
    }
  }, [url, intervalMs, load])

  return { data, error, loading, reload: load }
}
