import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { loadConfig } from "@/core/config"
import { type AppiumPool, realAppium } from "@/server/appium"

const FAKE = path.resolve(__dirname, "../fixtures/fake-appium.mjs")
let pool: AppiumPool | null = null
let dir = ""

async function makePool(base: number) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "qafarm-appium-"))
  const cfg = loadConfig({ HOME: os.homedir(), QAFARM_DATA_DIR: dir, QAFARM_APPIUM_BIN: FAKE, QAFARM_APPIUM_BASE_PORT: String(base), QAFARM_MAX_DEVICES: "10" } as unknown as NodeJS.ProcessEnv)
  pool = realAppium(cfg)
  return pool
}

const countServers = (port: number) =>
  // pgrep | wc -l: o pgrep do macOS não tem -c
  Number(execFileSync("bash", ["-c", `pgrep -f "[f]ake-appium.mjs --address 127.0.0.1 --port ${port} " | wc -l`], { encoding: "utf8" }).trim() || 0)

afterEach(async () => {
  await pool?.stopAll()
  await fs.rm(dir, { recursive: true, force: true })
})

describe("realAppium", () => {
  it("5 celulares do mesmo grupo pedindo Appium ao mesmo tempo sobem um único servidor", async () => {
    // Arrange
    const p = await makePool(47300)

    // Act
    await Promise.all([1, 2, 3, 4, 5].map((i) => p.ensure(i)))
    await Promise.all([1, 2, 3, 4, 5].map((i) => p.ensure(i)))

    // Assert
    expect([countServers(47301), await p.isReady(3)]).toEqual([1, true])
  })

  it("celulares de grupos diferentes usam servidores diferentes", async () => {
    // Arrange
    const p = await makePool(47400)

    // Act
    await Promise.all([1, 6].map((i) => p.ensure(i)))

    // Assert
    expect([p.url(1), p.url(6), countServers(47401), countServers(47402)]).toEqual([
      "http://127.0.0.1:47401/wd/hub",
      "http://127.0.0.1:47402/wd/hub",
      1,
      1,
    ])
  })
})
