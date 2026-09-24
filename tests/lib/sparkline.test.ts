import { describe, expect, it } from "vitest"

import { refY, sparkPath } from "@/lib/sparkline"

describe("sparkPath", () => {
  it("desenha a série na escala e interrompe a linha nos buracos", () => {
    // Arrange
    const values = [0, 50, null, 100]

    // Act
    const d = sparkPath(values, 30, 10, 0, 100)

    // Assert
    expect(d).toBe("M0 10 L10 5 M30 0")
  })

  it("valores fora da escala ficam presos na borda", () => {
    // Arrange
    const values = [150, -20]

    // Act
    const d = sparkPath(values, 10, 10, 0, 100)

    // Assert
    expect(d).toBe("M0 0 L10 10")
  })
})

describe("refY", () => {
  it("posiciona a linha de limite", () => {
    // Arrange
    const limit = 85

    // Act
    const y = refY(limit, 40, 20, 100)

    // Assert
    expect(y).toBe(7.5)
  })
})
