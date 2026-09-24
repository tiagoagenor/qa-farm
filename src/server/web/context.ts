import "server-only"

import { type Config, loadConfig } from "@/core/config"
import { dataPaths } from "@/core/paths"
import { type Adapters, createAdapters } from "@/server/adapters"

interface Ctx {
  cfg: Config
  p: ReturnType<typeof dataPaths>
  ad: Adapters
}

const g = globalThis as unknown as { __qafarmCtx?: Ctx }

/** Configuração e adaptadores do processo web (criados uma vez). */
export function ctx(): Ctx {
  if (!g.__qafarmCtx) {
    const cfg = loadConfig()
    g.__qafarmCtx = { cfg, p: dataPaths(cfg.dataDir), ad: createAdapters(cfg) }
  }
  return g.__qafarmCtx
}
