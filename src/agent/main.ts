import fs from "node:fs"
import path from "node:path"

import { loadConfig } from "@/core/config"
import { AGENT_PORT } from "@/core/machines"
import { createAdapters } from "@/server/adapters"

import { startAgent } from "./server"

// Entrada do agente do worker (dist/agent.mjs). Configuração pelo ambiente (~/qa-farm-agent/.env,
// gravado pelo worker-deploy.sh do mestre): QAFARM_AGENT_TOKEN, QAFARM_AGENT_PORT, QAFARM_AGENT_COMMIT…
async function main() {
  const token = process.env.QAFARM_AGENT_TOKEN ?? ""
  if (token.length < 16) {
    console.error("QAFARM_AGENT_TOKEN ausente ou curto demais — agente não iniciado")
    process.exit(2)
  }
  const cfg = loadConfig(process.env)
  fs.mkdirSync(path.join(cfg.dataDir, "logs"), { recursive: true })
  const ad = createAdapters(cfg)
  // não mata Appiums vivos: o ensure() adota o que já responde na porta — reiniciar/atualizar o agente
  // no meio de uma fila não derruba casos em andamento
  const agent = await startAgent({
    cfg,
    ad,
    token,
    host: process.env.QAFARM_AGENT_HOST ?? "127.0.0.1",
    port: Number(process.env.QAFARM_AGENT_PORT ?? AGENT_PORT),
    version: process.env.QAFARM_AGENT_VERSION ?? "0.1.0",
    commit: process.env.QAFARM_AGENT_COMMIT ?? "dev",
    apkDir: path.join(cfg.dataDir, "apks"),
  })
  const stop = async () => {
    setTimeout(() => process.exit(0), 3000).unref() // não fica pendurado esperando conexões
    await agent.close()
    process.exit(0)
  }
  process.on("SIGTERM", () => void stop())
  process.on("SIGINT", () => void stop())
}

void main()
