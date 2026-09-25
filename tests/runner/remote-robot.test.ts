import fs from "node:fs/promises"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { Queue } from "@/core/types"

import { type Harness, makeHarness, queueInput } from "./harness"
import { startFakeWorker, WORKER_TOKEN } from "./worker"

// Robot rodando no worker (divide a carga do mestre): o mestre manda o projeto, o worker roda o caso e os
// artefatos voltam para runs/ do mestre.

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
const workerRuns = async () =>
  (await fs.readdir(path.join(worker!.dataDir, "runs")).catch(() => [] as string[])).sort()

async function setup(
  localEmulators: number,
  remoteEmulators: number,
  runRobot: boolean,
  opts: Parameters<typeof makeHarness>[0] = {},
) {
  h = await makeHarness({ emulators: localEmulators, ...opts })
  worker = await startFakeWorker({ emulators: remoteEmulators })
  await h.command({
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
  if (runRobot) await h.command({ type: "set_machine_run_robot", id: "server02", enabled: true })
  const ready = () => h!.runner.snapshotForTests().devices.filter((d) => d.state === "ready")
  await h.tickUntil(
    () => ready().filter((d) => d.machineId === "server02").length >= remoteEmulators || undefined,
    30_000,
  )
  await h.tickUntil(() => ready().filter((d) => !d.machineId).length >= localEmulators || undefined, 30_000)
}

async function runQueue(names: (n: string) => boolean, max = 8) {
  const ids = await h!.catalogIds(names).then((x) => x.slice(0, max))
  const qid = (
    await h!.command({ type: "create_queue", input: { ...queueInput(ids), allowSameAccount: true } })
  ).data!.queueId as string
  return h!.tickUntil(() => (done(live(qid)) ? live(qid) : undefined), 60_000)
}

describe("robot rodando no worker", () => {
  it("celular do worker com 'robot nesta máquina': o caso roda lá e os artefatos voltam para o mestre", async () => {
    // Arrange
    await setup(0, 2, true)

    // Act
    const q = await runQueue((n) => ["CT_LOGIN_01-Caso-PASS", "CT_LOGIN_03-Caso-FAIL"].includes(n))

    // Assert
    const atts = q.items.flatMap((i) => i.attempts)
    const files = await Promise.all(
      atts.map(async (a) => (await fs.readdir(path.join(h!.p.runs, a.dir))).sort()),
    )
    const consoles = await Promise.all(
      atts.map((a) => fs.readFile(path.join(h!.p.runs, a.dir, "console.log"), "utf8")),
    )
    expect([
      atts.map((a) => a.robotOn),
      atts.map((a) => a.status).sort(),
      files.every(
        (f) =>
          [
            "console.log",
            "log.html",
            "massa.json",
            "output.xml",
            "report.html",
            "result.json",
            "session.json",
          ].every((x) => f.includes(x)) && f.some((x) => x.endsWith(".png")),
      ),
      consoles.every((c) => c.includes("passo 3/3")),
      q.items.every((i) => (i.attempts[0].massa ?? []).length === 2),
      await workerRuns(),
    ]).toEqual([["server02", "server02"], ["failed", "passed"], true, true, true, []])
  })

  it("sem a opção ligada, o robot dos celulares do worker continua no mestre", async () => {
    // Arrange
    await setup(0, 1, false)

    // Act
    const q = await runQueue((n) => n === "CT_LOGIN_01-Caso-PASS")

    // Assert
    const a = q.items[0].attempts[0]
    expect([a.status, a.machineId, a.robotOn, await workerRuns()]).toEqual([
      "passed",
      "server02",
      undefined,
      [],
    ])
  })

  it("mestre e worker juntos: cada um roda o robot dos próprios celulares", async () => {
    // Arrange
    await setup(1, 1, true)

    // Act
    const q = await runQueue((n) => n.includes("PASS") && !n.includes("SLOW"), 6)

    // Assert
    const atts = q.items.flatMap((i) => i.attempts)
    expect([
      q.items.every((i) => i.status === "passed"),
      atts.every((a) => (a.machineId === "server02" ? a.robotOn === "server02" : a.robotOn === undefined)),
      new Set(atts.map((a) => a.machineId ?? "server01")).size,
    ]).toEqual([true, true, 2])
  })

  it("cancelar a fila mata o robot no worker e apaga a execução de lá", async () => {
    // Arrange
    await setup(0, 1, true, { fakeSpeed: 1 })
    const ids = await h!.catalogIds((n) => n.includes("SLOW-PASS")).then((x) => x.slice(0, 1))
    const qid = (await h!.command({ type: "create_queue", input: queueInput(ids) })).data!.queueId as string
    await h!.tickUntil(
      async () =>
        ((await workerRuns()).length === 1 && live(qid)?.items[0].status === "running") || undefined,
      30_000,
    )

    // Act
    await h!.command({ type: "cancel_queue", queueId: qid })
    const q = await h!.tickUntil(
      () => (done(live(qid)) && h!.runner.snapshotForTests().running.length === 0 ? live(qid) : undefined),
      30_000,
    )

    // Assert
    expect([q.items[0].status, q.items[0].attempts[0].status, await workerRuns()]).toEqual([
      "canceled",
      "canceled",
      [],
    ])
  })

  it("worker cai com o robot rodando lá: o caso vira erro de infra, volta para a fila e termina no mestre", async () => {
    // Arrange
    await setup(1, 1, true, { fakeSpeed: 1, remoteOfflineMs: 1000 })
    const ids = await h!.catalogIds((n) => n.includes("SLOW-PASS")).then((x) => x.slice(0, 2))
    const qid = (
      await h!.command({ type: "create_queue", input: { ...queueInput(ids), allowSameAccount: true } })
    ).data!.queueId as string
    await h!.tickUntil(
      () => h!.runner.snapshotForTests().running.some((r) => r.serial.startsWith("server02:")) || undefined,
      30_000,
    )

    // Act
    await worker!.stop()
    const q = await h!.tickUntil(() => (done(live(qid)) ? live(qid) : undefined), 90_000)

    // Assert
    const infra = q.items
      .flatMap((i) => i.attempts)
      .filter((a) => a.robotOn === "server02" && a.status === "infra_error")
    expect([q.items.every((i) => i.status === "passed"), infra.length]).toEqual([true, 1])
  })

  it("BrowserStack com robot no worker: casos rodam lá, sessão marcada e link salvo", async () => {
    // Arrange
    await setup(0, 0, false)
    await h!.command({ type: "bs_add_slot", device: "Samsung Galaxy S22", osVersion: "12.0" })
    await h!.command({ type: "bs_set_enabled", enabled: true })
    const set = await h!.command({ type: "bs_set_run_on", machineId: "server02" })

    // Act
    const q = await runQueue((n) => ["CT_LOGIN_01-Caso-PASS", "CT_LOGIN_03-Caso-FAIL"].includes(n))

    // Assert
    const atts = q.items.flatMap((i) => i.attempts)
    const bs = JSON.parse(await fs.readFile(path.join(h!.dataDir, "fake", "browserstack.json"), "utf8"))
    expect([
      set.ok,
      atts.every((a) => a.machineId === "browserstack" && a.robotOn === "server02"),
      Object.values(bs.statuses).sort(),
      atts.every((a) => a.cloudUrl?.includes("/sessions/")),
    ]).toEqual([true, true, ["failed", "passed"], true])
  })

  it("BrowserStack com robot num worker fora do ar: casos esperam (não voltam a pesar no mestre)", async () => {
    // Arrange
    await setup(0, 0, false)
    await h!.command({ type: "bs_add_slot", device: "Samsung Galaxy S22", osVersion: "12.0" })
    await h!.command({ type: "bs_set_enabled", enabled: true })
    await h!.command({ type: "bs_set_run_on", machineId: "server02" })
    await h!.command({ type: "set_machine_enabled", id: "server02", enabled: false })
    const ids = await h!.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")

    // Act
    const qid = (await h!.command({ type: "create_queue", input: queueInput(ids) })).data!.queueId as string
    for (let i = 0; i < 10; i++) await h!.runner.tick()

    // Assert
    expect([live(qid)!.items[0].status, live(qid)!.items[0].attempts.length]).toEqual(["queued", 0])
  })
})
