import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { loadConfig } from "@/core/config"
import { realFarm } from "@/server/farm"

const hasFlock = (() => {
  try {
    execFileSync("flock", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

let dir = ""
afterEach(async () => {
  execFileSync("bash", ["-c", "pkill -f '^sleep 30$' || true"])
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

async function makeFarm(timeoutMs?: number) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "qafarm-farm-"))
  const cfg = loadConfig({
    HOME: os.homedir(),
    QAFARM_REPO_ROOT: path.resolve(__dirname, "../fixtures/farm-repo"),
    QAFARM_FARM_HOME: dir,
    QAFARM_DATA_DIR: dir,
  } as unknown as NodeJS.ProcessEnv)
  return realFarm(cfg, timeoutMs)
}

describe("realFarm (Linux, com flock)", () => {
  it.skipIf(!hasFlock)("processo filho vivo (emulador) não segura o lock da próxima operação", async () => {
    // Arrange
    const farm = await makeFarm()
    await farm.exec({ kind: "start", count: 1 }, path.join(dir, "farm.log"))

    // Act
    const t0 = Date.now()
    const second = await farm.exec({ kind: "startOne", index: 2 }, path.join(dir, "farm.log"))

    // Assert
    expect([second.ok, Date.now() - t0 < 5000]).toEqual([true, true])
  })

  it.skipIf(!hasFlock)("operação que passa do tempo máximo é interrompida", async () => {
    // Arrange
    const farm = await makeFarm(300)
    const lock = path.join(dir, "run", "farm-ops.lock")
    await fs.mkdir(path.dirname(lock), { recursive: true })
    const holder = execFileSync("bash", ["-c", `setsid nohup flock ${lock} sleep 30 >/dev/null 2>&1 & echo $!`], { encoding: "utf8" }).trim()

    // Act
    const t0 = Date.now()
    const r = await farm.exec({ kind: "stopAll" }, path.join(dir, "farm.log"))

    // Assert
    expect([r.ok, Date.now() - t0 < 5000]).toEqual([false, true])
    execFileSync("bash", ["-c", `kill ${holder} 2>/dev/null || true`])
  })
})
