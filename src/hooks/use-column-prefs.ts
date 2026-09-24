"use client"

import { useCallback, useEffect, useState } from "react"

import {
  type ColumnDef,
  type ColumnPrefs,
  parseColumnPrefs,
  setWidth,
  toggleHidden,
} from "@/lib/table-columns"

/** Largura e visibilidade das colunas, lembradas neste navegador (localStorage; sem ele, só na sessão). */
export function useColumnPrefs(storageKey: string, defs: ColumnDef[]) {
  const [prefs, setPrefs] = useState<ColumnPrefs>({ hidden: [], widths: {} })

  useEffect(() => {
    let raw: string | null = null
    try {
      raw = window.localStorage.getItem(storageKey)
    } catch {}
    setPrefs(parseColumnPrefs(raw, defs))
    // defs é constante do módulo; só relê quando a chave muda
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  const save = useCallback(
    (next: ColumnPrefs) => {
      setPrefs(next)
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next))
      } catch {}
    },
    [storageKey],
  )

  return {
    prefs,
    toggle: (key: string) => save(toggleHidden(prefs, key)),
    resize: (key: string, width: number | null) => save(setWidth(prefs, key, width)),
    /** durante o arrasto: atualiza a tela sem gravar a cada pixel */
    preview: (key: string, width: number) => setPrefs((p) => setWidth(p, key, width)),
    commit: () => save(prefs),
    reset: () => save({ hidden: [], widths: {} }),
  }
}
