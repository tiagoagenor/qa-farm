import { loadConfig } from "@/core/config"
import { dataPaths } from "@/core/paths"
import { createAdapters } from "@/server/adapters"

import { acquireLock, releaseLock } from "./lock"
import { Runner } from "./runner"

const TICK_MS = 1000

async function main() {
  const cfg = loadConfig()
  const lock = dataPaths(cfg.dataDir).runnerLock
  if (!acquireLock(lock)) {
    console.log("[runner] outro runner já está ativo para esta pasta de dados; saindo")
    process.exit(0)
  }
  const runner = new Runner(cfg, createAdapters(cfg))
  await runner.init()

  let stopping = false
  const stop = async (sig: string) => {
    if (stopping) return
    stopping = true
    console.log(`[runner] recebido ${sig}, encerrando`)
    await runner.shutdown()
    releaseLock(lock)
    process.exit(0)
  }
  process.on("SIGTERM", () => void stop("SIGTERM"))
  process.on("SIGINT", () => void stop("SIGINT"))

  for (;;) {
    if (stopping) return
    await runner.tick()
    await new Promise((r) => setTimeout(r, TICK_MS))
  }
}

void main()
