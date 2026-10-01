import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { GiatStateSchema } from "@/core/giat"
import { readJson } from "@/core/store"
import { readWorld } from "@/server/fake-world"

import { type Harness, makeHarness, queueInput } from "./harness"

let h: Harness
let giatDir: string
afterEach(async () => {
  await h?.runner.shutdown()
  await h?.cleanup()
  if (giatDir) await fs.rm(giatDir, { recursive: true, force: true })
})

/** Projeto GI-App-Test de mentira: run.mjs respeita GIAT_ALLOWED_DEVICES e grava o --json como o real. */
async function fakeGiat(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "giat-"))
  await fs.mkdir(path.join(dir, "tests/smoke"), { recursive: true })
  await fs.mkdir(path.join(dir, "scripts"), { recursive: true })
  await fs.writeFile(path.join(dir, "tests/smoke/app_abre.mjs"), "")
  await fs.writeFile(path.join(dir, "tests/smoke/falha_FAIL.mjs"), "")
  await fs.writeFile(path.join(dir, "scripts/install-apk.mjs"), "process.exit(0)\n")
  await fs.writeFile(
    path.join(dir, "run.mjs"),
    `import fs from "node:fs"
const a = process.argv.slice(2)
const serial = a[a.indexOf("-d") + 1]
const json = a[a.indexOf("--json") + 1]
if (!(process.env.GIAT_ALLOWED_DEVICES || "").split(",").includes(serial)) process.exit(2)
fs.mkdirSync("logs/smoke", { recursive: true })
fs.writeFileSync("logs/smoke/r.json", JSON.stringify({ leak: "QAFARM_GIAT_LEAK" in process.env }))
const ok = !a[0].includes("FAIL")
fs.writeFileSync(json, JSON.stringify({ tests: [{ rel: a[0], ok, log: "logs/smoke/r.json" }] }))
console.log("rodou", a[0], "em", serial)
process.exit(ok ? 0 : 1)
`,
  )
  return dir
}

const giatState = () => readJson(h.p.giatState, GiatStateSchema, { reservations: {}, runs: [] })

describe("GI-App-Test na fazenda", () => {
  it("celular reservado sai das filas, roda o caso do GI-App-Test num ambiente limpo e volta ao liberar", async () => {
    // Arrange
    giatDir = await fakeGiat()
    process.env.QAFARM_GIAT_LEAK = "1"
    h = await makeHarness({ emulators: 2, giatDir })
    await h.tickUntil(async () => (await h.readyCount()) >= 2 || undefined)
    await h.command({ type: "giat_reserve", serial: "emulator-5554" })
    await h.tickUntil(() => h.runner.snapshotForTests().devices.find((d) => d.serial === "emulator-5554")?.state === "reserved" || undefined)
    const ids = await h.catalogIds((n) => /^CT_LOGIN_0[1-4]-Caso-PASS$/.test(n))
    const qid = (await h.command({ type: "create_queue", input: { ...queueInput(ids), allowSameAccount: true } })).data!.queueId as string

    // Act
    const started = await h.command({ type: "giat_run", serial: "emulator-5554", test: "smoke/app_abre.mjs", env: "HML" })
    const run = await h.tickUntil(async () => {
      const r = (await giatState()).runs[0]
      return r && r.status !== "installing" && r.status !== "running" ? r : undefined
    })
    await h.tickUntil(() => {
      const q = h.runner.snapshotForTests().queues.find((x) => x.id === qid)
      return q?.items.every((i) => i.status === "passed") || undefined
    })
    const leak = JSON.parse(await fs.readFile(path.join(h.p.giatRun(run.id), "r.json"), "utf8")).leak
    const released = await h.command({ type: "giat_release", serial: "emulator-5554" })
    await h.tickUntil(() => h.runner.snapshotForTests().devices.find((d) => d.serial === "emulator-5554")?.state === "ready" || undefined)

    // Assert
    const serials = h.runner.snapshotForTests().queues.find((x) => x.id === qid)!.items.flatMap((i) => i.attempts.map((a) => a.serial))
    expect([started.ok, run.status, run.summary, run.files, leak, serials.every((s) => s === "emulator-5556"), released.ok]).toEqual([
      true,
      "passed",
      { total: 1, passed: 1, failed: 0 },
      ["output.log", "result.json", "r.json"],
      false,
      true,
      true,
    ])
    delete process.env.QAFARM_GIAT_LEAK
  })

  it("recusa rodar em celular não reservado, caso fora de tests/ e desligar emuladores reservados", async () => {
    // Arrange
    giatDir = await fakeGiat()
    h = await makeHarness({ emulators: 1, giatDir })
    await h.tickUntil(async () => (await h.readyCount()) >= 1 || undefined)

    // Act
    const notReserved = await h.command({ type: "giat_run", serial: "emulator-5554", test: "smoke/app_abre.mjs", env: "HML" })
    await h.command({ type: "giat_reserve", serial: "emulator-5554" })
    await h.tickUntil(() => h.runner.snapshotForTests().devices[0]?.state === "reserved" || undefined)
    const badPath = await h.command({ type: "giat_run", serial: "emulator-5554", test: "../run.mjs", env: "HML" })
    const stopAll = await h.command({ type: "stop_all_devices" })

    // Assert
    expect([notReserved.ok, badPath.ok, stopAll.ok]).toEqual([false, false, false])
  })

  it("caso que falha fica como Falhou", async () => {
    // Arrange
    giatDir = await fakeGiat()
    h = await makeHarness({ emulators: 1, giatDir })
    await h.tickUntil(async () => (await h.readyCount()) >= 1 || undefined)
    await h.command({ type: "giat_reserve", serial: "emulator-5554" })
    await h.tickUntil(() => h.runner.snapshotForTests().devices[0]?.state === "reserved" || undefined)

    // Act
    await h.command({ type: "giat_run", serial: "emulator-5554", test: "smoke/falha_FAIL.mjs", env: "HML" })
    const run = await h.tickUntil(async () => {
      const r = (await giatState()).runs[0]
      return r && r.status !== "installing" && r.status !== "running" ? r : undefined
    })

    // Assert
    expect([run.status, run.exitCode]).toEqual(["failed", 1])
  })

  it("mesmo versionCode com outro build (md5 diferente) é reinstalado", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    await h.tickUntil(async () => (await h.readyCount()) >= 1 || undefined)
    await h.world((w) => {
      w.devices[0].apkMd5 = { "com.exemplo.App.hml": "ffffffffffffffffffffffffffffffff" }
    })

    // Act
    await h.command({ type: "giat_release", serial: "emulator-5554" }) // liberar faz a fazenda conferir o app de novo
    await h.tickUntil(async () => ((await readWorld(h.dataDir)).devices[0].installs ?? 0) >= 2 || undefined)
    await h.tickUntil(async () => (await h.readyCount()) >= 1 || undefined)

    // Assert
    const d = (await readWorld(h.dataDir)).devices[0]
    expect([d.installs, d.installed["com.exemplo.App.hml"], h.logs.some((l) => l.includes("instalando com.exemplo.App.hml 5528 em emulator-5554"))]).toEqual([
      2,
      5528,
      true,
    ])
  })

  it("mesmo versionCode e mesmo build: não reinstala", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    await h.tickUntil(async () => (await h.readyCount()) >= 1 || undefined)
    await h.world((w) => {
      w.devices[0].apkMd5 = { "com.exemplo.App.hml": "x" }
    })

    // Act
    await h.command({ type: "giat_release", serial: "emulator-5554" })
    for (let i = 0; i < 15; i++) {
      await h.runner.tick()
      await new Promise((r) => setTimeout(r, 40))
    }

    // Assert
    expect([(await readWorld(h.dataDir)).devices[0].installs, await h.readyCount()]).toEqual([1, 1])
  })
})
