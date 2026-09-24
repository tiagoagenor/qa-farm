import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { loadConfig } from "@/core/config"
import { newId } from "@/core/ids"
import { dataPaths } from "@/core/paths"
import { readJson, writeJsonAtomic } from "@/core/store"
import { type Command, type CommandResult, CommandResultSchema, type Queue, QueueSchema } from "@/core/types"
import { Runner } from "@/runner/runner"
import { createAdapters } from "@/server/adapters"
import { updateWorld } from "@/server/fake-world"

export const REPO = path.resolve(__dirname, "../..")
export const APP_ID = "app_20260924-100000_abcdef"

export async function makeHarness(opts: { emulators?: number; physical?: string[]; ioDelayMs?: number } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "qafarm-runner-"))
  const scenario = path.join(dataDir, "scenario.json")
  await fs.writeFile(
    scenario,
    JSON.stringify({
      bootDelayMs: 50,
      installDelayMs: 20,
      emulators: opts.emulators ?? 0,
      physical: (opts.physical ?? []).map((serial) => ({ serial })),
    }),
  )
  const cfg = loadConfig({
    HOME: os.homedir(),
    QAFARM_FAKE: "1",
    QAFARM_FAKE_SPEED: "0.1",
    QAFARM_FAKE_SCENARIO: scenario,
    QAFARM_DATA_DIR: dataDir,
    QAFARM_REPO_ROOT: REPO,
    QAFARM_FAKE_IO_DELAY_MS: String(opts.ioDelayMs ?? 0),
    QAFARM_METRICS_INTERVAL_MS: "0",
    QAFARM_HEALTH_CLEAR_HOLD_MS: "0",
    QAFARM_MACHINE_ID: "server01",
  } as unknown as NodeJS.ProcessEnv)
  const p = dataPaths(dataDir)
  // app já enviado
  await fs.mkdir(p.app(APP_ID), { recursive: true })
  await fs.writeFile(p.appApk(APP_ID), "PK-fake")
  await writeJsonAtomic(p.appMeta(APP_ID), {
    id: APP_ID,
    originalName: "app.apk",
    package: "com.exemplo.App.hml",
    versionName: "7.26.0",
    versionCode: 5528,
    minSdk: 26,
    abis: ["x86_64"],
    launchableActivity: "com.exemplo.MainActivity",
    md5: "x",
    size: 7,
    uploadedAt: "2026-09-24T10:00:00.000Z",
  })
  const logs: string[] = []
  const runner = new Runner(cfg, createAdapters(cfg), (m) => logs.push(m), { deviceRefreshMs: 100 })
  await runner.init()

  async function tickUntil<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      await runner.tick()
      const v = await fn()
      if (v) return v as T
      if (Date.now() > deadline) throw new Error(`timeout esperando condição\n${logs.slice(-15).join("\n")}`)
      await new Promise((r) => setTimeout(r, 40))
    }
  }

  async function command(c: Command): Promise<CommandResult> {
    const id = newId("cmd")
    await writeJsonAtomic(p.command(id), { id, createdAt: new Date().toISOString(), command: c })
    return tickUntil(async () => (await readJson(p.commandDone(id), CommandResultSchema.nullable(), null)) ?? undefined)
  }

  async function queueFile(id: string): Promise<Queue | null> {
    await runner.shutdown()
    return readJson(p.queue(id), QueueSchema.nullable(), null)
  }

  async function catalogIds(pred: (name: string) => boolean): Promise<string[]> {
    const cat = JSON.parse(await fs.readFile(path.join(REPO, "tests/fixtures/fake-project/catalog.json"), "utf8"))
    return cat.entries.filter((e: { name: string }) => pred(e.name)).map((e: { id: string }) => e.id)
  }

  async function readyCount() {
    return runner.snapshotForTests().devices.filter((d) => d.state === "ready").length
  }

  return {
    dataDir,
    cfg,
    p,
    runner,
    logs,
    tickUntil,
    command,
    queueFile,
    catalogIds,
    readyCount,
    world: (fn: Parameters<typeof updateWorld>[1]) => updateWorld(dataDir, fn),
    cleanup: async () => {
      runner.killAllRunning()
      await new Promise((r) => setTimeout(r, 150))
      await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

export type Harness = Awaited<ReturnType<typeof makeHarness>>

export function queueInput(testIds: string[], over: Partial<{ timeoutSec: number; retries: number; name: string }> = {}) {
  return {
    name: over.name ?? "fila de teste",
    appId: APP_ID,
    env: "hml" as const,
    timeoutSec: over.timeoutSec ?? 60,
    retries: over.retries ?? 0,
    testIds,
  }
}
