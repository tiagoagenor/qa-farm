import "server-only"

import fsp from "node:fs/promises"
import path from "node:path"

import { newId } from "@/core/ids"
import { parseMassa } from "@/core/massa"
import { localPorts, MachinesFileSchema, MachinesStatusFileSchema, parseDeviceKey } from "@/core/machines"
import { MetricsFileSchema } from "@/core/metrics"
import { agentClient } from "@/server/remote/agent-client"
import { minTheoreticalSec, summarize } from "@/core/queue-logic"
import { listJsonFiles, readJson, writeJsonAtomic } from "@/core/store"
import {
  type AppMeta,
  AppMetaSchema,
  type Catalog,
  CatalogSchema,
  type Command,
  CommandResultSchema,
  DesiredSchema,
  DevicesStateSchema,
  type Queue,
  QueueSchema,
  RunnerStateSchema,
  SettingsSchema,
} from "@/core/types"

import { ctx } from "./context"

export const HEARTBEAT_STALE_MS = 10_000

export async function runnerStatus() {
  const { p } = ctx()
  const state = await readJson(p.runnerState, RunnerStateSchema.nullable(), null)
  const ageMs = state ? Date.now() - Date.parse(state.heartbeatAt) : null
  return { state, ageMs, alive: ageMs !== null && ageMs < HEARTBEAT_STALE_MS }
}

/** Saúde das máquinas (state/metrics.json, gravado pelo runner). `ageMs` = idade da última leitura. */
export async function readMetrics() {
  const m = await readJson(ctx().p.metrics, MetricsFileSchema.nullable(), null)
  const now = Date.now()
  return {
    updatedAt: m?.updatedAt ?? null,
    machines: (m?.machines ?? []).map((x) => ({ ...x, ageMs: x.sample ? now - Date.parse(x.sample.at) : null })),
  }
}

/** Máquinas worker para a tela (SEM o token) + status + chave pública do mestre. */
export async function readMachines() {
  const { p, cfg } = ctx()
  const [file, status, pub] = await Promise.all([
    readJson(p.machines, MachinesFileSchema, { machines: [] }),
    readJson(p.machinesStatus, MachinesStatusFileSchema.nullable(), null),
    fsp.readFile(path.join(p.state, "ssh", "qafarm_ed25519.pub"), "utf8").catch(() => ""),
  ])
  const byId = new Map((status?.machines ?? []).map((s) => [s.id, s]))
  const settings = await readJson(p.settings, SettingsSchema, { maxParallel: 0 })
  return {
    master: { id: cfg.machineId },
    settings,
    publicKey: pub.trim() || null,
    machines: file.machines.map(({ token: _token, ...m }) => ({ ...m, status: byId.get(m.id) ?? null })),
  }
}

/** Cliente do agente para um celular de worker ("server02:emulator-5554"), ou null se for do mestre. */
export async function remoteDevice(serial: string) {
  const { p } = ctx()
  const file = await readJson(p.machines, MachinesFileSchema, { machines: [] })
  const parsed = parseDeviceKey(serial, new Set(file.machines.map((m) => m.id)))
  if (!parsed.machineId) return null
  const m = file.machines.find((x) => x.id === parsed.machineId)!
  const base = m.transport === "direct" ? m.directUrl : `http://127.0.0.1:${localPorts(m.slot).agent}`
  return base ? { client: agentClient(base, m.token, 20_000), serial: parsed.serial } : null
}

export async function devicesState() {
  const { p } = ctx()
  const [devices, desired, runner] = await Promise.all([
    readJson(p.devicesState, DevicesStateSchema.nullable(), null),
    readJson(p.desired, DesiredSchema, { devices: 0 }),
    runnerStatus(),
  ])
  return {
    updatedAt: devices?.updatedAt ?? null,
    devices: devices?.devices ?? [],
    adbRaw: devices?.adbRaw ?? "",
    desired: desired.devices,
    farmJob: runner.state?.farmJob ?? null,
    activeAppId: runner.state?.activeAppId ?? null,
  }
}

export async function listApps(): Promise<Array<AppMeta & { queues: number; activeQueues: number }>> {
  const { p } = ctx()
  const dirs = await fsp.readdir(p.apps).catch(() => [] as string[])
  const queues = await listQueues()
  const metas = await Promise.all(dirs.map((d) => readJson(p.appMeta(d), AppMetaSchema.nullable(), null)))
  return metas
    .filter((m): m is AppMeta => !!m)
    .map((m) => ({
      ...m,
      queues: queues.filter((q) => q.appId === m.id).length,
      activeQueues: queues.filter((q) => q.appId === m.id && (q.status === "running" || q.status === "paused")).length,
    }))
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
}

let catalogCache: { mtimeMs: number; data: Catalog } | null = null

export async function readCatalog(): Promise<Catalog | null> {
  const { p } = ctx()
  const st = await fsp.stat(p.catalog).catch(() => null)
  if (!st) return null
  if (catalogCache && catalogCache.mtimeMs === st.mtimeMs) return catalogCache.data
  const data = await readJson(p.catalog, CatalogSchema.nullable(), null)
  if (data) catalogCache = { mtimeMs: st.mtimeMs, data }
  return data
}

export async function readQueue(id: string): Promise<Queue | null> {
  return readJson(ctx().p.queue(id), QueueSchema.nullable(), null)
}

export async function listQueues(): Promise<Queue[]> {
  const files = await listJsonFiles(ctx().p.queues)
  const all = await Promise.all(files.map((f) => readJson(f, QueueSchema.nullable(), null)))
  return all.filter((q): q is Queue => !!q).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Tentativas em andamento ainda não têm a massa na fila: lê o massa.json que o listener vai gravando. */
export async function withLiveMassa(q: Queue): Promise<Queue> {
  const items = await Promise.all(
    q.items.map(async (it) => {
      if (it.status !== "running") return it
      const attempts = await Promise.all(
        it.attempts.map(async (a) => {
          if (a.endedAt) return a
          const text = await fsp.readFile(path.join(ctx().p.runs, a.dir, "massa.json"), "utf8").catch(() => undefined)
          const massa = parseMassa(text)
          return massa.length ? { ...a, massa } : a
        }),
      )
      return { ...it, attempts }
    }),
  )
  return { ...q, items }
}

export function queueSummary(q: Queue, readyDevices: number) {
  const s = summarize(q)
  return {
    id: q.id,
    name: q.name,
    createdAt: q.createdAt,
    finishedAt: q.finishedAt ?? null,
    appId: q.appId,
    env: q.env,
    status: q.status,
    options: q.options,
    ...s,
    minTheoreticalSec: minTheoreticalSec(q.items, Math.max(1, readyDevices), s.avgDurationSec ?? 120),
  }
}

export async function createCommand(command: Command): Promise<string> {
  const { p } = ctx()
  const id = newId("cmd")
  await writeJsonAtomic(p.command(id), { id, createdAt: new Date().toISOString(), command })
  return id
}

export async function commandResult(id: string) {
  const { p } = ctx()
  const done = await readJson(p.commandDone(id), CommandResultSchema.nullable(), null)
  if (done) return { status: "done" as const, result: done }
  const pending = await fsp.access(p.command(id)).then(
    () => true,
    () => false,
  )
  return { status: pending ? ("pending" as const) : ("unknown" as const), result: null }
}

/** Lê um pedaço do console.log de uma tentativa a partir de `offset` (bytes). */
export async function readConsole(file: string, offset: number, max = 256 * 1024) {
  const fh = await fsp.open(file, "r").catch(() => null)
  if (!fh) return { text: "", offset, size: 0 }
  try {
    const { size } = await fh.stat()
    const start = Math.min(Math.max(0, offset), size)
    const len = Math.min(max, size - start)
    const buf = Buffer.alloc(len)
    if (len > 0) await fh.read(buf, 0, len, start)
    return { text: buf.toString("utf8"), offset: start + len, size }
  } finally {
    await fh.close()
  }
}

export function runsPath(...segs: string[]) {
  return path.join(ctx().p.runs, ...segs)
}
