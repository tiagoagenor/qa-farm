import { describe, expect, it } from "vitest"

import { accountOverlaps, deviceOverlaps, peakConcurrency } from "@/core/overlap"
import { attempt, item, queue } from "../helpers/builders"

const at = (serial: string, start: string, end: string, n = 1) =>
  attempt({ serial, n, startedAt: `2026-09-24T10:${start}.000Z`, endedAt: `2026-09-24T10:${end}.000Z`, status: "passed" })

describe("accountOverlaps", () => {
  it("detecta dois casos da mesma conta ao mesmo tempo", () => {
    // Arrange
    const q = queue([
      item("A", ["usuario_x"], { attempts: [at("emulator-5554", "00:00", "02:00")] }),
      item("B", ["usuario_x"], { attempts: [at("emulator-5556", "01:00", "03:00")] }),
    ])

    // Act
    const found = accountOverlaps([q])

    // Assert
    expect(found).toHaveLength(1)
  })

  it("casos da mesma conta em sequência não são sobreposição", () => {
    // Arrange
    const q = queue([
      item("A", ["usuario_x"], { attempts: [at("emulator-5554", "00:00", "02:00")] }),
      item("B", ["usuario_x"], { attempts: [at("emulator-5556", "02:00", "03:00")] }),
    ])

    // Act
    const found = accountOverlaps([q])

    // Assert
    expect(found).toEqual([])
  })
})

describe("deviceOverlaps", () => {
  it("detecta dois casos no mesmo celular ao mesmo tempo", () => {
    // Arrange
    const q = queue([
      item("A", [], { attempts: [at("emulator-5554", "00:00", "02:00")] }),
      item("B", [], { attempts: [at("emulator-5554", "01:59", "03:00")] }),
    ])

    // Act
    const found = deviceOverlaps([q])

    // Assert
    expect(found.map((f) => f.key)).toEqual(["emulator-5554"])
  })
})

describe("peakConcurrency", () => {
  it("conta o pico de tentativas simultâneas", () => {
    // Arrange
    const q = queue([
      item("A", [], { attempts: [at("emulator-5554", "00:00", "05:00")] }),
      item("B", [], { attempts: [at("emulator-5556", "01:00", "02:00")] }),
      item("C", [], { attempts: [at("emulator-5558", "01:30", "04:00")] }),
      item("D", [], { attempts: [at("emulator-5556", "02:00", "03:00")] }),
    ])

    // Act
    const peak = peakConcurrency([q])

    // Assert
    expect(peak).toBe(3)
  })
})
