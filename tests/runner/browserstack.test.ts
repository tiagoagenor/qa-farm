import fs from "node:fs/promises"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { Queue } from "@/core/types"

import { type Harness, makeHarness, queueInput } from "./harness"

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
})

const live = (id: string) => h!.runner.snapshotForTests().queues.find((q) => q.id === id)
const done = (q: Queue | undefined) => !!q && (q.status === "done" || q.status === "canceled")
const fakeBs = async () => JSON.parse(await fs.readFile(path.join(h!.dataDir, "fake", "browserstack.json"), "utf8").catch(() => "{}"))

async function withSlots(n: number, enabled = true, plan?: { running: number; max: number }) {
  h = await makeHarness({ emulators: 0 })
  if (plan) {
    await fs.mkdir(path.join(h.dataDir, "fake"), { recursive: true })
    await fs.writeFile(path.join(h.dataDir, "fake", "browserstack.json"), JSON.stringify({ ...plan, uploads: [], statuses: {}, deleted: [] }))
  }
  for (let i = 0; i < n; i++) await h.command({ type: "bs_add_slot", device: "Samsung Galaxy S22", osVersion: "12.0" })
  if (enabled) await h.command({ type: "bs_set_enabled", enabled: true })
}

describe("BrowserStack como fonte de celulares", () => {
  it("vagas ligadas recebem os casos; APK enviado uma vez; resultado marcado na sessão e link salvo", async () => {
    // Arrange
    await withSlots(2)
    await h!.tickUntil(() => h!.runner.snapshotForTests().devices.filter((d) => d.kind === "cloud" && d.state === "ready").length === 2 || undefined)
    const ids = await h!.catalogIds((n) => ["CT_LOGIN_01-Caso-PASS", "CT_LOGIN_03-Caso-FAIL", "CT_PIX_02-Caso-PASS"].includes(n))

    // Act
    const qid = (await h!.command({ type: "create_queue", input: { ...queueInput(ids), allowSameAccount: true } })).data!.queueId as string
    const q = await h!.tickUntil(() => (done(live(qid)) ? live(qid) : undefined), 30_000)

    // Assert
    const bs = await fakeBs()
    const atts = q.items.flatMap((i) => i.attempts)
    expect([
      atts.every((a) => a.machineId === "browserstack" && a.serial.startsWith("browserstack:")),
      bs.uploads.length,
      Object.values(bs.statuses).sort(),
      atts.every((a) => a.cloudUrl?.includes("/sessions/")),
    ]).toEqual([true, 1, ["failed", "passed", "passed"], true])
  })

  it("BrowserStack desligado: as vagas não recebem casos", async () => {
    // Arrange
    await withSlots(2, false)
    h = h!
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")

    // Act
    const qid = (await h.command({ type: "create_queue", input: queueInput(ids) })).data!.queueId as string
    for (let i = 0; i < 8; i++) await h.runner.tick()

    // Assert
    const cloud = h.runner.snapshotForTests().devices.filter((d) => d.kind === "cloud")
    expect([cloud.map((d) => d.state), live(qid)!.items[0].status]).toEqual([["offline", "offline"], "queued"])
  })

  it("conta cheia (sessões paralelas em uso pelo time): casos novos esperam", async () => {
    // Arrange
    await withSlots(2, true, { running: 8, max: 8 })
    await h!.tickUntil(() => h!.runner.snapshotForTests().devices.filter((d) => d.kind === "cloud" && d.state === "ready").length === 2 || undefined)
    const ids = await h!.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")

    // Act
    const qid = (await h!.command({ type: "create_queue", input: queueInput(ids) })).data!.queueId as string
    for (let i = 0; i < 8; i++) await h!.runner.tick()

    // Assert
    expect(live(qid)!.items[0].status).toBe("queued")
  })

  it("desativar uma vaga tira só ela; remover vaga ocupada é recusado", async () => {
    // Arrange
    await withSlots(2)

    // Act
    const off = await h!.command({ type: "bs_set_slot_enabled", id: 1, enabled: false })
    await h!.tickUntil(() => h!.runner.snapshotForTests().devices.find((d) => d.serial === "browserstack:1")?.enabled === false || undefined)

    // Assert
    const devs = h!.runner.snapshotForTests().devices.filter((d) => d.kind === "cloud")
    expect([off.ok, devs.map((d) => [d.serial, d.enabled])]).toEqual([
      true,
      [
        ["browserstack:1", false],
        ["browserstack:2", true],
      ],
    ])
  })
})
