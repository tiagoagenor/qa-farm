// Gera um relatório Markdown a partir de ~/qa-farm-data/aceite/aceite.jsonl (a última execução de cada item).
// Uso: npx tsx scripts/ops/aceite-report.ts > docs/ACEITE.md
import fs from "node:fs"
import path from "node:path"

import { loadConfig } from "../../src/core/config"

interface Line {
  at: string
  id: string
  ok: boolean
  detail: string
}

const file = path.join(loadConfig().dataDir, "aceite", "aceite.jsonl")
const lines: Line[] = fs
  .readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))

const latest = new Map<string, Line>()
for (const l of lines) latest.set(l.id, l)
const order = (id: string) => id.replace(/^T/, "").split(".").map((n) => n.padStart(3, "0")).join(".")
const rows = [...latest.values()].sort((a, b) => order(a.id).localeCompare(order(b.id)))

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ")
console.log(`| Item | Resultado | Evidência | Quando (UTC) |`)
console.log(`|---|---|---|---|`)
for (const r of rows) console.log(`| ${r.id} | ${r.ok ? "✅" : "❌"} | ${esc(r.detail)} | ${r.at.slice(0, 19).replace("T", " ")} |`)
