import fs from "node:fs"
import path from "node:path"

import { CatalogSchema } from "@/core/types"
import { readJson } from "@/core/store"
import { ctx } from "@/server/web/context"
import { readCatalog, runnerStatus } from "@/server/web/data"
import { json, noStore } from "@/server/web/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const project = new URL(req.url).searchParams.get("project") === "giat" ? "giat" : "robot"
  if (project === "giat") {
    const { cfg, p } = ctx()
    const exists = fs.existsSync(path.join(cfg.giatDir, "run.mjs"))
    const catalog = exists ? await readJson(p.giatCatalog, CatalogSchema.nullable(), null) : null
    return json(
      {
        status: !exists ? "error" : catalog ? "ready" : "building",
        error: exists ? null : "Projeto GI-App-Test não encontrado no servidor (~/www/QA_Automacao_TESTE)",
        generatedAt: catalog?.generatedAt ?? null,
        total: catalog?.total ?? 0,
        entries: catalog?.entries ?? [],
      },
      noStore,
    )
  }
  const [catalog, runner] = await Promise.all([readCatalog(), runnerStatus()])
  return json(
    {
      status: runner.state?.catalogStatus ?? (catalog ? "ready" : "missing"),
      error: runner.state?.catalogError ?? null,
      generatedAt: catalog?.generatedAt ?? null,
      total: catalog?.total ?? 0,
      entries: catalog?.entries ?? [],
    },
    noStore,
  )
}
