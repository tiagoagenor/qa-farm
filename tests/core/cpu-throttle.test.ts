import { describe, expect, it } from "vitest"

import { stepThrottle, throttleRoom, type ThrottleState } from "@/core/cpu-throttle"
import type { HostSample } from "@/core/metrics"

const T0 = Date.parse("2026-09-28T12:00:00.000Z")

function sample(cpuPct: number): HostSample {
  return {
    at: new Date(T0).toISOString(),
    memTotalMb: 62000,
    memAvailableMb: 20000,
    memUsedMb: 42000,
    buffersCacheMb: 5000,
    swapTotalMb: 4096,
    swapUsedMb: 0,
    swapInPerSec: 0,
    swapOutPerSec: 0,
    cpuPct,
    perCpuPct: [cpuPct],
    iowaitPct: 0,
    threads: 32,
    load1: 80,
    load5: 80,
    load15: 80,
    temp: { source: "coretemp", packageC: 50, cores: [], highC: null, critC: null, gpu: null },
    diskRootFreeGb: 500,
  }
}

/** Aplica a mesma CPU a cada 5 s por `ms` e devolve o estado final e as mensagens. */
function hold(state: ThrottleState, cpu: number, ms: number, start: number, running = 14, devices = 14) {
  const logs: string[] = []
  let s = state
  for (let t = 0; t <= ms; t += 5000) {
    const r = stepThrottle(s, { sample: sample(cpu), running, devices, now: start + t })
    s = r.state
    if (r.change) logs.push(r.change)
  }
  return { s, logs, end: start + ms }
}

describe("stepThrottle", () => {
  it("CPU a 97% por 30 s corta 2 casos, não para a máquina", () => {
    // Arrange
    const start: ThrottleState = { cap: null }

    // Act
    const { s } = hold(start, 97, 30_000, T0)

    // Assert
    expect([s.cap, throttleRoom(s, 14)]).toEqual([12, 0])
  })

  it("pico curto de CPU (menos de 30 s) não corta nada", () => {
    // Arrange
    const start: ThrottleState = { cap: null }

    // Act
    const { s } = hold(start, 99, 20_000, T0)

    // Assert
    expect(s.cap).toBeNull()
  })

  it("CPU saturada continua cortando de 2 em 2 a cada minuto, até o mínimo de 2", () => {
    // Arrange
    const start: ThrottleState = { cap: null }

    // Act
    const { s, logs } = hold(start, 99, 10 * 60_000, T0, 14)

    // Assert
    expect([s.cap, logs.length]).toEqual([2, 6])
  })

  it("com a CPU folgada devolve 1 caso por minuto e tira o limite ao chegar no número de celulares", () => {
    // Arrange
    const cut = hold({ cap: null }, 97, 30_000, T0).s

    // Act
    const oneMin = hold(cut, 60, 60_000, T0 + 31_000).s
    const all = hold(cut, 60, 3 * 60_000, T0 + 31_000)

    // Assert
    expect([oneMin.cap, all.s.cap, all.logs.at(-1)]).toEqual([13, null, "CPU em 60%: limite por CPU removido"])
  })

  it("CPU entre folgada e saturada (90%) mantém o limite", () => {
    // Arrange
    const cut = hold({ cap: null }, 97, 30_000, T0).s

    // Act
    const { s } = hold(cut, 90, 5 * 60_000, T0 + 31_000)

    // Assert
    expect(s.cap).toBe(12)
  })
})
