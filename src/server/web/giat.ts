import "server-only"

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import { GiatStateSchema, validGiatTest } from "@/core/giat"
import { readJson } from "@/core/store"
import { DevicesStateSchema } from "@/core/types"

import { ctx } from "./context"
import { runnerStatus } from "./data"

// Página GI-App-Test: o web só LÊ (estado gravado pelo runner + lista de casos do projeto). Reservar, rodar e
// cancelar são comandos para o runner.

/** Casos do projeto: tests/**\/*.mjs, menos tests/flows/ (caminhos relativos a tests/). */
async function listTests(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string) => {
    const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(r)
      else if (e.isFile() && validGiatTest(r)) out.push(r)
    }
  }
  await walk("")
  return out.sort()
}

export async function readGiat() {
  const { cfg, p } = ctx()
  const enabled = fs.existsSync(path.join(cfg.giatDir, "run.mjs"))
  const [state, devices, runner, tests] = await Promise.all([
    readJson(p.giatState, GiatStateSchema, { reservations: {}, runs: [] }),
    readJson(p.devicesState, DevicesStateSchema.nullable(), null),
    runnerStatus(),
    enabled ? listTests(path.join(cfg.giatDir, "tests")) : Promise.resolve([]),
  ])
  return {
    enabled,
    runnerAlive: runner.alive,
    tests,
    reservations: state.reservations,
    runs: state.runs.map(({ pgid: _pgid, ...r }) => r),
    devices: (devices?.devices ?? [])
      .filter((d) => !d.machineId && (d.kind === "emulator" || d.kind === "physical"))
      .map((d) => ({ serial: d.serial, name: d.name ?? d.serial, kind: d.kind, state: d.state, note: d.note, test: d.currentTestName })),
  }
}
export type GiatDto = Awaited<ReturnType<typeof readGiat>>
