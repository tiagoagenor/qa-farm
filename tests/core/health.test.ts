import { describe, expect, it } from "vitest"

import { evaluateHealth, type HealthState } from "@/core/health"
import { aggregate, type HostSample, MetricsHistory } from "@/core/metrics"

const T0 = Date.parse("2026-09-24T12:00:00.000Z")

function sample(over: Partial<HostSample> = {}, tempC: number | null = 40): HostSample {
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
    cpuPct: 30,
    perCpuPct: [30, 30],
    iowaitPct: 0,
    threads: 32,
    load1: 8,
    load5: 8,
    load15: 8,
    temp: { source: tempC === null ? null : "coretemp", packageC: tempC, cores: [], highC: null, critC: null, gpu: null },
    diskRootFreeGb: 500,
    ...over,
  }
}

/** Aplica leituras em sequência (a cada `stepMs`) e devolve a última avaliação. */
function run(samples: HostSample[], stepMs: number, start: HealthState = {}) {
  let state = start
  let last = evaluateHealth(samples[0], state, T0)
  samples.forEach((s, i) => {
    last = evaluateHealth(s, state, T0 + i * stepMs)
    state = last.state
  })
  return last
}

describe("evaluateHealth", () => {
  it("processador a 86 °C é crítico e aciona o freio", () => {
    // Arrange
    const hot = sample({}, 86)

    // Act
    const r = evaluateHealth(hot, {}, T0)

    // Assert
    expect([r.level, r.brake, r.alerts.map((a) => a.id)]).toEqual(["crit", true, ["temp"]])
  })

  it("depois de crítico, 84 °C continua crítico (histerese) até ficar abaixo de 78 °C por 60 s", () => {
    // Arrange
    const seq = [sample({}, 86), sample({}, 84), sample({}, 77), sample({}, 77)]

    // Act
    const still = run(seq.slice(0, 2), 2000)
    const cooledShort = run(seq.slice(0, 3), 2000)
    const cooledLong = run([...seq, ...Array.from({ length: 31 }, () => sample({}, 77))], 2000)

    // Assert
    expect([still.level, cooledShort.level, cooledLong.level, cooledLong.brake]).toEqual(["crit", "crit", "ok", false])
  })

  it("swap cheio sem troca ativa é só aviso e não freia (páginas antigas paradas no swap)", () => {
    // Arrange
    const s = sample({ swapUsedMb: 4096 })

    // Act
    const r = evaluateHealth(s, {}, T0)

    // Assert
    expect([r.level, r.brake]).toEqual(["warn", false])
  })

  it("troca intensa com o swap por só 10 s não dispara; por 30 s dispara", () => {
    // Arrange
    const thrash = (n: number) => Array.from({ length: n }, () => sample({ swapInPerSec: 2000 }))

    // Act
    const short = run(thrash(6), 2000)
    const long = run(thrash(17), 2000)

    // Assert
    expect([short.brake, long.brake]).toEqual([false, true])
  })

  it("memória baixa aparece como alerta mas não é o freio deste módulo (o runner já freia por memória)", () => {
    // Arrange
    const s = sample({ memAvailableMb: 1000 })

    // Act
    const r = evaluateHealth(s, {}, T0)

    // Assert
    expect([r.level, r.brake]).toEqual(["crit", false])
  })

  it("sem sensor de temperatura não há alerta nem freio", () => {
    // Arrange
    const s = sample({}, null)

    // Act
    const r = evaluateHealth(s, {}, T0)

    // Assert
    expect([r.level, r.brake]).toEqual(["ok", false])
  })

  it("disco quase cheio bloqueia ligar emuladores, sem frear casos", () => {
    // Arrange
    const s = sample({ diskRootFreeGb: 3 })

    // Act
    const r = evaluateHealth(s, {}, T0)

    // Assert
    expect([r.blockStart, r.brake]).toEqual([true, false])
  })
})

describe("MetricsHistory", () => {
  it("5 leituras viram um ponto de 10 s com média de CPU e máximo de temperatura", () => {
    // Arrange
    const h = new MetricsHistory([], T0)
    const temps = [40, 50, 45, 41, 42]

    // Act
    temps.forEach((t, i) => h.add({ ...sample({ cpuPct: i * 10, at: new Date(T0 + i * 2000).toISOString() }, t) }))

    // Assert
    const [p] = h.list()
    expect([h.list().length, p.cpuPct, p.tempC]).toEqual([1, 20, 50])
  })

  it("não passa de 180 pontos (30 min)", () => {
    // Arrange
    const h = new MetricsHistory([], T0)

    // Act
    for (let i = 0; i < 200 * 5; i++) h.add(sample({ at: new Date(T0 + i * 2000).toISOString() }))

    // Assert
    expect(h.list()).toHaveLength(180)
  })

  it("descarta pontos com mais de 30 min ao recarregar o histórico", () => {
    // Arrange
    const old = aggregate([sample({ at: new Date(T0 - 40 * 60_000).toISOString() })])
    const recent = aggregate([sample({ at: new Date(T0 - 60_000).toISOString() })])

    // Act
    const h = new MetricsHistory([old, recent], T0)

    // Assert
    expect(h.list()).toEqual([recent])
  })
})
