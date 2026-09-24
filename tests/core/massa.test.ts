import { describe, expect, it } from "vitest"

import { isSecretField, massaLabel, parseMassa } from "@/core/massa"

describe("parseMassa", () => {
  it("lê contas e dados gerados e descarta entradas inválidas", () => {
    // Arrange
    const text = JSON.stringify({
      entries: [
        { kind: "conta", account: "usuario_ana", var: "${usuario_data}", fields: { username: "ana@teste.com", password: "1" } },
        { kind: "gerado", source: "dataGenerator.Gerar Cpf", var: "${cpf}", value: "123" },
        { kind: "outra coisa" },
      ],
    })

    // Act
    const entries = parseMassa(text)

    // Assert
    expect(entries.map((e) => e.kind)).toEqual(["conta", "gerado"])
  })

  it("arquivo ausente ou pela metade vira lista vazia", () => {
    // Arrange
    const partial = '{"entries": [{"kind": "con'

    // Act
    const out = [parseMassa(undefined), parseMassa(partial)]

    // Assert
    expect(out).toEqual([[], []])
  })
})

describe("massaLabel", () => {
  it("resume cada conta como nome · login", () => {
    // Arrange
    const entries = parseMassa(
      JSON.stringify({ entries: [{ kind: "conta", account: "usuario_ana", var: "${u}", fields: { password: "1", username: "ana@teste.com" } }] }),
    )

    // Act
    const label = massaLabel(entries)

    // Assert
    expect(label).toBe("usuario_ana · ana@teste.com")
  })

  it("sem conta não há resumo", () => {
    // Arrange
    const entries = parseMassa(JSON.stringify({ entries: [{ kind: "gerado", source: "x", var: "${cpf}", value: "1" }] }))

    // Act
    const label = massaLabel(entries)

    // Assert
    expect(label).toBeNull()
  })
})

describe("isSecretField", () => {
  it.each([
    ["password", true],
    ["senha", true],
    ["username", false],
  ])("%s → %s", (name, expected) => {
    // Arrange
    const field = name

    // Act
    const secret = isSecretField(field)

    // Assert
    expect(secret).toBe(expected)
  })
})
