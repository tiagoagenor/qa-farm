import { describe, expect, it } from "vitest"

import { deviceKey, dispatchBudget, globalIndex, interleaveByMachine, localPorts, nextSlot, parseDeviceKey, splitIndex } from "@/core/machines"

const KNOWN = new Set(["server02"])

describe("deviceKey / parseDeviceKey", () => {
  it("celular local continua com o serial puro e o remoto ganha o prefixo da máquina", () => {
    // Arrange
    const serial = "emulator-5554"

    // Act
    const keys = [deviceKey(undefined, serial), deviceKey("server02", serial)]

    // Assert
    expect(keys).toEqual(["emulator-5554", "server02:emulator-5554"])
  })

  it("serial TCP com ':' de máquina local não é confundido com máquina remota", () => {
    // Arrange
    const keys = ["127.0.0.1:5555", "server02:127.0.0.1:5555"]

    // Act
    const parsed = keys.map((k) => parseDeviceKey(k, KNOWN))

    // Assert
    expect(parsed).toEqual([{ serial: "127.0.0.1:5555" }, { machineId: "server02", serial: "127.0.0.1:5555" }])
  })
})

describe("índices e portas", () => {
  it("índice global = 100 × slot + local, e volta ao local", () => {
    // Arrange
    const g = globalIndex(1, 3)

    // Act
    const back = [splitIndex(g), splitIndex(7), splitIndex(52)]

    // Assert
    expect([g, back]).toEqual([103, [{ slot: 1, local: 3 }, { slot: 0, local: 7 }, { slot: 0, local: 52 }]])
  })

  it("portas locais do túnel por slot", () => {
    // Arrange
    const p = localPorts(2)

    // Act
    const out = [p.agent, p.appium(1), p.appium(2)]

    // Assert
    expect(out).toEqual([20200, 20201, 20202])
  })

  it("próximo slot livre", () => {
    // Arrange
    const used = [1, 2, 4]

    // Act
    const s = nextSlot(used)

    // Assert
    expect(s).toBe(3)
  })
})

describe("dispatchBudget", () => {
  const cfg = { minFreeMemMb: 1500, caseMemMb: 150 }

  it.each([
    [{ online: true, memAvailableMb: 1600, brake: false }, 1],
    [{ online: true, memAvailableMb: 1400, brake: false }, 0],
    [{ online: true, memAvailableMb: 10_000, brake: true }, 0],
    [{ online: false, memAvailableMb: 10_000, brake: false }, 0],
    [{ online: true, memAvailableMb: null, brake: false }, 0],
  ])("%o → %i caso(s)", (m, expected) => {
    // Arrange
    const machine = m

    // Act
    const n = dispatchBudget(machine, cfg)

    // Assert
    expect(n).toBe(expected)
  })
})

describe("interleaveByMachine", () => {
  it("alterna os celulares livres entre as máquinas", () => {
    // Arrange
    const free = [{ id: "a1" }, { id: "a2" }, { id: "a3" }, { id: "b1", machineId: "server02" }, { id: "b2", machineId: "server02" }]

    // Act
    const out = interleaveByMachine(free).map((x) => x.id)

    // Assert
    expect(out).toEqual(["a1", "b1", "a2", "b2", "a3"])
  })
})
