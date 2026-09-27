import { describe, expect, it } from "vitest"

import { InfraBreaker } from "@/core/infra-breaker"

describe("disjuntor de erros de infraestrutura por celular", () => {
  it("3 erros de infraestrutura seguidos pausam o celular por 5 min", () => {
    // Arrange
    const b = new InfraBreaker(3, 5 * 60_000)
    const t0 = 1_000_000

    // Act
    const r = [
      b.record("x", "infra_error", t0),
      b.record("x", "infra_error", t0),
      b.record("x", "infra_error", t0),
    ]

    // Assert
    expect([
      r.map((x) => x.tripped),
      b.blockedUntil("x", t0 + 1000),
      b.blockedUntil("x", t0 + 5 * 60_000 + 1),
    ]).toEqual([[false, false, true], t0 + 5 * 60_000, null])
  })

  it("um resultado de verdade no meio zera a contagem; cancelado não conta", () => {
    // Arrange
    const b = new InfraBreaker(3)

    // Act
    const out = ["infra_error", "infra_error", "failed", "infra_error", "canceled", "infra_error"].map(
      (s) => b.record("x", s as "infra_error").tripped,
    )

    // Assert
    expect([out, b.blockedUntil("x")]).toEqual([[false, false, false, false, false, false], null])
  })

  it("cada celular tem a sua contagem", () => {
    // Arrange
    const b = new InfraBreaker(2)

    // Act
    b.record("a", "infra_error")
    b.record("b", "infra_error")
    const trippedA = b.record("a", "infra_error").tripped

    // Assert
    expect([trippedA, !!b.blockedUntil("a"), !!b.blockedUntil("b")]).toEqual([true, true, false])
  })
})
