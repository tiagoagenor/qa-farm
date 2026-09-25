import fs from "node:fs/promises"

import { afterEach, describe, expect, it } from "vitest"

import { MachinesStatusFileSchema } from "@/core/machines"
import { MetricsFileSchema } from "@/core/metrics"
import { readJson } from "@/core/store"
import type { Queue } from "@/core/types"

import { type Harness, makeHarness, queueInput } from "./harness"
import { startFakeWorker, WORKER_TOKEN } from "./worker"

let h: Harness | null = null
let worker: Awaited<ReturnType<typeof startFakeWorker>> | null = null
afterEach(async () => {
  await worker?.stop()
  worker = null
  await h?.cleanup()
  h = null
})

const live = (id: string) => h!.runner.snapshotForTests().queues.find((q) => q.id === id)
const done = (q: Queue | undefined) => !!q && (q.status === "done" || q.status === "canceled")

async function setup(localEmulators: number, remoteEmulators: number, opts: Parameters<typeof makeHarness>[0] = {}) {
  h = await makeHarness({ emulators: localEmulators, ...opts })
  worker = await startFakeWorker({ emulators: remoteEmulators })
  const add = await h.command({
    type: "add_machine",
    id: "server02",
    name: "server02",
    host: "127.0.0.1",
    sshUser: "server02",
    sshPort: 22,
    maxDevices: 6,
    directUrl: worker.url,
    token: WORKER_TOKEN,
  })
  const ready = () => h!.runner.snapshotForTests().devices.filter((d) => d.state === "ready")
  await h.tickUntil(() => ready().filter((d) => d.machineId === "server02").length >= remoteEmulators || undefined, 30_000)
  await h.tickUntil(() => ready().filter((d) => !d.machineId).length >= localEmulators || undefined, 30_000)
  return add
}

describe("runner com máquina worker", () => {
  it("cadastra o worker e usa os celulares das duas máquinas na mesma fila", async () => {
    // Arrange
    const add = await setup(1, 2)
    const ids = await h!.catalogIds((n) => n.includes("PASS") && !n.includes("SLOW")).then((x) => x.slice(0, 8))

    // Act
    const qid = (await h!.command({ type: "create_queue", input: { ...queueInput(ids), allowSameAccount: true } })).data!.queueId as string
    const q = await h!.tickUntil(() => (done(live(qid)) ? live(qid) : undefined), 60_000)

    // Assert
    const machines = new Set(q.items.flatMap((i) => i.attempts.map((a) => a.machineId ?? "server01")))
    const remoteSerial = q.items.flatMap((i) => i.attempts).find((a) => a.machineId)?.serial
    expect([add.ok, q.items.every((i) => i.status === "passed"), [...machines].sort(), remoteSerial?.startsWith("server02:emulator-")]).toEqual([
      true,
      true,
      ["server01", "server02"],
      true,
    ])
  })

  it("celular do worker ganha nome e índice próprios, sem colidir com os do mestre", async () => {
    // Arrange
    await setup(1, 1)

    // Act
    const devs = h!.runner.snapshotForTests().devices.filter((d) => d.kind === "emulator")

    // Assert
    expect(devs.map((d) => [d.serial, d.index, d.name]).sort()).toEqual([
      ["emulator-5554", 1, "farm-01"],
      ["server02:emulator-5554", 101, "server02 · farm-01"],
    ])
  })

  it("APK é enviado uma vez para o worker e instalado em todos os celulares dele", async () => {
    // Arrange
    await setup(0, 3)

    // Act
    const w = await worker!.readWorld()

    // Assert
    const apks = await fs.readdir(worker!.apkDir)
    expect([apks.filter((f) => f.endsWith(".apk")).length, w.devices.every((d) => d.installed["com.exemplo.App.hml"] === 5528)]).toEqual([1, true])
  })

  it("worker cai no meio da fila: casos dele viram erro de infra, voltam e terminam no mestre, sem reiniciar emuladores do worker", async () => {
    // Arrange (casos lentos o bastante para o worker cair com eles rodando; offline em 1,5 s)
    await setup(1, 2, { fakeSpeed: 1, remoteOfflineMs: 1500 })
    const ids = await h!.catalogIds((n) => n.includes("SLOW-PASS")).then((x) => x.slice(0, 3))
    const qid = (await h!.command({ type: "create_queue", input: { ...queueInput(ids), allowSameAccount: true } })).data!.queueId as string
    await h!.tickUntil(() => h!.runner.snapshotForTests().running.some((r) => r.serial.startsWith("server02:")) || undefined, 30_000)

    // Act
    await worker!.stop()
    const q = await h!.tickUntil(() => (done(live(qid)) ? live(qid) : undefined), 90_000)

    // Assert
    const infra = q.items.flatMap((i) => i.attempts).filter((a) => a.machineId === "server02" && a.status === "infra_error").length
    expect([q.items.every((i) => i.status === "passed"), infra > 0, h!.logs.some((l) => l.includes("manutenção server02"))]).toEqual([true, true, false])
  })

  it("worker com pouca memória não recebe casos; o mestre continua", async () => {
    // Arrange
    await setup(1, 2)
    await worker!.world((w) => {
      w.memAvailableMb = 900
    })
    await h!.tickUntil(async () => {
      const m = await readJson(h!.p.metrics, MetricsFileSchema.nullable(), null)
      return m?.machines.find((x) => x.id === "server02")?.sample?.memAvailableMb === 900 || undefined
    })
    const ids = await h!.catalogIds((n) => n.includes("PASS") && !n.includes("SLOW")).then((x) => x.slice(0, 4))

    // Act
    const qid = (await h!.command({ type: "create_queue", input: { ...queueInput(ids), allowSameAccount: true } })).data!.queueId as string
    const q = await h!.tickUntil(() => (done(live(qid)) ? live(qid) : undefined), 60_000)

    // Assert
    expect(q.items.flatMap((i) => i.attempts).some((a) => a.machineId === "server02")).toBe(false)
  })

  it("desativar o worker durante um caso: o caso termina e nenhum novo vai para ele", async () => {
    // Arrange
    await setup(1, 1)
    const ids = await h!.catalogIds((n) => n.includes("SLOW-PASS")).then((x) => x.slice(0, 3))
    const qid = (await h!.command({ type: "create_queue", input: { ...queueInput(ids), allowSameAccount: true } })).data!.queueId as string
    const onWorker = await h!.tickUntil(() => h!.runner.snapshotForTests().running.find((r) => r.serial.startsWith("server02:")), 30_000)

    // Act
    const res = await h!.command({ type: "set_machine_enabled", id: "server02", enabled: false })
    const q = await h!.tickUntil(() => (done(live(qid)) ? live(qid) : undefined), 90_000)

    // Assert
    const remote = q.items.flatMap((i) => i.attempts).filter((a) => a.machineId === "server02")
    expect([res.message, remote.length, remote[0].status, q.items.find((i) => i.id === onWorker.itemId)!.status]).toEqual([
      "Máquina drenando: termina os casos atuais e não recebe novos",
      1,
      "passed",
      "passed",
    ])
  })

  it("ligar celulares numa máquina worker pelo comando com machineId", async () => {
    // Arrange
    await setup(0, 0)

    // Act
    const res = await h!.command({ type: "start_devices", count: 2, machineId: "server02" })
    await h!.tickUntil(
      () => h!.runner.snapshotForTests().devices.filter((d) => d.machineId === "server02" && d.state === "ready").length === 2 || undefined,
      30_000,
    )

    // Assert
    const st = await readJson(h!.p.machinesStatus, MachinesStatusFileSchema.nullable(), null)
    expect([res.ok, st?.machines[0].state, st?.machines[0].desired]).toEqual([true, "online", 2])
  })

  it("o arquivo de status e as métricas trazem o worker (sem o token)", async () => {
    // Arrange
    await setup(0, 1)

    // Act
    const [st, metrics, raw] = [
      await readJson(h!.p.machinesStatus, MachinesStatusFileSchema.nullable(), null),
      await readJson(h!.p.metrics, MetricsFileSchema.nullable(), null),
      await fs.readFile(h!.p.machinesStatus, "utf8"),
    ]

    // Assert
    expect([st?.machines[0].id, st?.machines[0].agentCommit, metrics?.machines.map((m) => m.role), raw.includes(WORKER_TOKEN)]).toEqual([
      "server02",
      "abc123",
      ["master", "worker"],
      false,
    ])
  })
})
