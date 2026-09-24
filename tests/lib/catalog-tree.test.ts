import { describe, expect, it } from "vitest"

import { allGroupKeys, buildTreeRows, groupCheck, toggleGroup } from "@/lib/catalog-tree"
import { entry } from "../helpers/builders"

const E = [
  entry("CT_PIX_02", { folder: "scenarios/pix/envio", file: "scenarios/pix/envio/pixEnvio.robot", line: 20 }),
  entry("CT_PIX_01", { folder: "scenarios/pix/envio", file: "scenarios/pix/envio/pixEnvio.robot", line: 10 }),
  entry("CT_PIX_EXT", { folder: "scenarios/pix", file: "scenarios/pix/pixExtrato.robot", line: 5 }),
  entry("CT_LOGIN_01", { folder: "scenarios/login", file: "scenarios/login/login.robot", line: 8 }),
]

const view = (rows: ReturnType<typeof buildTreeRows>) =>
  rows.map((r) => `${"  ".repeat(r.depth)}${r.kind}:${r.kind === "test" ? r.entry.name : r.name}${r.kind === "test" ? "" : `(${r.ids.length})`}`)

describe("buildTreeRows", () => {
  it("fechada mostra só as pastas do primeiro nível com a contagem de casos", () => {
    // Arrange
    const expanded = new Set<string>()

    // Act
    const rows = buildTreeRows(E, expanded)

    // Assert
    expect(view(rows)).toEqual(["folder:login(1)", "folder:pix(3)"])
  })

  it("abrir uma pasta mostra subpastas e arquivos dela", () => {
    // Arrange
    const expanded = new Set(["scenarios/pix"])

    // Act
    const rows = buildTreeRows(E, expanded)

    // Assert
    expect(view(rows)).toEqual(["folder:login(1)", "folder:pix(3)", "  folder:envio(2)", "  file:pixExtrato.robot(1)"])
  })

  it("abrir o arquivo mostra os casos na ordem em que aparecem no arquivo", () => {
    // Arrange
    const expanded = new Set(["scenarios/pix", "scenarios/pix/envio", "scenarios/pix/envio/pixEnvio.robot"])

    // Act
    const rows = buildTreeRows(E, expanded)

    // Assert
    expect(view(rows).slice(2, 6)).toEqual(["  folder:envio(2)", "    file:pixEnvio.robot(2)", "      test:CT_PIX_01", "      test:CT_PIX_02"])
  })

  it("com busca/filtro ativo tudo aparece aberto", () => {
    // Arrange
    const filtered = E.filter((e) => e.name.startsWith("CT_PIX_0"))

    // Act
    const rows = buildTreeRows(filtered, new Set(), true)

    // Assert
    expect(view(rows)).toEqual(["folder:pix(2)", "  folder:envio(2)", "    file:pixEnvio.robot(2)", "      test:CT_PIX_01", "      test:CT_PIX_02"])
  })
})

describe("allGroupKeys", () => {
  it("lista pastas de todos os níveis e arquivos", () => {
    // Arrange
    const entries = E

    // Act
    const keys = allGroupKeys(entries).sort()

    // Assert
    expect(keys).toEqual([
      "scenarios/login",
      "scenarios/login/login.robot",
      "scenarios/pix",
      "scenarios/pix/envio",
      "scenarios/pix/envio/pixEnvio.robot",
      "scenarios/pix/pixExtrato.robot",
    ])
  })
})

describe("groupCheck / toggleGroup", () => {
  it("grupo parcialmente selecionado fica indeterminado", () => {
    // Arrange
    const ids = ["a", "b"]

    // Act
    const state = groupCheck(ids, new Set(["a"]))

    // Assert
    expect(state).toBe("indeterminate")
  })

  it("marcar grupo seleciona todos os casos dele", () => {
    // Arrange
    const ids = ["a", "b"]

    // Act
    const next = toggleGroup(ids, new Set(["a", "x"]))

    // Assert
    expect([...next].sort()).toEqual(["a", "b", "x"])
  })

  it("marcar grupo já todo selecionado desmarca só ele", () => {
    // Arrange
    const ids = ["a", "b"]

    // Act
    const next = toggleGroup(ids, new Set(["a", "b", "x"]))

    // Assert
    expect([...next]).toEqual(["x"])
  })
})
