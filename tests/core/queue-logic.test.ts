import { describe, expect, it } from "vitest"

import {
  applyResult,
  buildQueue,
  cancelQueue,
  failedTestIds,
  minTheoreticalSec,
  nextItemStatus,
  queueElapsedSec,
  reopenItem,
  summarize,
} from "@/core/queue-logic"
import { attempt, entry, item, queue } from "../helpers/builders"

const NOW = new Date("2026-09-24T10:00:00.000Z")

describe("buildQueue", () => {
  it("cria um item por caso do catálogo, na ordem pedida", () => {
    // Arrange
    const a = entry("CT_A", { accounts: ["usuario_a"] })
    const b = entry("CT_B")
    const catalog = new Map([
      [a.id, a],
      [b.id, b],
    ])
    const input = { name: "f", appId: "app", env: "hml" as const, timeoutSec: 60, retries: 0, testIds: [b.id, a.id] }

    // Act
    const { queue: q } = buildQueue("queue_x", input, catalog, NOW)

    // Assert
    expect(q.items.map((i) => [i.id, i.name, i.accounts])).toEqual([
      ["i0001", "CT_B", []],
      ["i0002", "CT_A", ["usuario_a"]],
    ])
  })

  it("ignora ids repetidos e informa os desconhecidos", () => {
    // Arrange
    const a = entry("CT_A")
    const catalog = new Map([[a.id, a]])
    const input = { name: "f", appId: "app", env: "hml" as const, timeoutSec: 60, retries: 0, testIds: [a.id, a.id, "x::y"] }

    // Act
    const { queue: q, missing } = buildQueue("queue_x", input, catalog, NOW)

    // Assert
    expect([q.items.length, missing]).toEqual([1, ["x::y"]])
  })
})

describe("nextItemStatus", () => {
  it("infra_error volta para a fila enquanto houver re-enfileiramentos", () => {
    // Arrange
    const it0 = item("A", [], { infraRequeues: 2 })

    // Act
    const next = nextItemStatus(it0, "infra_error", 0)

    // Assert
    expect(next).toEqual({ status: "queued", infraRequeues: 3, failRetries: 0 })
  })

  it("infra_error vira final depois de 3 re-enfileiramentos", () => {
    // Arrange
    const it0 = item("A", [], { infraRequeues: 3 })

    // Act
    const next = nextItemStatus(it0, "infra_error", 0)

    // Assert
    expect(next.status).toBe("infra_error")
  })

  it("falha com retries disponíveis volta para a fila", () => {
    // Arrange
    const it0 = item("A")

    // Act
    const next = nextItemStatus(it0, "failed", 1)

    // Assert
    expect(next).toEqual({ status: "queued", infraRequeues: 0, failRetries: 1 })
  })

  it("timeout sem retries é final", () => {
    // Arrange
    const it0 = item("A")

    // Act
    const next = nextItemStatus(it0, "timeout", 0)

    // Assert
    expect(next.status).toBe("timeout")
  })

  it("config_error é final mesmo com retries", () => {
    // Arrange
    const it0 = item("A")

    // Act
    const next = nextItemStatus(it0, "config_error", 3)

    // Assert
    expect(next.status).toBe("config_error")
  })
})

describe("applyResult", () => {
  it("fecha a tentativa e conclui a fila quando é o último item", () => {
    // Arrange
    const q = queue([item("A", [], { status: "running", attempts: [attempt({ n: 1 })] })])
    const res = { status: "passed" as const, screenshots: [], hasOutputXml: true }

    // Act
    const out = applyResult(q, "A", 1, res, NOW)

    // Assert
    expect([out.items[0].status, out.items[0].attempts[0].endedAt, out.status]).toEqual([
      "passed",
      NOW.toISOString(),
      "done",
    ])
  })

  it("guarda a mensagem de erro, a de teardown e os prints na tentativa", () => {
    // Arrange
    const q = queue([item("A", [], { status: "running", attempts: [attempt({ n: 1 })] })])
    const res = { status: "failed" as const, message: "boom", teardownMessage: "td", screenshots: ["f.png"], hasOutputXml: true }

    // Act
    const out = applyResult(q, "A", 1, res, NOW)

    // Assert
    expect(out.items[0].attempts[0]).toMatchObject({ status: "failed", message: "boom", teardownMessage: "td", screenshots: ["f.png"] })
  })

  it("item de fila cancelada termina como cancelado", () => {
    // Arrange
    const q = queue([item("A", [], { status: "running", attempts: [attempt({ n: 1 })] })], { status: "canceled" })
    const res = { status: "failed" as const, screenshots: [], hasOutputXml: false }

    // Act
    const out = applyResult(q, "A", 1, res, NOW)

    // Assert
    expect([out.items[0].status, out.status]).toEqual(["canceled", "canceled"])
  })
})

describe("cancelQueue", () => {
  it("cancela os itens em espera e mantém os que estão rodando", () => {
    // Arrange
    const q = queue([item("A", [], { status: "running" }), item("B"), item("C", [], { status: "passed" })])

    // Act
    const out = cancelQueue(q, NOW)

    // Assert
    expect(out.items.map((i) => i.status)).toEqual(["running", "canceled", "passed"])
  })
})

describe("summarize", () => {
  it("conta status e calcula o progresso", () => {
    // Arrange
    const q = queue([item("A", [], { status: "passed" }), item("B", [], { status: "failed" }), item("C")])

    // Act
    const s = summarize(q)

    // Assert
    expect([s.counts.passed, s.counts.failed, s.counts.queued, s.finished, s.progress]).toEqual([1, 1, 1, 2, 2 / 3])
  })

  it("média, menor e maior duração consideram só tentativas concluídas com passou/falhou", () => {
    // Arrange
    const a1 = attempt({ startedAt: "2026-09-24T10:00:00.000Z", endedAt: "2026-09-24T10:01:00.000Z", status: "passed" })
    const a2 = attempt({ startedAt: "2026-09-24T10:00:00.000Z", endedAt: "2026-09-24T10:03:00.000Z", status: "failed" })
    const a3 = attempt({ startedAt: "2026-09-24T10:00:00.000Z", endedAt: "2026-09-24T10:59:00.000Z", status: "timeout" })
    const q = queue([item("A", [], { attempts: [a1, a2, a3] })])

    // Act
    const s = summarize(q)

    // Assert
    expect([s.avgDurationSec, s.minDurationSec, s.maxDurationSec]).toEqual([120, 60, 180])
  })

  it("sem casos terminados não há média, mínimo nem máximo", () => {
    // Arrange
    const q = queue([item("A")])

    // Act
    const s = summarize(q)

    // Assert
    expect([s.avgDurationSec, s.minDurationSec, s.maxDurationSec]).toEqual([null, null, null])
  })
})

describe("queueElapsedSec", () => {
  it("fila ativa conta da criação até agora", () => {
    // Arrange
    const q = { createdAt: "2026-09-24T10:00:00.000Z", finishedAt: undefined }

    // Act
    const sec = queueElapsedSec(q, Date.parse("2026-09-24T10:02:30.000Z"))

    // Assert
    expect(sec).toBe(150)
  })

  it("fila terminada para de contar no fim", () => {
    // Arrange
    const q = { createdAt: "2026-09-24T10:00:00.000Z", finishedAt: "2026-09-24T10:01:00.000Z" }

    // Act
    const sec = queueElapsedSec(q, Date.parse("2026-09-24T12:00:00.000Z"))

    // Assert
    expect(sec).toBe(60)
  })
})

describe("minTheoreticalSec", () => {
  it("é limitado pela conta mais carregada", () => {
    // Arrange
    const items = [
      ...Array.from({ length: 10 }, () => ({ accounts: ["usuario_x"], status: "queued" as const })),
      ...Array.from({ length: 5 }, () => ({ accounts: [], status: "queued" as const })),
    ]

    // Act
    const sec = minTheoreticalSec(items, 15, 60)

    // Assert
    expect(sec).toBe(600)
  })

  it("é limitado pelo número de celulares quando não há conflito", () => {
    // Arrange
    const items = Array.from({ length: 30 }, () => ({ accounts: [], status: "queued" as const }))

    // Act
    const sec = minTheoreticalSec(items, 15, 60)

    // Assert
    expect(sec).toBe(120)
  })
})

describe("failedTestIds", () => {
  it("inclui falhas, timeouts e erros de infra", () => {
    // Arrange
    const q = queue([
      item("A", [], { status: "failed", testId: "t:A" }),
      item("B", [], { status: "timeout", testId: "t:B" }),
      item("C", [], { status: "infra_error", testId: "t:C" }),
      item("D", [], { status: "passed", testId: "t:D" }),
      item("E", [], { status: "config_error", testId: "t:E" }),
    ])

    // Act
    const ids = failedTestIds(q)

    // Assert
    expect(ids).toEqual(["t:A", "t:B", "t:C"])
  })
})

describe("reopenItem", () => {
  it("caso que falhou volta para a fila e a fila concluída volta a rodar", () => {
    // Arrange
    const q = queue(
      [item("A", [], { status: "failed", failRetries: 1, attempts: [attempt({ status: "failed" })] }), item("B", [], { status: "passed" })],
      { status: "done", finishedAt: NOW.toISOString() },
    )

    // Act
    const out = reopenItem(q, "A")!

    // Assert
    expect([out.status, out.finishedAt, out.items[0].status, out.items[0].failRetries, out.items[0].attempts.length, out.items[1].status]).toEqual([
      "running",
      undefined,
      "queued",
      0,
      1,
      "passed",
    ])
  })

  it.each(["timeout", "infra_error", "config_error"] as const)("aceita caso com status %s", (status) => {
    // Arrange
    const q = queue([item("A", [], { status })], { status: "done" })

    // Act
    const out = reopenItem(q, "A")

    // Assert
    expect(out?.items[0].status).toBe("queued")
  })

  it.each(["passed", "running", "queued"] as const)("recusa caso com status %s", (status) => {
    // Arrange
    const q = queue([item("A", [], { status })])

    // Act
    const out = reopenItem(q, "A")

    // Assert
    expect(out).toBeNull()
  })
})
