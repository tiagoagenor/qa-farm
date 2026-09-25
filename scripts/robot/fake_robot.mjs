#!/usr/bin/env node
// Robot Framework falso (modo QAFARM_FAKE=1). Recebe os mesmos argumentos do `robot`
// e produz os mesmos arquivos (output.xml, log.html, report.html, prints, session.json),
// com o resultado escolhido pelo nome do caso: *PASS*, *FAIL*, *TIMEOUT*, *INFRA*, *NOMATCH*.
import fs from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const get = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const test = (get("--test") ?? "").replace(/\[(.)\]/g, "$1")
const outDir = get("--outputdir") ?? "."
const speed = Number(process.env.QAFARM_FAKE_SPEED ?? "1") || 1
const repo = process.env.QAFARM_REPO_ROOT ?? process.cwd()
const serial = process.env.QAFARM_SERIAL
const name = test.includes(".") ? test.slice(test.indexOf(".") + 1) : test
const upper = name.toUpperCase()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log("=".repeat(78))
console.log(`Fake :: ${name}`)
// variáveis recebidas por -v (ex.: esperas multiplicadas pela fila)
const vars = args.flatMap((a, i) => (a === "-v" ? [args[i + 1]] : [])).filter((v) => /TIMEOUT/.test(v))
if (vars.length) console.log(`variáveis: ${vars.join(" ")}`)
console.log("=".repeat(78))

if (!serial) {
  console.log("QA Farm: variável QAFARM_SERIAL ausente")
  process.exit(3)
}
if (upper.includes("NOMATCH")) {
  console.log(`[ ERROR ] Suite 'Fake' contains no tests matching name '${test}'.`)
  process.exit(252)
}

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(
  path.join(outDir, "session.json"),
  JSON.stringify({ serial, url: process.env.QAFARM_APPIUM_URL, sessionId: `fake-${Date.now()}`, caps: { udid: serial } }, null, 2),
)

// massa usada (o listener real grava massa.json ao ler a conta do DATA_MASSA)
fs.writeFileSync(
  path.join(outDir, "massa.json"),
  JSON.stringify({
    entries: [
      { kind: "conta", account: "usuario_fake", var: "${usuario_data}", fields: { username: "fake@teste.com", password: "123456" } },
      { kind: "gerado", source: "dataGenerator.Gerar Cpf", var: "${cpf}", value: "12345678909" },
    ],
  }),
)

const durationMs = Math.round((upper.includes("SLOW") ? 6000 : 1500) * speed)
if (upper.includes("TIMEOUT")) {
  console.log("Caso travado (simulação de timeout)...")
  await sleep(10 * 60_000)
}
for (let s = 1; s <= 3; s++) {
  console.log(`  passo ${s}/3 em ${serial}`)
  await sleep(durationMs / 3)
}

const fixture = upper.includes("INFRA") ? "setup-infra.xml" : upper.includes("FAIL") ? "fail-teardown.xml" : "pass.xml"
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
let xml = fs.readFileSync(path.join(repo, "tests/fixtures/output", fixture), "utf8")
xml = xml.replace(/(<test id="s1-t1" name=")[^"]*(")/, `$1${esc(name)}$2`)
fs.writeFileSync(path.join(outDir, "output.xml"), xml)
const passed = fixture === "pass.xml"
const png = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${passed ? "PASS" : "FAIL"}-${name}.png`
fs.writeFileSync(
  path.join(outDir, png),
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64"),
)
const html = (title) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1><p>${esc(name)} — ${passed ? "PASS" : "FAIL"}</p><img src="${encodeURIComponent(png)}" width="120"></body></html>`
fs.writeFileSync(path.join(outDir, "log.html"), html("Log (fake)"))
fs.writeFileSync(path.join(outDir, "report.html"), html("Report (fake)"))
console.log(`${name.padEnd(70)} | ${passed ? "PASS" : "FAIL"} |`)
process.exit(passed ? 0 : 1)
