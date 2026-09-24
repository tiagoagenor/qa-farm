#!/usr/bin/env node
// Verifica o padrão AAA em todos os testes TypeScript (Vitest e Playwright):
// cada it()/test() precisa ter, nesta ordem, os comentários "// Arrange", "// Act" e "// Assert".
// "// Act & Assert" só é aceito quando o teste verifica exceção (toThrow / rejects).
import fs from "node:fs"
import path from "node:path"

const ROOTS = ["tests", "e2e"]
const FILE_RE = /\.(test|spec)\.tsx?$/
const DECL_RE = /^[ \t]*(?:it|test)(?:\.each\([\s\S]*?\))?\(\s*(["'`])(.*?)\1/gm

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : FILE_RE.test(e.name) ? [p] : []
  })
}

const problems = []
let count = 0
for (const file of ROOTS.flatMap(walk)) {
  const src = fs.readFileSync(file, "utf8")
  const decls = [...src.matchAll(DECL_RE)]
  decls.forEach((m, i) => {
    count++
    const body = src.slice(m.index, i + 1 < decls.length ? decls[i + 1].index : src.length)
    const line = src.slice(0, m.index).split("\n").length
    const where = `${file}:${line} "${m[2]}"`
    const arrange = body.indexOf("// Arrange")
    const actAssert = body.indexOf("// Act & Assert")
    const act = body.search(/\/\/ Act(?! &)/)
    const assert = body.indexOf("// Assert")
    if (arrange < 0) return problems.push(`${where}: falta "// Arrange"`)
    if (actAssert >= 0) {
      if (!/toThrow|rejects/.test(body)) problems.push(`${where}: "// Act & Assert" só para exceções (toThrow/rejects)`)
      if (actAssert < arrange) problems.push(`${where}: "// Act & Assert" antes de "// Arrange"`)
      return
    }
    if (act < 0) return problems.push(`${where}: falta "// Act"`)
    if (assert < 0) return problems.push(`${where}: falta "// Assert"`)
    if (!(arrange < act && act < assert)) problems.push(`${where}: ordem deve ser Arrange → Act → Assert`)
  })
}

if (problems.length) {
  console.error(`check-aaa: ${problems.length} problema(s) em ${count} teste(s):\n  ${problems.join("\n  ")}`)
  process.exit(1)
}
console.log(`check-aaa: ${count} teste(s) TypeScript seguem o padrão AAA`)
