import { describe, expect, it } from "vitest"

import type { Item } from "@/core/types"
import { buildTreeRows } from "@/lib/catalog-tree"
import { groupStats, queueTreeEntries } from "@/lib/queue-tree"

const item = (id: string, file: string, status: Item["status"]): Item => ({
  id,
  testId: `${file}::${id}`,
  name: id,
  fileLongName: `X.${id}`,
  file,
  accounts: [],
  status,
  infraRequeues: 0,
  failRetries: 0,
  attempts: [],
})

const ITEMS = [
  item("i0001", "scenarios/pix/envio/pixEnvio.robot", "passed"),
  item("i0002", "scenarios/login/login.robot", "failed"),
  item("i0003", "scenarios/pix/envio/pixEnvio.robot", "timeout"),
  item("i0004", "scenarios/pix/pixExtrato.robot", "running"),
]

describe("queueTreeEntries", () => {
  it("agrupa os itens da fila nas mesmas pastas e arquivos do projeto", () => {
    // Arrange
    const entries = queueTreeEntries(ITEMS)

    // Act
    const rows = buildTreeRows(entries, new Set(), true).map((r) => `${r.depth}:${r.kind}:${r.kind === "test" ? r.entry.id : r.name}`)

    // Assert
    expect(rows).toEqual([
      "0:folder:login",
      "1:file:login.robot",
      "2:test:i0002",
      "0:folder:pix",
      "1:folder:envio",
      "2:file:pixEnvio.robot",
      "3:test:i0001",
      "3:test:i0003",
      "1:file:pixExtrato.robot",
      "2:test:i0004",
    ])
  })
})

describe("groupStats", () => {
  it("conta passou, falhas (inclui timeout) e rodando de uma pasta", () => {
    // Arrange
    const byId = new Map(ITEMS.map((i) => [i.id, i]))

    // Act
    const s = groupStats(["i0001", "i0003", "i0004"], byId)

    // Assert
    expect(s).toEqual({ passed: 1, failed: 1, running: 1, queued: 0, other: 0 })
  })
})
