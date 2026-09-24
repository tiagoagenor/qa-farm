import { describe, expect, it } from "vitest"

import { filterEntries, folderOptions, tagOptions, toggleRange } from "@/lib/catalog-filter"
import { entry } from "../helpers/builders"

const E = [
  entry("CT_LOGIN_01-Login-valido", { folder: "scenarios/login", tags: ["regressivo_login_hml"], accounts: ["usuario_a"] }),
  entry("CT_PIX_01-Enviar-Pix", { folder: "scenarios/pix/envio", file: "scenarios/pix/envio/pix.robot", tags: ["regressivo_pix_hml", "smoke"] }),
  entry("CT_PIX_02-Extrato-Transação", { folder: "scenarios/pix/extrato", tags: ["regressivo_pix_hml"] }),
]
const none = { search: "", folders: new Set<string>(), tags: new Set<string>(), onlySelected: false }

describe("filterEntries", () => {
  it("busca por várias palavras, sem acento e sem diferenciar maiúsculas", () => {
    // Arrange
    const f = { ...none, search: "pix transacao" }

    // Act
    const out = filterEntries(E, f, new Set())

    // Assert
    expect(out.map((e) => e.name)).toEqual(["CT_PIX_02-Extrato-Transação"])
  })

  it("filtra por pasta incluindo subpastas", () => {
    // Arrange
    const f = { ...none, folders: new Set(["scenarios/pix"]) }

    // Act
    const out = filterEntries(E, f, new Set())

    // Assert
    expect(out).toHaveLength(2)
  })

  it("filtra por qualquer uma das tags", () => {
    // Arrange
    const f = { ...none, tags: new Set(["smoke", "regressivo_login_hml"]) }

    // Act
    const out = filterEntries(E, f, new Set())

    // Assert
    expect(out.map((e) => e.name)).toEqual(["CT_LOGIN_01-Login-valido", "CT_PIX_01-Enviar-Pix"])
  })

  it("encontra pela conta de teste", () => {
    // Arrange
    const f = { ...none, search: "usuario_a" }

    // Act
    const out = filterEntries(E, f, new Set())

    // Assert
    expect(out).toHaveLength(1)
  })

  it("'só selecionados' mostra apenas os marcados", () => {
    // Arrange
    const f = { ...none, onlySelected: true }

    // Act
    const out = filterEntries(E, f, new Set([E[2].id]))

    // Assert
    expect(out.map((e) => e.id)).toEqual([E[2].id])
  })
})

describe("folderOptions / tagOptions", () => {
  it("lista pastas de todos os níveis com contagem", () => {
    // Arrange
    const entries = E

    // Act
    const out = folderOptions(entries)

    // Assert
    expect(out).toEqual([
      { value: "scenarios/login", count: 1 },
      { value: "scenarios/pix", count: 2 },
      { value: "scenarios/pix/envio", count: 1 },
      { value: "scenarios/pix/extrato", count: 1 },
    ])
  })

  it("ordena tags pela quantidade de casos", () => {
    // Arrange
    const entries = E

    // Act
    const out = tagOptions(entries)

    // Assert
    expect(out[0]).toEqual({ value: "regressivo_pix_hml", count: 2 })
  })
})

describe("toggleRange", () => {
  it("clique simples alterna só o item", () => {
    // Arrange
    const selected = new Set<string>()

    // Act
    const out = toggleRange(selected, E, null, 1, false)

    // Assert
    expect([...out]).toEqual([E[1].id])
  })

  it("shift+clique marca o intervalo inteiro", () => {
    // Arrange
    const selected = new Set([E[0].id])

    // Act
    const out = toggleRange(selected, E, 0, 2, true)

    // Assert
    expect(out.size).toBe(3)
  })

  it("shift+clique num item marcado desmarca o intervalo", () => {
    // Arrange
    const selected = new Set(E.map((e) => e.id))

    // Act
    const out = toggleRange(selected, E, 0, 1, true)

    // Assert
    expect([...out]).toEqual([E[2].id])
  })
})
