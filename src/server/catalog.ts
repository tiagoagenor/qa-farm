import fsp from "node:fs/promises"
import path from "node:path"

import type { Config } from "@/core/config"
import { dataPaths } from "@/core/paths"
import { readJson, writeJsonAtomic } from "@/core/store"
import { type Catalog, CatalogSchema } from "@/core/types"

import { run } from "./exec"

export interface CatalogBuilder {
  build(snapshotDir: string, hash: string): Promise<Catalog>
}

export function realCatalog(cfg: Config): CatalogBuilder {
  const out = dataPaths(cfg.dataDir).catalog
  return {
    async build(snapshotDir, hash) {
      const tmp = `${out}.build.json`
      await fsp.mkdir(path.dirname(out), { recursive: true })
      const r = await run(cfg.pythonBin, [path.join(cfg.repoRoot, "scripts/robot/catalog.py"), snapshotDir, tmp, hash], {
        timeoutMs: 300_000,
      })
      if (r.code !== 0) throw new Error(`catalog.py falhou: ${(r.stderr || r.stdout).slice(-800)}`)
      const parsed = CatalogSchema.safeParse(JSON.parse(await fsp.readFile(tmp, "utf8")))
      await fsp.rm(tmp, { force: true })
      if (!parsed.success) throw new Error("catálogo gerado fora do formato esperado")
      await writeJsonAtomic(out, parsed.data)
      return parsed.data
    },
  }
}

export function fakeCatalog(cfg: Config): CatalogBuilder {
  const out = dataPaths(cfg.dataDir).catalog
  return {
    async build(_dir, hash) {
      const src = path.join(cfg.repoRoot, "tests/fixtures/fake-project/catalog.json")
      const data = await readJson(src, CatalogSchema, { generatedAt: "", snapshotHash: "", total: 0, entries: [] })
      const catalog = { ...data, snapshotHash: hash, generatedAt: new Date().toISOString() }
      await writeJsonAtomic(out, catalog)
      return catalog
    },
  }
}
