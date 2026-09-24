import { describe, expect, it } from "vitest"

import { createSessionToken, passwordMatches, SESSION_TTL_SEC, verifySessionToken } from "@/core/auth"

const SECRET = "s3cr3t"

describe("sessão", () => {
  it("token criado com o segredo é válido", async () => {
    // Arrange
    const token = await createSessionToken(SECRET, 1000)

    // Act
    const ok = await verifySessionToken(SECRET, token, 1001)

    // Assert
    expect(ok).toBe(true)
  })

  it("token expirado é recusado", async () => {
    // Arrange
    const token = await createSessionToken(SECRET, 1000)

    // Act
    const ok = await verifySessionToken(SECRET, token, 1000 + SESSION_TTL_SEC + 1)

    // Assert
    expect(ok).toBe(false)
  })

  it("token assinado com outro segredo é recusado", async () => {
    // Arrange
    const token = await createSessionToken("outro", 1000)

    // Act
    const ok = await verifySessionToken(SECRET, token, 1001)

    // Assert
    expect(ok).toBe(false)
  })

  it("token com validade alterada é recusado", async () => {
    // Arrange
    const [, sig] = (await createSessionToken(SECRET, 1000)).split(".")
    const forjado = `99999999999.${sig}`

    // Act
    const ok = await verifySessionToken(SECRET, forjado, 1001)

    // Assert
    expect(ok).toBe(false)
  })

  it("sem token ou sem segredo não autentica", async () => {
    // Arrange
    const token = await createSessionToken(SECRET, 1000)

    // Act
    const results = await Promise.all([verifySessionToken(SECRET, undefined), verifySessionToken("", token)])

    // Assert
    expect(results).toEqual([false, false])
  })
})

describe("passwordMatches", () => {
  it("senha certa confere e errada não", async () => {
    // Arrange
    const expected = "abc123"

    // Act
    const results = await Promise.all([
      passwordMatches(SECRET, expected, "abc123"),
      passwordMatches(SECRET, expected, "abc124"),
    ])

    // Assert
    expect(results).toEqual([true, false])
  })

  it("sem senha configurada ninguém entra", async () => {
    // Arrange
    const expected = ""

    // Act
    const ok = await passwordMatches(SECRET, expected, "")

    // Assert
    expect(ok).toBe(false)
  })
})
