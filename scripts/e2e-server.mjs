#!/usr/bin/env node
// Servidor dos testes E2E: build de produção (next build + runner compilado), dados limpos, modo simulado.
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const bin = (n) => path.join(root, "node_modules/.bin", n)
const dataDir = path.join(root, "test-results", "e2e-data")
fs.rmSync(dataDir, { recursive: true, force: true })
const port = process.env.PORT ?? "3200"
const env = {
  ...process.env,
  NODE_ENV: "production",
  QAFARM_FAKE: "1",
  QAFARM_DATA_DIR: dataDir,
  QAFARM_REPO_ROOT: root,
  QAFARM_PASSWORD: "e2e-senha",
  QAFARM_SECRET: "e2e-segredo",
  QAFARM_FAKE_SCENARIO: path.join(root, "tests/fixtures/fake-scenario.json"),
  QAFARM_FAKE_SPEED: process.env.QAFARM_FAKE_SPEED ?? "0.4",
  QAFARM_MACHINE_ID: "server01",
  QAFARM_HEALTH_CLEAR_HOLD_MS: "0",
}
if (process.env.E2E_SKIP_BUILD !== "1") {
  execFileSync(bin("next"), ["build"], { cwd: root, stdio: "inherit", env })
  execFileSync(bin("tsup"), [], { cwd: root, stdio: "inherit", env })
}
const procs = [
  spawn(bin("next"), ["start", "-p", port], { cwd: root, env, stdio: "inherit" }),
  spawn(process.execPath, ["dist/runner.mjs"], { cwd: root, env, stdio: "inherit" }),
]
const stop = () => {
  for (const p of procs) p.kill("SIGTERM")
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
for (const p of procs)
  p.on("exit", (code) => {
    console.error(`[e2e-server] processo terminou (código ${code}); encerrando`)
    stop()
  })
