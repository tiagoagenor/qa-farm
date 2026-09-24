import { describe, expect, it } from "vitest"

import { type ColumnDef, clampWidth, parseColumnPrefs, setWidth, toggleHidden, visibleColumns } from "@/lib/table-columns"

const DEFS: ColumnDef[] = [
  { key: "status", label: "Status", width: 140 },
  { key: "caso", label: "Caso", width: 340, hideable: false },
  { key: "erro", label: "Erro", width: 320 },
]

describe("parseColumnPrefs", () => {
  it("ignora colunas que não existem mais e não deixa esconder a coluna fixa", () => {
    // Arrange
    const raw = JSON.stringify({ hidden: ["erro", "caso", "velha"], widths: { status: 99999, velha: 10 } })

    // Act
    const prefs = parseColumnPrefs(raw, DEFS)

    // Assert
    expect(prefs).toEqual({ hidden: ["erro"], widths: { status: 1600 } })
  })

  it("texto inválido volta ao padrão", () => {
    // Arrange
    const raw = "{quebrado"

    // Act
    const prefs = parseColumnPrefs(raw, DEFS)

    // Assert
    expect(prefs).toEqual({ hidden: [], widths: {} })
  })
})

describe("visibleColumns", () => {
  it("tira as escondidas e usa a largura escolhida ou a padrão", () => {
    // Arrange
    const prefs = { hidden: ["status"], widths: { erro: 500 } }

    // Act
    const cols = visibleColumns(DEFS, prefs).map((c) => `${c.key}:${c.px}`)

    // Assert
    expect(cols).toEqual(["caso:340", "erro:500"])
  })
})

describe("toggleHidden / setWidth", () => {
  it("esconder duas vezes volta a mostrar", () => {
    // Arrange
    const prefs = { hidden: [], widths: {} }

    // Act
    const twice = toggleHidden(toggleHidden(prefs, "erro"), "erro")

    // Assert
    expect(twice.hidden).toEqual([])
  })

  it("largura tem mínimo e null volta ao padrão", () => {
    // Arrange
    const prefs = setWidth({ hidden: [], widths: {} }, "erro", 5)

    // Act
    const reset = setWidth(prefs, "erro", null)

    // Assert
    expect([prefs.widths.erro, reset.widths.erro, clampWidth(Number.NaN)]).toEqual([40, undefined, 40])
  })
})
