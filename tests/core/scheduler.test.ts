import { describe, expect, it } from "vitest"

import { schedule } from "@/core/scheduler"
import { attempt, device, item, queue } from "../helpers/builders"

describe("schedule", () => {
  it("atribui o primeiro item da fila ao celular livre", () => {
    // Arrange
    const q = queue([item("A"), item("B")])
    const livres = [device("emulator-5554")]

    // Act
    const result = schedule([q], livres, [])

    // Assert
    expect(result).toEqual([{ queueId: q.id, itemId: "A", serial: "emulator-5554" }])
  })

  it("distribui um item diferente para cada celular livre", () => {
    // Arrange
    const q = queue([item("A"), item("B"), item("C")])
    const livres = [device("emulator-5554"), device("emulator-5556")]

    // Act
    const result = schedule([q], livres, [])

    // Assert
    expect(result.map((a) => [a.itemId, a.serial])).toEqual([
      ["A", "emulator-5554"],
      ["B", "emulator-5556"],
    ])
  })

  it("não inicia 2 casos com a mesma conta ao mesmo tempo", () => {
    // Arrange
    const q = queue([item("A", ["usuario_pix"]), item("B", ["usuario_pix"]), item("C")])
    const running = [{ queueId: q.id, itemId: "A", serial: "emulator-5554", accounts: ["usuario_pix"] }]
    const qRodando = { ...q, items: q.items.map((i) => (i.id === "A" ? { ...i, status: "running" as const } : i)) }

    // Act
    const result = schedule([qRodando], [device("emulator-5556")], running)

    // Assert
    expect(result).toEqual([{ queueId: q.id, itemId: "C", serial: "emulator-5556" }])
  })

  it("não atribui dois itens da mesma conta na mesma rodada", () => {
    // Arrange
    const q = queue([item("A", ["usuario_x"]), item("B", ["usuario_x"])])
    const livres = [device("emulator-5554"), device("emulator-5556")]

    // Act
    const result = schedule([q], livres, [])

    // Assert
    expect(result.map((a) => a.itemId)).toEqual(["A"])
  })

  it("prioriza a conta com mais casos pendentes", () => {
    // Arrange
    const q = queue([item("A", ["usuario_x"]), item("B", ["usuario_y"]), item("C", ["usuario_y"])])

    // Act
    const [primeira] = schedule([q], [device("emulator-5554")], [])

    // Assert
    expect(primeira.itemId).toBe("B")
  })

  it("itens sem conta ficam depois dos que têm conta", () => {
    // Arrange
    const q = queue([item("SEM"), item("COM", ["usuario_z"])])

    // Act
    const [primeira] = schedule([q], [device("emulator-5554")], [])

    // Assert
    expect(primeira.itemId).toBe("COM")
  })

  it("fila mais antiga tem prioridade", () => {
    // Arrange
    const nova = queue([item("N1")], { id: "queue_20260924-120000_bbbbbb", createdAt: "2026-09-24T12:00:00.000Z" })
    const antiga = queue([item("A1")], { id: "queue_20260924-090000_aaaaaa", createdAt: "2026-09-24T09:00:00.000Z" })

    // Act
    const [primeira] = schedule([nova, antiga], [device("emulator-5554")], [])

    // Assert
    expect(primeira.itemId).toBe("A1")
  })

  it("ignora filas pausadas e canceladas", () => {
    // Arrange
    const pausada = queue([item("P")], { status: "paused" })
    const cancelada = queue([item("C")], { status: "canceled" })

    // Act
    const result = schedule([pausada, cancelada], [device("emulator-5554")], [])

    // Assert
    expect(result).toEqual([])
  })

  it("ignora itens que não estão na fila de espera", () => {
    // Arrange
    const q = queue([item("OK", [], { status: "passed" }), item("R", [], { status: "running" })])

    // Act
    const result = schedule([q], [device("emulator-5554")], [])

    // Assert
    expect(result).toEqual([])
  })

  it("nova tentativa prefere um celular diferente do anterior", () => {
    // Arrange
    const q = queue([item("A", [], { attempts: [attempt({ serial: "emulator-5554", status: "failed" })] })])
    const livres = [device("emulator-5554"), device("emulator-5556")]

    // Act
    const [primeira] = schedule([q], livres, [])

    // Assert
    expect(primeira.serial).toBe("emulator-5556")
  })

  it("nova tentativa usa o mesmo celular quando é o único livre", () => {
    // Arrange
    const q = queue([item("A", [], { attempts: [attempt({ serial: "emulator-5554", status: "failed" })] })])

    // Act
    const [primeira] = schedule([q], [device("emulator-5554")], [])

    // Assert
    expect(primeira.serial).toBe("emulator-5554")
  })

  it("sem celulares livres não atribui nada", () => {
    // Arrange
    const q = queue([item("A")])

    // Act
    const result = schedule([q], [], [])

    // Assert
    expect(result).toEqual([])
  })

  it("fila com mesma conta liberada distribui em sequência para todos os celulares livres", () => {
    // Arrange
    const q = queue([item("A", ["usuario_x"]), item("B", ["usuario_x"]), item("C", ["usuario_x"])], {
      options: { timeoutSec: 60, retries: 0, allowSameAccount: true },
    })
    const livres = [device("emulator-5554"), device("emulator-5556"), device("emulator-5558")]

    // Act
    const result = schedule([q], livres, [])

    // Assert
    expect(result.map((a) => a.itemId)).toEqual(["A", "B", "C"])
  })

  it("fila com mesma conta liberada não espera a conta que já está rodando", () => {
    // Arrange
    const base = queue([item("A", ["usuario_x"]), item("B", ["usuario_x"])], {
      options: { timeoutSec: 60, retries: 0, allowSameAccount: true },
    })
    const q = { ...base, items: base.items.map((i) => (i.id === "A" ? { ...i, status: "running" as const } : i)) }
    const running = [{ queueId: q.id, itemId: "A", serial: "emulator-5554", accounts: ["usuario_x"] }]

    // Act
    const result = schedule([q], [device("emulator-5556")], running)

    // Assert
    expect(result).toEqual([{ queueId: q.id, itemId: "B", serial: "emulator-5556" }])
  })
})
