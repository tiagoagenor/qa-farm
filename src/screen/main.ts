import fs from "node:fs"
import path from "node:path"

import { loadConfig } from "@/core/config"

import { startScreenServer } from "./server"
import { fakeScreenSource, realScreenSource } from "./source"

// Entrada do serviço de tela ao vivo (dist/screen.mjs), supervisionado como web e runner.
async function main() {
  const cfg = loadConfig(process.env)
  if (!cfg.secret) {
    console.error("QAFARM_SECRET ausente — serviço de tela não iniciado")
    process.exit(2)
  }
  fs.mkdirSync(path.join(cfg.dataDir, "state"), { recursive: true })
  const srv = await startScreenServer({
    cfg,
    // QAFARM_SCREEN_SOURCE=real força a fonte real mesmo no modo simulado (diagnóstico)
    source:
      cfg.fake && process.env.QAFARM_SCREEN_SOURCE !== "real"
        ? fakeScreenSource()
        : realScreenSource(cfg.repoRoot),
    adbPort: process.env.QAFARM_SCREEN_ADB_PORT ? Number(process.env.QAFARM_SCREEN_ADB_PORT) : undefined,
    port: Number(process.env.QAFARM_SCREEN_PORT ?? 3001),
    panelPort: Number(process.env.PORT ?? 3000),
  })
  const stop = async () => {
    setTimeout(() => process.exit(0), 3000).unref()
    await srv.close()
    process.exit(0)
  }
  process.on("SIGTERM", () => void stop())
  process.on("SIGINT", () => void stop())
}

void main()
