import type { Item } from "@/core/types"

import type { TreeEntry } from "./catalog-tree"

/** Item da fila no formato da árvore (mesma estrutura de pastas da página Testes). */
export type QueueTreeEntry = TreeEntry & { item: Item }

export function queueTreeEntries(items: Item[]): QueueTreeEntry[] {
  return items.map((item, i) => ({
    id: item.id,
    folder: item.file.includes("/") ? item.file.slice(0, item.file.lastIndexOf("/")) : "scenarios",
    file: item.file,
    line: i, // mantém a ordem da fila dentro do arquivo
    item,
  }))
}

export interface GroupStats {
  passed: number
  failed: number
  running: number
  queued: number
  other: number
}

/** Contagem por situação dos casos de uma pasta/arquivo (falha = falhou, timeout, infra ou configuração). */
export function groupStats(ids: string[], byId: ReadonlyMap<string, Pick<Item, "status">>): GroupStats {
  const s: GroupStats = { passed: 0, failed: 0, running: 0, queued: 0, other: 0 }
  for (const id of ids) {
    const st = byId.get(id)?.status
    if (st === "passed") s.passed++
    else if (st === "failed" || st === "timeout" || st === "infra_error" || st === "config_error") s.failed++
    else if (st === "running") s.running++
    else if (st === "queued") s.queued++
    else s.other++
  }
  return s
}
