import { describe, expect, it } from "vitest"

import { pickCases } from "../../scripts/ops/pick-cases"
import { entry } from "../helpers/builders"

const E = [
  entry("A1", { folder: "scenarios/a", accounts: ["usuario_x"] }),
  entry("A2", { folder: "scenarios/a", accounts: ["usuario_x"] }),
  entry("A3", { folder: "scenarios/a", accounts: [] }),
  entry("B1", { folder: "scenarios/b", accounts: ["usuario_y"] }),
  entry("B2", { folder: "scenarios/b", accounts: ["usuario_z"], duplicate: true }),
]

describe("pickCases", () => {
  it("com contas distintas nunca repete conta", () => {
    // Arrange
    const opts = { n: 10, distinctAccounts: true, spreadFolders: false }

    // Act
    const out = pickCases(E, opts)

    // Assert
    expect(out.map((e) => e.name)).toEqual(["A1", "A3", "B1"])
  })

  it("intercala pastas quando pedido", () => {
    // Arrange
    const opts = { n: 3, distinctAccounts: false, spreadFolders: true }

    // Act
    const out = pickCases(E, opts)

    // Assert
    expect(out.map((e) => e.name)).toEqual(["A1", "B1", "A2"])
  })

  it("ignora casos duplicados e os excluídos pela regex", () => {
    // Arrange
    const opts = { n: 10, distinctAccounts: false, spreadFolders: false, exclude: /A3/ }

    // Act
    const out = pickCases(E, opts)

    // Assert
    expect(out.map((e) => e.name)).toEqual(["A1", "A2", "B1"])
  })
})
