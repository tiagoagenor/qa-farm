import { describe, expect, it } from "vitest"

import { durationBetween, formatBytes, formatDuration, runFileUrl } from "@/lib/format"

describe("formatDuration", () => {
  it.each([
    [null, "—"],
    [42, "42s"],
    [75, "1min 15s"],
    [120, "2min"],
    [3725, "1h 2min"],
    [7200, "2h"],
  ])("%s → %s", (sec, expected) => {
    // Arrange
    const input = sec as number | null

    // Act
    const out = formatDuration(input)

    // Assert
    expect(out).toBe(expected)
  })
})

describe("formatDuration preciso (contador ao vivo)", () => {
  it.each([
    [5, "5s"],
    [120, "2min 0s"],
    [3725, "1h 2min 5s"],
    [59.9, "59s"],
  ])("%s → %s", (sec, expected) => {
    // Arrange
    const input = sec

    // Act
    const out = formatDuration(input, true)

    // Assert
    expect(out).toBe(expected)
  })
})

describe("durationBetween", () => {
  it("usa o agora quando a tentativa ainda não terminou", () => {
    // Arrange
    const start = "2026-09-24T10:00:00.000Z"
    const now = Date.parse("2026-09-24T10:00:30.000Z")

    // Act
    const sec = durationBetween(start, undefined, now)

    // Assert
    expect(sec).toBe(30)
  })
})

describe("formatBytes", () => {
  it("mostra MB com uma casa", () => {
    // Arrange
    const bytes = 246595590

    // Act
    const out = formatBytes(bytes)

    // Assert
    expect(out).toBe("235.2 MB")
  })
})

describe("runFileUrl", () => {
  it("codifica cada segmento (nomes com acentos e símbolos)", () => {
    // Arrange
    const dir = "queue_20260924-100000_abcdef/i0001/a1"

    // Act
    const url = runFileUrl(dir, "FAIL-CT (ç+$).png")

    // Assert
    expect(url).toBe("/api/runs/queue_20260924-100000_abcdef/i0001/a1/FAIL-CT%20(%C3%A7%2B%24).png")
  })
})
