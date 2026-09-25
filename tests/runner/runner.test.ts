import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { accountOverlaps, deviceOverlaps, peakConcurrency } from "@/core/overlap"
import { TERMINAL_ITEM_STATUSES } from "@/core/queue-logic"
import { readJson, writeJsonAtomic } from "@/core/store"
import { DevicesStateSchema, type Queue, RunnerStateSchema } from "@/core/types"
import { MetricsFileSchema } from "@/core/metrics"
import { readWorld } from "@/server/fake-world"

import { type Harness, makeHarness, queueInput } from "./harness"

let h: Harness
afterEach(async () => {
  await h?.runner.shutdown()
  await h?.cleanup()
})

const finished = (q: Queue | undefined) => q && q.items.every((i) => TERMINAL_ITEM_STATUSES.has(i.status))
const liveQueue = (id: string) => h.runner.snapshotForTests().queues.find((q) => q.id === id)

describe("runner (modo fake)", () => {
  it("ligar celulares deixa os emuladores prontos com o app pré-instalado", async () => {
    // Arrange
    h = await makeHarness()
    await h.command({ type: "create_queue", input: queueInput(await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")) })

    // Act
    const res = await h.command({ type: "start_devices", count: 3 })
    await h.tickUntil(async () => (await h.readyCount()) + h.runner.snapshotForTests().running.length >= 3 || undefined)

    // Assert
    const devs = h.runner.snapshotForTests().devices
    expect([res.ok, devs.filter((d) => d.kind === "emulator").length, devs.every((d) => d.appVersionCode === 5528)]).toEqual([
      true,
      3,
      true,
    ])
  })

  it("sem fila ativa, o APK enviado mais recente já é pré-instalado", async () => {
    // Arrange
    h = await makeHarness({ emulators: 2 })

    // Act
    await h.tickUntil(() => h.runner.snapshotForTests().devices.filter((d) => d.appVersionCode === 5528).length === 2 || undefined)

    // Assert
    expect(h.runner.snapshotForTests().devices.map((d) => [d.state, d.appVersionCode])).toEqual([
      ["ready", 5528],
      ["ready", 5528],
    ])
  })

  it("quando a fila termina, os celulares ficam na versão dela mesmo com um APK mais antigo enviado depois", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")
    const qid = (await h.command({ type: "create_queue", input: queueInput(ids) })).data!.queueId as string
    await h.tickUntil(() => finished(liveQueue(qid)) || undefined)
    const OLD = "app_20260925-100000_aaaaaa"
    await fs.mkdir(h.p.app(OLD), { recursive: true })
    await fs.writeFile(h.p.appApk(OLD), "PK-old")
    await writeJsonAtomic(h.p.appMeta(OLD), {
      id: OLD,
      originalName: "antigo.apk",
      package: "com.exemplo.App.hml",
      versionName: "7.25.2",
      versionCode: 5498,
      minSdk: 26,
      abis: ["x86_64"],
      launchableActivity: "com.exemplo.MainActivity",
      md5: "y",
      size: 6,
      uploadedAt: "2026-09-25T10:00:00.000Z",
    })

    // Act
    for (let i = 0; i < 8; i++) await h.runner.tick()

    // Assert
    const d = h.runner.snapshotForTests().devices[0]
    expect([d.state, d.appVersionCode]).toEqual(["ready", 5528])
  })

  it("celular pronto é configurado para não exibir diálogos de erro", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })

    // Act
    await h.tickUntil(async () => (await h.readyCount()) === 1 || undefined)

    // Assert
    const { readWorld } = await import("@/server/fake-world")
    const w = await readWorld(h.dataDir)
    expect(w.devices[0].settings).toEqual({ hide_error_dialogs: "1" })
  })

  it("diálogo de ANR na tela é fechado antes do caso e o caso roda normalmente", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    await h.tickUntil(async () => (await h.readyCount()) === 1 || undefined)
    await h.world((w) => {
      w.devices[0].dialog = "Application Not Responding: com.android.systemui"
    })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")

    // Act
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    })

    // Assert
    expect([q.items[0].status, h.logs.some((l) => l.startsWith("diálogo de erro fechado em emulator-5554"))]).toEqual(["passed", true])
  })

  it("diálogo de erro que não fecha manda o celular para manutenção e o caso roda em outro", async () => {
    // Arrange
    h = await makeHarness({ emulators: 2 })
    await h.tickUntil(async () => (await h.readyCount()) === 2 || undefined)
    await h.world((w) => {
      w.devices[0].dialog = "Application Not Responding: com.android.systemui PERSISTENTE"
    })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")

    // Act
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    })

    // Assert
    expect([q.items[0].attempts.map((a) => a.serial), h.logs.some((l) => l.includes("emulator-5554") && l.includes("→ manutenção"))]).toEqual([
      ["emulator-5556"],
      true,
    ])
  })

  it("muitos casos curtos terminando e começando juntos: nenhum resultado se perde", async () => {
    // Arrange
    h = await makeHarness({ emulators: 8, ioDelayMs: 40 })
    const pass = await h.catalogIds((n) => n.includes("PASS") && !n.includes("SLOW"))
    const ids = pass.slice(0, 30)

    // Act
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    }, 90_000)

    // Assert
    const onDisk = await h.queueFile(q.id)
    expect([q.status, onDisk?.items.every((i) => i.status === "passed" && i.attempts.length === 1)]).toEqual(["done", true])
  })

  it("aparelho físico aparece como externo e nunca recebe caso", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0, physical: ["FAKE-PHYSICAL-01"] })
    const ids = await h.catalogIds((n) => n.includes("PASS"))

    // Act
    const created = await h.command({ type: "create_queue", input: queueInput(ids.slice(0, 3)) })
    for (let i = 0; i < 20; i++) await h.runner.tick()

    // Assert
    const devs = h.runner.snapshotForTests().devices
    const q = liveQueue(created.data!.queueId as string)!
    expect([devs.map((d) => [d.serial, d.state]), q.items.every((i) => i.attempts.length === 0)]).toEqual([
      [["FAKE-PHYSICAL-01", "external"]],
      true,
    ])
  })

  it("aparelho físico ativado recebe o app e passa a receber casos", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0, physical: ["FAKE-PHYSICAL-01"] })
    await h.tickUntil(() => h.runner.snapshotForTests().devices.length === 1 || undefined)
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")

    // Act
    const res = await h.command({ type: "set_physical", serial: "FAKE-PHYSICAL-01", enabled: true })
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    })

    // Assert
    const d = h.runner.snapshotForTests().devices[0]
    expect([res.ok, q.items[0].attempts[0].serial, q.items[0].status, d.enabled, d.appVersionCode, d.index]).toEqual([
      true,
      "FAKE-PHYSICAL-01",
      "passed",
      true,
      5528,
      51,
    ])
  })

  it("aparelho físico não tem as configurações do sistema alteradas", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0, physical: ["FAKE-PHYSICAL-01"] })
    await h.tickUntil(() => h.runner.snapshotForTests().devices.length === 1 || undefined)

    // Act
    await h.command({ type: "set_physical", serial: "FAKE-PHYSICAL-01", enabled: true })
    await h.tickUntil(() => h.runner.snapshotForTests().devices[0]?.state === "ready" || undefined)

    // Assert
    const { readWorld } = await import("@/server/fake-world")
    expect((await readWorld(h.dataDir)).devices[0].settings).toBeUndefined()
  })

  it("aparelho físico com versão mais nova do app: avisa para desinstalar e não fica tentando instalar sem parar", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0, physical: ["FAKE-PHYSICAL-01"] })
    await h.tickUntil(() => h.runner.snapshotForTests().devices.length === 1 || undefined)
    await h.world((w) => {
      w.devices[0].installed["com.exemplo.App.hml"] = 6000
    })

    // Act
    await h.command({ type: "set_physical", serial: "FAKE-PHYSICAL-01", enabled: true })
    const d = await h.tickUntil(() => {
      const dev = h.runner.snapshotForTests().devices[0]
      return dev?.note?.includes("desinstale") ? dev : undefined
    })
    for (let i = 0; i < 5; i++) await h.runner.tick()

    // Assert
    const tries = h.logs.filter((l) => l.startsWith("instalando") && l.endsWith("FAKE-PHYSICAL-01")).length
    const world = await readWorld(h.dataDir)
    expect([d.state, tries, world.devices[0].installed["com.exemplo.App.hml"]]).toEqual(["installing", 1, 6000])
  })

  it("novo APK é instalado em vários celulares ao mesmo tempo (até 5)", async () => {
    // Arrange
    h = await makeHarness({ emulators: 4 })
    await h.tickUntil(async () => (await readWorld(h.dataDir)).devices.length === 4 || undefined)
    await h.world((w) => {
      w.installDelayMs = 1500
      for (const d of w.devices) d.installed = {}
    })

    // Act
    await h.tickUntil(() => h.logs.filter((l) => l.startsWith("instalando")).length >= 4 || undefined)

    // Assert
    const ready = h.runner.snapshotForTests().devices.filter((d) => d.state === "ready").length
    expect(ready).toBe(0)
  })

  it("emulador com versão mais nova do app volta para a versão da fila", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    await h.tickUntil(async () => (await readWorld(h.dataDir)).devices.length === 1 || undefined)
    await h.world((w) => {
      w.devices[0].installed["com.exemplo.App.hml"] = 6000
    })

    // Act
    const d = await h.tickUntil(() => {
      const dev = h.runner.snapshotForTests().devices[0]
      return dev?.state === "ready" ? dev : undefined
    })

    // Assert
    expect(d.appVersionCode).toBe(5528)
  })

  it("emulador desativado fica pronto mas não recebe casos; ativado de novo volta a receber", async () => {
    // Arrange
    h = await makeHarness({ emulators: 2 })
    await h.tickUntil(async () => (await h.readyCount()) >= 2 || undefined)
    await h.command({ type: "set_emulator_enabled", serial: "emulator-5554", enabled: false })
    const ids = await h.catalogIds((n) => ["CT_LOGIN_01-Caso-PASS", "CT_PIX_02-Caso-PASS", "CT_TED_02-Caso-PASS"].includes(n))

    // Act
    const created = await h.command({ type: "create_queue", input: { ...queueInput(ids), allowSameAccount: true } })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    }, 30_000)
    const disabled = h.runner.snapshotForTests().devices.find((d) => d.serial === "emulator-5554")!
    await h.command({ type: "set_emulator_enabled", serial: "emulator-5554", enabled: true })
    await h.tickUntil(() => h.runner.snapshotForTests().devices.find((d) => d.serial === "emulator-5554")?.enabled || undefined)

    // Assert
    const serials = new Set(q.items.flatMap((i) => i.attempts.map((a) => a.serial)))
    expect([[...serials], disabled.state, disabled.enabled]).toEqual([["emulator-5556"], "ready", false])
  })

  it("a escolha do emulador desativado sobrevive a um reinício do runner", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    await h.tickUntil(async () => (await h.readyCount()) >= 1 || undefined)

    // Act
    await h.command({ type: "set_emulator_enabled", serial: "emulator-5554", enabled: false })

    // Assert
    const saved = JSON.parse(await fs.readFile(h.p.emulatorsDisabled, "utf8"))
    expect(saved).toEqual({ disabled: ["emulator-5554"] })
  })

  it("desativar o aparelho físico devolve ele para externo", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0, physical: ["FAKE-PHYSICAL-01"] })
    await h.tickUntil(() => h.runner.snapshotForTests().devices.length === 1 || undefined)
    await h.command({ type: "set_physical", serial: "FAKE-PHYSICAL-01", enabled: true })
    await h.tickUntil(() => h.runner.snapshotForTests().devices[0]?.state === "ready" || undefined)

    // Act
    const res = await h.command({ type: "set_physical", serial: "FAKE-PHYSICAL-01", enabled: false })
    await h.tickUntil(() => h.runner.snapshotForTests().devices[0]?.state === "external" || undefined)

    // Assert
    const saved = JSON.parse(await fs.readFile(h.p.physical, "utf8"))
    expect([res.ok, h.runner.snapshotForTests().devices[0].enabled, saved]).toEqual([true, false, { enabled: {} }])
  })

  it("desativar aparelho físico com caso rodando é recusado", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0, physical: ["FAKE-PHYSICAL-01"] })
    await h.tickUntil(() => h.runner.snapshotForTests().devices.length === 1 || undefined)
    await h.command({ type: "set_physical", serial: "FAKE-PHYSICAL-01", enabled: true })
    await h.command({ type: "create_queue", input: queueInput(await h.catalogIds((n) => n.includes("TIMEOUT")), { timeoutSec: 600 }) })
    await h.tickUntil(() => h.runner.snapshotForTests().running.length === 1 || undefined)

    // Act
    const res = await h.command({ type: "set_physical", serial: "FAKE-PHYSICAL-01", enabled: false })

    // Assert
    expect([res.ok, res.message]).toEqual([false, "Celular ocupado com um caso; desative quando ele terminar"])
  })

  it("aparelho físico que desconecta no meio do caso: caso refeito e o aparelho não é reiniciado", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1, physical: ["FAKE-PHYSICAL-01"] })
    await h.tickUntil(() => h.runner.snapshotForTests().devices.length === 2 || undefined)
    await h.command({ type: "set_physical", serial: "FAKE-PHYSICAL-01", enabled: true })
    await h.tickUntil(async () => (await h.readyCount()) === 2 || undefined)
    await h.world((w) => {
      w.devices = w.devices.filter((d) => d.kind === "physical")
    }) // tira o emulador: o caso tem que ir para o físico
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_05-Caso-SLOW-PASS")
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    await h.tickUntil(() => h.runner.snapshotForTests().running[0]?.serial === "FAKE-PHYSICAL-01" || undefined)

    // Act
    await h.world((w) => {
      w.devices = w.devices.filter((d) => d.serial !== "FAKE-PHYSICAL-01")
    })
    await h.tickUntil(() => liveQueue(created.data!.queueId as string)!.items[0].attempts[0].status === "infra_error" || undefined)

    // Assert
    const dev = h.runner.snapshotForTests().devices.find((d) => d.serial === "FAKE-PHYSICAL-01")
    expect([dev?.state, dev?.enabled, h.logs.some((l) => l.includes("manutenção") && l.includes("FAKE"))]).toEqual(["offline", true, false])
  })

  it("fila roda todos os casos e registra passou, falhou e infra (com re-enfileiramento)", async () => {
    // Arrange
    h = await makeHarness({ emulators: 4 })
    const names = ["CT_LOGIN_01-Caso-PASS", "CT_LOGIN_03-Caso-FAIL", "CT_PIX_02-Caso-PASS", "CT_PIX_03-Caso-SLOW-PASS", "CT_PIX_05-Caso-INFRA"]
    const ids = await h.catalogIds((n) => names.includes(n))

    // Act
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    }, 30_000)

    // Assert
    const byName = Object.fromEntries(q.items.map((i) => [i.name, [i.status, i.attempts.length]]))
    expect(byName).toEqual({
      "CT_LOGIN_01-Caso-PASS": ["passed", 1],
      "CT_LOGIN_03-Caso-FAIL": ["failed", 1],
      "CT_PIX_02-Caso-PASS": ["passed", 1],
      "CT_PIX_03-Caso-SLOW-PASS": ["passed", 1],
      "CT_PIX_05-Caso-INFRA": ["infra_error", 4],
    })
  })

  it("cada tentativa roda no celular registrado (session.json) e guarda os arquivos", async () => {
    // Arrange
    h = await makeHarness({ emulators: 3 })
    const ids = await h.catalogIds((n) => n.includes("PASS"))

    // Act
    const created = await h.command({ type: "create_queue", input: queueInput(ids.slice(0, 6)) })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    }, 30_000)

    // Assert
    const checks = await Promise.all(
      q.items.map(async (it) => {
        const a = it.attempts[0]
        const dir = path.join(h.p.runs, a.dir)
        const session = JSON.parse(await fs.readFile(path.join(dir, "session.json"), "utf8"))
        const files = await fs.readdir(dir)
        return session.serial === a.serial && ["output.xml", "log.html", "report.html", "console.log", "result.json"].every((f) => files.includes(f))
      }),
    )
    expect(checks.every(Boolean)).toBe(true)
  })

  it("nunca roda dois casos da mesma conta ao mesmo tempo", async () => {
    // Arrange
    h = await makeHarness({ emulators: 5 })
    const ids = await h.catalogIds((n) => n.startsWith("CT_CARTOES") && !n.includes("INFRA") && !n.includes("FAIL"))

    // Act
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    }, 60_000)

    // Assert
    expect([accountOverlaps([q]), deviceOverlaps([q])]).toEqual([[], []])
  })

  it("fila com a mesma conta liberada roda casos da mesma conta em vários celulares ao mesmo tempo", async () => {
    // Arrange
    h = await makeHarness({ emulators: 4 })
    const ids = await h.catalogIds((n) => n.startsWith("CT_TED_") && n.includes("PASS"))
    const input = { ...queueInput(ids), allowSameAccount: true }

    // Act
    const created = await h.command({ type: "create_queue", input })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    }, 60_000)

    // Assert
    expect([peakConcurrency([q]) >= 3, deviceOverlaps([q])]).toEqual([true, []])
  })

  it("usa vários celulares ao mesmo tempo quando não há conflito de conta", async () => {
    // Arrange
    h = await makeHarness({ emulators: 4 })
    const ids = await h.catalogIds((n) => n.startsWith("CT_INVESTIMENTOS") && n.includes("PASS"))

    // Act
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    }, 60_000)

    // Assert
    expect(peakConcurrency([q])).toBeGreaterThanOrEqual(3)
  })

  it("caso que não existe no arquivo vira config_error sem nova tentativa", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const ids = await h.catalogIds((n) => n.includes("NOMATCH"))

    // Act
    const created = await h.command({ type: "create_queue", input: queueInput(ids, { retries: 2 }) })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    })

    // Assert
    expect([q.items[0].status, q.items[0].attempts.length]).toEqual(["config_error", 1])
  })

  it("falha com retries roda de novo em outro celular", async () => {
    // Arrange
    h = await makeHarness({ emulators: 2 })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_03-Caso-FAIL")

    // Act
    const created = await h.command({ type: "create_queue", input: queueInput(ids, { retries: 1 }) })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    })

    // Assert
    const [a1, a2] = q.items[0].attempts
    expect([q.items[0].attempts.length, a1.serial !== a2.serial, q.items[0].status]).toEqual([2, true, "failed"])
  })

  it("timeout mata o caso e libera o celular", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const ids = await h.catalogIds((n) => n.includes("TIMEOUT"))

    // Act
    const created = await h.command({ type: "create_queue", input: queueInput(ids, { timeoutSec: 10 }) })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    }, 30_000)
    await h.tickUntil(async () => (await h.readyCount()) === 1 || undefined)

    // Assert
    expect([q.items[0].status, h.runner.snapshotForTests().running.length]).toEqual(["timeout", 0])
  }, 40_000)

  it("cancelar interrompe os casos em execução e cancela os da fila", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const ids = await h.catalogIds((n) => n.includes("TIMEOUT") || n === "CT_LOGIN_01-Caso-PASS")
    const created = await h.command({ type: "create_queue", input: queueInput(ids, { timeoutSec: 600 }) })
    const qid = created.data!.queueId as string
    await h.tickUntil(() => h.runner.snapshotForTests().running.length === 1 || undefined)

    // Act
    const res = await h.command({ type: "cancel_queue", queueId: qid })
    const q = await h.tickUntil(() => {
      const live = liveQueue(qid)
      return finished(live) ? live : undefined
    })

    // Assert
    expect([res.ok, q.status, q.items.map((i) => i.status)]).toEqual([true, "canceled", ["canceled", "canceled"]])
  })

  it("pausar impede novos casos e continuar retoma", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const ids = await h.catalogIds((n) => n.startsWith("CT_PIX") && n.includes("PASS"))
    const created = await h.command({ type: "create_queue", input: queueInput(ids.slice(0, 3)) })
    const qid = created.data!.queueId as string

    // Act
    await h.command({ type: "pause_queue", queueId: qid })
    await h.tickUntil(() => h.runner.snapshotForTests().running.length === 0 || undefined)
    for (let i = 0; i < 10; i++) await h.runner.tick()
    const startedWhilePaused = liveQueue(qid)!.items.filter((i) => i.attempts.length > 0).length
    await h.command({ type: "resume_queue", queueId: qid })
    const q = await h.tickUntil(() => {
      const live = liveQueue(qid)
      return finished(live) ? live : undefined
    }, 30_000)

    // Assert
    expect([startedWhilePaused <= 1, q.status, q.items.every((i) => i.status === "passed")]).toEqual([true, "done", true])
  })

  it("re-rodar falhas cria uma fila só com os casos que falharam", async () => {
    // Arrange
    h = await makeHarness({ emulators: 2 })
    const ids = await h.catalogIds((n) => ["CT_LOGIN_01-Caso-PASS", "CT_LOGIN_03-Caso-FAIL"].includes(n))
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    const qid = created.data!.queueId as string
    await h.tickUntil(() => finished(liveQueue(qid)) || undefined)

    // Act
    const res = await h.command({ type: "rerun_failed", queueId: qid })

    // Assert
    const again = liveQueue(res.data!.queueId as string)!
    expect(again.items.map((i) => i.name)).toEqual(["CT_LOGIN_03-Caso-FAIL"])
  })

  it("com pouca memória livre no servidor o caso espera na fila e começa quando a memória volta", async () => {
    // Arrange
    h = await makeHarness({ emulators: 2 })
    await h.tickUntil(async () => (await h.readyCount()) >= 2 || undefined)
    await h.world((w) => {
      w.memAvailableMb = 1000
    })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")
    const qid = (await h.command({ type: "create_queue", input: queueInput(ids) })).data!.queueId as string
    for (let i = 0; i < 3; i++) await h.runner.tick()
    const waiting = liveQueue(qid)!.items[0].status

    // Act
    await h.world((w) => {
      w.memAvailableMb = 64_000
    })
    await h.tickUntil(() => finished(liveQueue(qid)) || undefined)

    // Assert
    expect([waiting, liveQueue(qid)!.items[0].status]).toEqual(["queued", "passed"])
  })

  it("com memória para um caso só, a rodada começa um caso e não vários de uma vez", async () => {
    // Arrange
    h = await makeHarness({ emulators: 3 })
    await h.tickUntil(async () => (await h.readyCount()) >= 3 || undefined)
    await h.world((w) => {
      w.memAvailableMb = 1600
    })
    const ids = await h.catalogIds((n) => ["CT_LOGIN_05-Caso-SLOW-PASS", "CT_PIX_03-Caso-SLOW-PASS", "CT_TED_01-Caso-SLOW-PASS"].includes(n))

    // Act
    await h.command({ type: "create_queue", input: queueInput(ids) }) // o mesmo tick já distribui os casos
    const running = h.runner.snapshotForTests().running

    // Assert
    expect(running).toHaveLength(1)
  })

  it("ao fim do caso o app é fechado e a tela do emulador apagada", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")
    const qid = (await h.command({ type: "create_queue", input: queueInput(ids) })).data!.queueId as string

    // Act
    await h.tickUntil(() => finished(liveQueue(qid)) || undefined)
    const d = await h.tickUntil(async () => {
      const dev = (await readWorld(h.dataDir)).devices.find((x) => x.serial === "emulator-5554")!
      return dev.screen === "off" && dev.forceStops?.length ? dev : undefined
    })

    // Assert
    expect([d.forceStops, d.screen, d.lockDisabled]).toEqual([["com.exemplo.App.hml"], "off", true])
  })

  it("fila com a opção desligada deixa o app aberto ao fim do caso", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")
    const input = { ...queueInput(ids), closeAppAfter: false }
    const qid = (await h.command({ type: "create_queue", input })).data!.queueId as string

    // Act
    await h.tickUntil(() => finished(liveQueue(qid)) || undefined)

    // Assert
    const d = (await readWorld(h.dataDir)).devices.find((x) => x.serial === "emulator-5554")!
    expect([d.forceStops ?? [], liveQueue(qid)!.options.closeAppAfter]).toEqual([[], false])
  })

  it("a tela do emulador acende antes do caso começar", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    await h.tickUntil(async () => (await h.readyCount()) >= 1 || undefined)
    const asleep = (await readWorld(h.dataDir)).devices[0].screen
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_05-Caso-SLOW-PASS")

    // Act
    await h.command({ type: "create_queue", input: queueInput(ids) })
    await h.tickUntil(() => h.runner.snapshotForTests().running[0])

    // Assert
    const d = (await readWorld(h.dataDir)).devices[0]
    expect([asleep, d.screen]).toEqual(["off", "on"])
  })

  it("processador quente segura casos novos, deixa o caso em andamento terminar e libera ao esfriar", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    await h.tickUntil(async () => (await h.readyCount()) >= 1 || undefined)
    const ids = await h.catalogIds((n) => ["CT_LOGIN_05-Caso-SLOW-PASS", "CT_PIX_02-Caso-PASS"].includes(n))
    const qid = (await h.command({ type: "create_queue", input: { ...queueInput(ids), allowSameAccount: true } })).data!.queueId as string
    await h.tickUntil(() => h.runner.snapshotForTests().running[0])
    await h.world((w) => {
      w.tempC = 90
    })

    // Act
    await h.tickUntil(() => liveQueue(qid)!.items.some((i) => i.status === "passed") || undefined)
    for (let i = 0; i < 5; i++) await h.runner.tick()
    const startedWhileHot = liveQueue(qid)!.items.filter((i) => i.attempts.length > 0).length
    await h.world((w) => {
      w.tempC = 50
    })
    await h.tickUntil(() => finished(liveQueue(qid)) || undefined)

    // Assert
    expect([startedWhileHot, liveQueue(qid)!.items.map((i) => i.status), h.logs.some((l) => l.includes("saúde crítica"))]).toEqual([
      1,
      ["passed", "passed"],
      true,
    ])
  })

  it("grava a saúde da máquina em state/metrics.json com o histórico", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    await h.world((w) => {
      w.tempC = 55
      w.cpuPct = 42
    })

    // Act
    await h.tickUntil(async () => {
      const m = await readJson(h.p.metrics, MetricsFileSchema.nullable(), null)
      return m?.machines[0]?.sample?.temp.packageC === 55 ? m : undefined
    })

    // Assert
    const m = (await readJson(h.p.metrics, MetricsFileSchema.nullable(), null))!
    expect([m.machines[0].id, m.machines[0].role, m.machines[0].sample!.cpuPct, m.machines[0].health.level]).toEqual([
      "server01",
      "master",
      42,
      "ok",
    ])
  })

  it("fila com esperas ×2 passa ao robot as esperas do projeto multiplicadas", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")

    // Act
    const qid = (await h.command({ type: "create_queue", input: { ...queueInput(ids), waitFactor: 2 } })).data!.queueId as string
    await h.tickUntil(() => finished(liveQueue(qid)) || undefined)

    // Assert
    const a = liveQueue(qid)!.items[0].attempts[0]
    const consoleText = await fs.readFile(path.join(h.p.runs, a.dir, "console.log"), "utf8")
    expect(consoleText).toContain("variáveis: TIMEOUT_S:4s TIMEOUT:10s TIMEOUT_M:18s TIMEOUT_L:40s")
  })

  it("aumentar as tentativas extras com a fila terminada roda de novo só os casos que falharam", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const ids = await h.catalogIds((n) => ["CT_LOGIN_01-Caso-PASS", "CT_LOGIN_03-Caso-FAIL"].includes(n))
    const qid = (await h.command({ type: "create_queue", input: { ...queueInput(ids), retries: 0 } })).data!.queueId as string
    await h.tickUntil(() => finished(liveQueue(qid)) || undefined)

    // Act
    const res = await h.command({ type: "set_queue_retries", queueId: qid, retries: 2 })
    await h.tickUntil(() => finished(liveQueue(qid)) || undefined)

    // Assert
    const q = liveQueue(qid)!
    expect([res.message, q.options.retries, q.items.map((i) => [i.name.slice(0, 11), i.attempts.length, i.status])]).toEqual([
      "Tentativas extras: 2 · 1 caso(s) com falha voltaram para a fila",
      2,
      [
        ["CT_LOGIN_01", 1, "passed"],
        ["CT_LOGIN_03", 3, "failed"],
      ],
    ])
  })

  it("limite de casos ao mesmo tempo: com máximo 1, três celulares livres rodam um caso por vez", async () => {
    // Arrange
    h = await makeHarness({ emulators: 3 })
    await h.tickUntil(async () => (await h.readyCount()) >= 3 || undefined)
    const set = await h.command({ type: "set_settings", maxParallel: 1 })
    const ids = await h.catalogIds((n) => n.includes("PASS") && !n.includes("SLOW")).then((x) => x.slice(0, 3))

    // Act
    const created = await h.command({ type: "create_queue", input: { ...queueInput(ids), allowSameAccount: true } })
    const q = await h.tickUntil(() => {
      const live = liveQueue(created.data!.queueId as string)
      return finished(live) ? live : undefined
    }, 30_000)

    // Assert
    expect([set.ok, peakConcurrency([q]), q.items.every((i) => i.status === "passed")]).toEqual([true, 1, true])
  })

  it("a massa usada no caso fica registrada na tentativa (conta e dados gerados)", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    const qid = created.data!.queueId as string

    // Act
    await h.tickUntil(() => finished(liveQueue(qid)) || undefined)

    // Assert
    const massa = liveQueue(qid)!.items[0].attempts[0].massa
    expect(massa?.map((m) => (m.kind === "conta" ? `${m.account}:${m.fields.username}` : `${m.var}=${m.value}`))).toEqual([
      "usuario_fake:fake@teste.com",
      "${cpf}=12345678909",
    ])
  })

  it("celular que cai no meio do caso gera infra_error e o caso termina em outro celular", async () => {
    // Arrange
    h = await makeHarness({ emulators: 2 })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_05-Caso-SLOW-PASS")
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    const qid = created.data!.queueId as string
    const first = await h.tickUntil(() => h.runner.snapshotForTests().running[0])

    // Act
    await h.world((w) => {
      w.devices = w.devices.filter((d) => d.serial !== first.serial)
    })
    const q = await h.tickUntil(() => {
      const live = liveQueue(qid)
      return finished(live) ? live : undefined
    }, 30_000)

    // Assert
    const [a1, a2] = q.items[0].attempts
    expect([a1.status, a1.serial, a2.serial !== a1.serial, q.items[0].status]).toEqual([
      "infra_error",
      first.serial,
      true,
      "passed",
    ])
  })

  it("celular que caiu é reiniciado e volta a ficar pronto", async () => {
    // Arrange
    h = await makeHarness({ emulators: 2 })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_05-Caso-SLOW-PASS")
    await h.command({ type: "create_queue", input: queueInput(ids) })
    const first = await h.tickUntil(() => h.runner.snapshotForTests().running[0])

    // Act
    await h.world((w) => {
      w.devices = w.devices.filter((d) => d.serial !== first.serial)
    })
    await h.tickUntil(() => h.runner.snapshotForTests().maintenance.length > 0 || undefined)
    await h.tickUntil(() => {
      const d = h.runner.snapshotForTests().devices.find((x) => x.serial === first.serial)
      return d?.state === "ready" || undefined
    }, 30_000)

    // Assert
    expect(h.runner.snapshotForTests().maintenance).toEqual([])
  })

  it("emulador que some do adb (sem caso rodando) é reiniciado sem esperar", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0 })
    await h.command({ type: "start_devices", count: 2 })
    await h.tickUntil(async () => (await h.readyCount()) === 2 || undefined, 30_000)

    // Act
    await h.world((w) => {
      w.devices = w.devices.filter((d) => d.serial !== "emulator-5556")
    })
    await h.tickUntil(() => h.logs.some((l) => l.includes("manutenção farm-2 (sumiu do adb)")) || undefined)
    await h.tickUntil(async () => (await h.readyCount()) === 2 || undefined, 30_000)

    // Assert
    expect(h.runner.snapshotForTests().maintenance).toEqual([])
  })

  it("um app por vez: fila com outro app é recusada enquanto há fila ativa", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0 })
    const ids = await h.catalogIds((n) => n.includes("PASS"))
    await h.command({ type: "create_queue", input: queueInput(ids.slice(0, 2)) })

    // Act
    const res = await h.command({ type: "create_queue", input: { ...queueInput(ids.slice(0, 2)), appId: "app_20260924-110000_ffffff" } })

    // Assert
    expect(res.ok).toBe(false)
  })

  it("ao reiniciar, casos que estavam rodando voltam para a fila", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const ids = await h.catalogIds((n) => n.includes("TIMEOUT"))
    const created = await h.command({ type: "create_queue", input: queueInput(ids, { timeoutSec: 600 }) })
    const qid = created.data!.queueId as string
    await h.tickUntil(() => h.runner.snapshotForTests().running.length === 1 || undefined)
    await h.runner.shutdown()
    const { Runner } = await import("@/runner/runner")
    const { createAdapters } = await import("@/server/adapters")

    // Act
    const second = new Runner(h.cfg, createAdapters(h.cfg), () => {})
    await second.init()

    // Assert
    const q = second.snapshotForTests().queues.find((x) => x.id === qid)!
    expect([q.items[0].status, q.items[0].attempts[0].status]).toEqual(["queued", "infra_error"])
    await second.shutdown()
    const state = await readJson(h.p.runnerState, RunnerStateSchema.nullable(), null)
    for (const pg of state?.pgids ?? []) {
      try {
        process.kill(-pg, "SIGKILL")
      } catch {
        /* ok */
      }
    }
  })

  it("ao reiniciar, tentativa que já tinha terminado aplica o resultado com o horário real de término", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    const qid = created.data!.queueId as string
    const done = await h.tickUntil(() => {
      const live = liveQueue(qid)
      return finished(live) ? live : undefined
    })
    await h.runner.shutdown()
    const stuck = { ...done, status: "running" as const, finishedAt: undefined, items: done.items.map((i) => ({ ...i, status: "running" as const, attempts: i.attempts.map((a) => ({ ...a, status: "running" as const })) })) }
    await writeJsonAtomic(h.p.queue(qid), stuck)
    const { Runner } = await import("@/runner/runner")
    const { createAdapters } = await import("@/server/adapters")

    // Act
    const second = new Runner(h.cfg, createAdapters(h.cfg), () => {})
    await second.init()

    // Assert
    const q = second.snapshotForTests().queues.find((x) => x.id === qid)!
    expect([q.status, q.items[0].status, q.items[0].attempts.length, q.items[0].attempts[0].endedAt]).toEqual([
      "done",
      "passed",
      1,
      done.items[0].attempts[0].endedAt, // término real, não a hora do reinício
    ])
    await second.shutdown()
  })

  it("grava o estado dos celulares e o heartbeat do runner", async () => {
    // Arrange
    h = await makeHarness({ emulators: 2, physical: ["FAKE-PHYSICAL-01"] })

    // Act
    await h.tickUntil(async () => (await h.readyCount()) === 2 || undefined)
    for (let i = 0; i < 3; i++) await h.runner.tick()

    // Assert
    const devices = await readJson(h.p.devicesState, DevicesStateSchema.nullable(), null)
    const runner = await readJson(h.p.runnerState, RunnerStateSchema.nullable(), null)
    expect([devices?.devices.length, runner?.fake, runner?.catalogStatus]).toEqual([3, true, "ready"])
  })

  it("rodar de novo um caso que falhou cria nova tentativa na mesma fila", async () => {
    // Arrange
    h = await makeHarness({ emulators: 2 })
    const ids = await h.catalogIds((n) => ["CT_LOGIN_01-Caso-PASS", "CT_LOGIN_03-Caso-FAIL"].includes(n))
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    const qid = created.data!.queueId as string
    const first = await h.tickUntil(() => {
      const live = liveQueue(qid)
      return finished(live) ? live : undefined
    })
    const failedItem = first.items.find((i) => i.status === "failed")!

    // Act
    const res = await h.command({ type: "retry_item", queueId: qid, itemId: failedItem.id })
    const again = await h.tickUntil(() => {
      const live = liveQueue(qid)
      return live && live.status === "done" && live.items.find((i) => i.id === failedItem.id)!.attempts.length === 2 ? live : undefined
    })

    // Assert
    const it2 = again.items.find((i) => i.id === failedItem.id)!
    expect([res.ok, it2.attempts.map((a) => a.status), again.items.find((i) => i.id !== failedItem.id)!.attempts.length]).toEqual([
      true,
      ["failed", "failed"],
      1,
    ])
  })

  it("rodar de novo um caso que passou é recusado", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    const qid = created.data!.queueId as string
    await h.tickUntil(() => finished(liveQueue(qid)) || undefined)

    // Act
    const res = await h.command({ type: "retry_item", queueId: qid, itemId: "i0001" })

    // Assert
    expect([res.ok, res.message]).toEqual([false, "Só é possível rodar de novo um caso que falhou"])
  })

  it("apagar fila concluída remove o arquivo e os logs das execuções", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })
    const qid = created.data!.queueId as string
    await h.tickUntil(() => finished(liveQueue(qid)) || undefined)

    // Act
    const res = await h.command({ type: "delete_queue", queueId: qid })

    // Assert
    const exists = (p: string) => fs.access(p).then(() => true, () => false)
    expect([res.ok, liveQueue(qid), await exists(h.p.queue(qid)), await exists(path.join(h.p.runs, qid))]).toEqual([true, undefined, false, false])
  })

  it("fila em andamento não pode ser apagada", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0 })
    const ids = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")
    const created = await h.command({ type: "create_queue", input: queueInput(ids) })

    // Act
    const res = await h.command({ type: "delete_queue", queueId: created.data!.queueId as string })

    // Assert
    expect([res.ok, res.message]).toEqual([false, "Cancele a fila antes de apagar"])
  })

  it("limpar tudo apaga as filas terminadas e mantém as em andamento", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    const pass = await h.catalogIds((n) => n === "CT_LOGIN_01-Caso-PASS")
    const done = await h.command({ type: "create_queue", input: queueInput(pass) })
    await h.tickUntil(() => finished(liveQueue(done.data!.queueId as string)) || undefined)
    const slow = await h.catalogIds((n) => n.includes("TIMEOUT"))
    const active = await h.command({ type: "create_queue", input: queueInput(slow, { timeoutSec: 600 }) })

    // Act
    const res = await h.command({ type: "clear_queues" })

    // Assert
    expect([res.ok, res.data, h.runner.snapshotForTests().queues.map((q) => q.id)]).toEqual([
      true,
      { deleted: 1, kept: 1 },
      [active.data!.queueId],
    ])
  })

  it("comando inválido é respondido com erro sem derrubar o runner", async () => {
    // Arrange
    h = await makeHarness()
    await writeJsonAtomic(h.p.command("cmd_20260924-100000_000000"), { lixo: true })

    // Act
    for (let i = 0; i < 3; i++) await h.runner.tick()

    // Assert
    const done = JSON.parse(await fs.readFile(h.p.commandDone("cmd_20260924-100000_000000"), "utf8"))
    expect([done.ok, done.message]).toEqual([false, "Comando inválido"])
  })
})
