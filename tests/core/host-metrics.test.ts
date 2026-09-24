import { describe, expect, it } from "vitest"

import { cpuUsage, parseCpuStat, parseHwmon, parseLoadavg, parseMeminfo, parseVmstatSwap } from "@/core/parsers/host-metrics"

const STAT_A = `cpu  1000 0 500 8000 100 0 0 0 0 0
cpu0 500 0 250 4000 50 0 0 0 0 0
cpu1 500 0 250 4000 50 0 0 0 0 0
intr 123
`
const STAT_B = `cpu  1600 0 600 8200 200 0 0 0 0 0
cpu0 1000 0 300 4000 100 0 0 0 0 0
cpu1 600 0 300 4200 100 0 0 0 0 0
`

describe("cpuUsage", () => {
  it("calcula o uso total e por thread pelo delta entre duas leituras", () => {
    // Arrange
    const a = parseCpuStat(STAT_A)
    const b = parseCpuStat(STAT_B)

    // Act
    const u = cpuUsage(a, b)

    // Assert
    expect([u.cpuPct, u.perCpuPct, u.iowaitPct]).toEqual([70, [91.7, 37.5], 10])
  })
})

describe("parseMeminfo", () => {
  it("memória usada = total − disponível, e swap usado = total − livre", () => {
    // Arrange
    const text = "MemTotal:       63374016 kB\nMemFree:  1000 kB\nMemAvailable:    8483836 kB\nBuffers: 102400 kB\nCached: 1048576 kB\nSwapTotal: 4194300 kB\nSwapFree: 3145724 kB\n"

    // Act
    const m = parseMeminfo(text)

    // Assert
    expect(m).toEqual({ memTotalMb: 61889, memAvailableMb: 8285, memUsedMb: 53604, buffersCacheMb: 1124, swapTotalMb: 4096, swapUsedMb: 1024 })
  })
})

describe("parseLoadavg / parseVmstatSwap", () => {
  it("lê a carga e as páginas trocadas com o swap", () => {
    // Arrange
    const load = "12.30 11.80 10.90 3/1500 4242\n"
    const vm = "nr_free_pages 1\npswpin 1500\npswpout 300\n"

    // Act
    const out = [parseLoadavg(load), parseVmstatSwap(vm)]

    // Assert
    expect(out).toEqual([{ load1: 12.3, load5: 11.8, load15: 10.9 }, { pswpin: 1500, pswpout: 300 }])
  })
})

describe("parseHwmon", () => {
  it("usa o package do coretemp, ordena os núcleos pelo número (com buracos) e separa a GPU", () => {
    // Arrange
    const readings = [
      { name: "nouveau", temps: [{ inputMilli: 37000 }] },
      {
        name: "coretemp",
        temps: [
          { label: "Core 10", inputMilli: 30500 },
          { label: "Package id 0", inputMilli: 36000, maxMilli: 84000, critMilli: 94000 },
          { label: "Core 2", inputMilli: 29000 },
        ],
      },
    ]

    // Act
    const t = parseHwmon(readings)

    // Assert
    expect(t).toEqual({
      source: "coretemp",
      packageC: 36,
      cores: [
        { label: "Core 2", c: 29 },
        { label: "Core 10", c: 30.5 },
      ],
      highC: 84,
      critC: 94,
      gpu: { name: "nouveau", c: 37 },
    })
  })

  it("sem coretemp não há temperatura do processador", () => {
    // Arrange
    const readings = [{ name: "acpitz", temps: [{ inputMilli: 27800 }] }]

    // Act
    const t = parseHwmon(readings)

    // Assert
    expect([t.source, t.packageC, t.cores]).toEqual([null, null, []])
  })
})
