// Verifica uma ou mais filas: sobreposição de conta, celular com 2 casos ao mesmo tempo e pico de concorrência.
// Uso: npm run check-overlap -- <queueId> [<queueId>...]      (sai 1 se houver sobreposição)
import path from "node:path"

import { loadConfig } from "@/core/config"
import { accountOverlaps, deviceOverlaps, peakConcurrency } from "@/core/overlap"
import { dataPaths } from "@/core/paths"
import { readJson } from "@/core/store"
import { type Queue, QueueSchema } from "@/core/types"

async function main() {
  const ids = process.argv.slice(2)
  if (!ids.length) {
    console.error("Uso: check-overlap <queueId> [...]")
    process.exit(2)
  }
  const p = dataPaths(loadConfig().dataDir)
  const queues: Queue[] = []
  for (const id of ids) {
    const q = await readJson(p.queue(path.basename(id)), QueueSchema.nullable(), null)
    if (!q) {
      console.error(`fila não encontrada: ${id}`)
      process.exit(2)
    }
    queues.push(q)
  }
  const acc = accountOverlaps(queues)
  const dev = deviceOverlaps(queues)
  const attempts = queues.flatMap((q) => q.items.flatMap((i) => i.attempts))
  const report = {
    queues: ids,
    items: queues.reduce((n, q) => n + q.items.length, 0),
    attempts: attempts.length,
    distinctSerials: new Set(attempts.map((a) => a.serial)).size,
    peakConcurrency: peakConcurrency(queues),
    accountOverlaps: acc,
    deviceOverlaps: dev,
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(acc.length || dev.length ? 1 : 0)
}

void main()
