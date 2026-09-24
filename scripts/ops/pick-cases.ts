// Escolhe casos do catálogo para testes de carga/aceitação.
// Uso: npm run pick-cases -- --n 30 [--distinct-accounts] [--spread-folders] [--exclude <regex>]
// Saída: JSON com os testIds escolhidos.
import { loadConfig } from "@/core/config"
import { dataPaths } from "@/core/paths"
import { readJson } from "@/core/store"
import { type CatalogEntry, CatalogSchema } from "@/core/types"

export function pickCases(
  entries: CatalogEntry[],
  opts: { n: number; distinctAccounts: boolean; spreadFolders: boolean; exclude?: RegExp },
): CatalogEntry[] {
  let pool = entries.filter((e) => !e.duplicate && (!opts.exclude || !opts.exclude.test(e.name)))
  if (opts.spreadFolders) {
    // intercala as pastas (round-robin) para cobrir o projeto todo
    const byFolder = new Map<string, CatalogEntry[]>()
    for (const e of pool) byFolder.set(e.folder, [...(byFolder.get(e.folder) ?? []), e])
    const lists = [...byFolder.values()]
    const mixed: CatalogEntry[] = []
    for (let i = 0; mixed.length < pool.length; i++) for (const l of lists) if (l[i]) mixed.push(l[i])
    pool = mixed
  }
  const out: CatalogEntry[] = []
  const used = new Set<string>()
  for (const e of pool) {
    if (out.length >= opts.n) break
    if (opts.distinctAccounts) {
      if (e.accounts.some((a) => used.has(a))) continue
      e.accounts.forEach((a) => used.add(a))
    }
    out.push(e)
  }
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const val = (f: string) => {
    const i = args.indexOf(f)
    return i >= 0 ? args[i + 1] : undefined
  }
  const n = Number(val("--n") ?? "30")
  const exclude = val("--exclude")
  const catalog = await readJson(dataPaths(loadConfig().dataDir).catalog, CatalogSchema.nullable(), null)
  if (!catalog) {
    console.error("catálogo não encontrado (o runner já gerou?)")
    process.exit(2)
  }
  const picked = pickCases(catalog.entries, {
    n,
    distinctAccounts: args.includes("--distinct-accounts"),
    spreadFolders: args.includes("--spread-folders"),
    exclude: exclude ? new RegExp(exclude) : undefined,
  })
  console.log(JSON.stringify(picked.map((e) => e.id)))
  console.error(`${picked.length} caso(s) de ${new Set(picked.map((e) => e.folder)).size} pasta(s)`)
}

if (process.argv[1]?.endsWith("pick-cases.ts")) void main()
