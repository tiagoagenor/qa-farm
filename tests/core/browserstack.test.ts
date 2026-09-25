import { describe, expect, it } from "vitest"

import { bsBudget, isBsIndex, nextSlotId, redactSecrets, slotIdFromKey, slotIndex, slotKey } from "@/core/browserstack"

const plan = (running: number, max = 8) => ({ parallel_sessions_running: running, parallel_sessions_max_allowed: max })

describe("bsBudget", () => {
  it.each([
    [{ freeSlots: 4, ourRunning: 0, plan: plan(0) }, 4],
    [{ freeSlots: 4, ourRunning: 0, plan: plan(6) }, 2],
    [{ freeSlots: 4, ourRunning: 2, plan: plan(8) }, 0],
    [{ freeSlots: 4, ourRunning: 2, plan: plan(5) }, 3],
    [{ freeSlots: 4, ourRunning: 0, plan: null }, 0],
    [{ freeSlots: 9, ourRunning: 0, plan: plan(0), reserve: 1 }, 7],
  ])("%o → %i", (input, expected) => {
    // Arrange
    const opts = input

    // Act
    const n = bsBudget(opts)

    // Assert
    expect(n).toBe(expected)
  })
})

describe("identidade das vagas", () => {
  it("chave e índice da vaga não colidem com mestre nem workers", () => {
    // Arrange
    const id = 3

    // Act
    const out = [slotKey(id), slotIndex(id), slotIdFromKey("browserstack:3"), slotIdFromKey("server02:emulator-5554"), isBsIndex(9903), isBsIndex(103)]

    // Assert
    expect(out).toEqual(["browserstack:3", 9903, 3, null, true, false])
  })

  it("próximo id de vaga livre", () => {
    // Arrange
    const slots = [1, 2, 4].map((id) => ({ id, device: "x", osVersion: "1", enabled: true }))

    // Act
    const id = nextSlotId(slots)

    // Assert
    expect(id).toBe(3)
  })
})

describe("redactSecrets", () => {
  it("tira a chave de URLs e capabilities antes de gravar", () => {
    // Arrange
    const caps = { url: "https://user:SEGREDO123@hub", "bstack:options": { accessKey: "SEGREDO123", userName: "user" } }

    // Act
    const out = redactSecrets(caps, ["SEGREDO123"])

    // Assert
    expect(JSON.stringify(out)).not.toContain("SEGREDO123")
  })
})
