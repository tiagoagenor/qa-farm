#!/usr/bin/env node
// Sobe painel (next dev) + runner em modo simulado (sem emuladores). Uso: npm run dev:fake
import { spawn } from "node:child_process"
import path from "node:path"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const port = process.env.PORT ?? "3100"
const env = {
  ...process.env,
  QAFARM_FAKE: "1",
  QAFARM_DATA_DIR: process.env.QAFARM_DATA_DIR ?? path.join(root, ".qafarm-dev"),
  QAFARM_REPO_ROOT: root,
  QAFARM_PASSWORD: process.env.QAFARM_PASSWORD ?? "dev",
  QAFARM_SECRET: process.env.QAFARM_SECRET ?? "dev-secret-nao-usar-em-producao",
  QAFARM_FAKE_SCENARIO: process.env.QAFARM_FAKE_SCENARIO ?? path.join(root, "tests/fixtures/fake-scenario.json"),
  QAFARM_FAKE_SPEED: process.env.QAFARM_FAKE_SPEED ?? "1",
}
const bin = (n) => path.join(root, "node_modules/.bin", n)
const procs = [
  spawn(bin("next"), ["dev", "-p", port], { cwd: root, env, stdio: "inherit" }),
  spawn(bin("tsx"), ["src/runner/main.ts"], { cwd: root, env, stdio: "inherit" }),
]
const stop = () => {
  for (const p of procs) p.kill("SIGTERM")
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
for (const p of procs) p.on("exit", (code) => code && code !== 0 && stop())
console.log(`QA Farm (fake) em http://localhost:${port} — senha: ${env.QAFARM_PASSWORD}`)
