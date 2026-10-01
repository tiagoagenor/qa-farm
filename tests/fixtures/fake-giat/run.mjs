// GI-App-Test de mentira (modo simulado da fazenda): mesmo contrato de linha de comando do run.mjs real.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const a = process.argv.slice(2)
const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined)

if (a.includes("--list")) {
  const walk = (d) => fs.readdirSync(path.join(here, "tests", d), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".mjs") ? [path.join(d, e.name)] : [])
  const rels = walk("")
  console.log(JSON.stringify(rels.map((rel) => ({ rel, name: `Caso ${path.basename(rel, ".mjs")}`, tags: [] }))))
  process.exit(0)
}

const rel = a[0]
const serial = opt("-d")
const json = opt("--json")
if (!(process.env.GIAT_ALLOWED_DEVICES ?? "").split(",").includes(serial)) process.exit(2)
if (!rel || !fs.existsSync(path.join(here, "tests", rel))) process.exit(2)
const leak = Object.keys(process.env).filter((k) => k.startsWith("QAFARM_"))
console.log(`▶ GI-App-Test (simulado) ${rel} em ${serial} · ${opt("--env")} · ${process.env.APPIUM_URL} · systemPort ${process.env.SYSTEM_PORT}`)
const speed = Number(process.env.GIAT_FAKE_MS ?? 400)
setTimeout(() => {
  const fail = rel.includes("FAIL")
  const infra = rel.includes("INFRA")
  const result = { rel, name: rel, ok: !fail && !infra, infra, error: fail ? "Elemento 'Entrar' não apareceu" : infra ? "Appium não respondeu" : undefined, leak }
  if (json) fs.writeFileSync(json, JSON.stringify({ passed: result.ok ? 1 : 0, failed: result.ok ? 0 : 1, results: [result] }))
  console.log(result.ok ? "✓ passou" : `✗ ${result.error}`)
  process.exit(result.ok ? 0 : infra ? 3 : 1)
}, speed)
process.on("SIGTERM", () => process.exit(143))
