import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { TERMINAL_ITEM_STATUSES } from "@/core/queue-logic"
import type { Queue } from "@/core/types"

import { type Harness, makeHarness, queueInput } from "./harness"

const GIAT = path.join(process.cwd(), "tests/fixtures/fake-giat")
let h: Harness
afterEach(async () => {
  delete process.env.QAFARM_GIAT_LEAK
  await h?.runner.shutdown()
  await h?.cleanup()
})

const finished = (q: Queue | undefined) => q && q.items.every((i) => TERMINAL_ITEM_STATUSES.has(i.status))
const liveQueue = (id: string) => h.runner.snapshotForTests().queues.find((q) => q.id === id)

describe("GI-App-Test nas filas", () => {
  it("fila do GI-App-Test roda os casos com run.mjs no Appium e porta do celular, em ambiente limpo", async () => {
    // Arrange
    process.env.QAFARM_GIAT_LEAK = "1" // não pode chegar ao run.mjs
    h = await makeHarness({ emulators: 2, giatDir: GIAT })
    await h.tickUntil(async () => (await h.readyCount()) >= 2 || undefined)
    await h.command({ type: "refresh_catalog", project: "giat" })
    const cat = JSON.parse(await fs.readFile(h.p.giatCatalog, "utf8")) as { entries: Array<{ id: string; name: string }> }

    // Act
    const created = await h.command({
      type: "create_queue",
      input: { ...queueInput(cat.entries.map((e) => e.id)), env: "hml", project: "giat", retries: 0 },
    })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    }, 30_000)

    // Assert
    const byName = Object.fromEntries(q.items.map((i) => [i.fileLongName, i.status]))
    const a = q.items.find((i) => i.fileLongName === "smoke/app_abre.mjs")!.attempts[0]
    const consoleLog = await fs.readFile(path.join(h.p.runs, a.dir, "console.log"), "utf8")
    const giatJson = JSON.parse(await fs.readFile(path.join(h.p.runs, a.dir, "giat.json"), "utf8"))
    expect([
      cat.entries.map((e) => e.name).sort(),
      q.project,
      byName,
      q.items.find((i) => i.fileLongName === "login/ct_login_02_FAIL.mjs")!.attempts[0].message,
      /· HML · http:\/\/127\.0\.0\.1:48\d\d\/wd\/hub · systemPort 82\d\d/.test(consoleLog),
      giatJson.results[0].leak,
    ]).toEqual([
      ["Caso app_abre", "Caso ct_login_01_valido", "Caso ct_login_02_FAIL", "Caso ct_login_03_INFRA", "Caso login"],
      "giat",
      {
        "flows/login.mjs": "passed",
        "login/ct_login_01_valido.mjs": "passed",
        "login/ct_login_02_FAIL.mjs": "failed",
        "login/ct_login_03_INFRA.mjs": "infra_error",
        "smoke/app_abre.mjs": "passed",
      },
      "Elemento 'Entrar' não apareceu",
      true,
      [],
    ])
  })

  it("recusa ambiente de outro projeto e GI-App-Test ausente no servidor", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0, giatDir: GIAT })
    const sem = await makeHarness({ emulators: 0 })

    // Act
    const wrongEnv = await h.command({ type: "create_queue", input: { ...queueInput(["giat:smoke/app_abre.mjs"]), env: "dev", project: "giat" } })
    const robotProd = await h.command({ type: "create_queue", input: { ...queueInput(["x"]), env: "prod" } })
    const missing = await sem.command({ type: "create_queue", input: { ...queueInput(["giat:smoke/app_abre.mjs"]), env: "hml", project: "giat" } })
    await sem.runner.shutdown()
    await sem.cleanup()

    // Assert
    expect([wrongEnv.ok, robotProd.ok, missing.ok]).toEqual([false, false, false])
  })
})
