import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { startAgent } from "@/agent/server"
import { loadConfig } from "@/core/config"
import { createAdapters } from "@/server/adapters"
import { readWorld, updateWorld } from "@/server/fake-world"

import { REPO } from "./harness"

export const WORKER_TOKEN = "w".repeat(40)

/** Worker simulado: agente de verdade (HTTP) com adapters fake e "mundo" próprio. */
export async function startFakeWorker(opts: { emulators?: number } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qafarm-worker-"))
  const scenario = path.join(dir, "scenario.json")
  await fs.writeFile(scenario, JSON.stringify({ emulators: opts.emulators ?? 0, bootDelayMs: 50, installDelayMs: 20 }))
  const cfg = loadConfig({
    HOME: dir,
    QAFARM_FAKE: "1",
    QAFARM_FAKE_SPEED: "0.1",
    QAFARM_DATA_DIR: path.join(dir, "data"),
    QAFARM_REPO_ROOT: REPO,
    QAFARM_FAKE_SCENARIO: scenario,
    QAFARM_METRICS_INTERVAL_MS: "200",
  } as unknown as NodeJS.ProcessEnv)
  const agent = await startAgent({
    cfg,
    ad: createAdapters(cfg),
    token: WORKER_TOKEN,
    port: 0,
    version: "test",
    commit: "abc123",
    apkDir: path.join(dir, "apks"),
    log: () => undefined,
  })
  let open = true
  return {
    url: agent.url,
    dataDir: cfg.dataDir,
    apkDir: path.join(dir, "apks"),
    world: (fn: Parameters<typeof updateWorld>[1]) => updateWorld(cfg.dataDir, fn),
    readWorld: () => readWorld(cfg.dataDir),
    stop: async () => {
      if (!open) return
      open = false
      await agent.close()
    },
  }
}
