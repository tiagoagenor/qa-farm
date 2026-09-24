import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import type { Config } from "@/core/config"
import { newId } from "@/core/ids"
import { parseMassa } from "@/core/massa"
import { nextPhysicalIndex, parseAdbDevices, serialFromIndex } from "@/core/parsers/adb-devices"
import { classifyRun } from "@/core/parsers/robot-output"
import { dataPaths } from "@/core/paths"
import { applyResult, buildQueue, cancelQueue, failedTestIds, finalizeIfDone, reopenItem } from "@/core/queue-logic"
import { buildRobotArgs, buildRobotEnv } from "@/core/robot-args"
import { type Assignment, schedule } from "@/core/scheduler"
import { listJsonFiles, readJson, writeJsonAtomic } from "@/core/store"
import {
  type AppMeta,
  AppMetaSchema,
  type Catalog,
  CatalogSchema,
  type Command,
  CommandEnvelopeSchema,
  type CommandResult,
  DesiredSchema,
  type Device,
  type DevicesState,
  PhysicalStateSchema,
  type Queue,
  QueueSchema,
  type RunnerState,
  RunnerStateSchema,
  RunResultSchema,
} from "@/core/types"
import type { Adapters } from "@/server/adapters"
import { killGroup } from "@/server/exec"
import type { FarmOp } from "@/server/farm"
import { describeOp } from "@/server/farm"
import type { Snapshot } from "@/server/snapshot"

type Log = (msg: string) => void

interface RunningAttempt {
  queueId: string
  itemId: string
  n: number
  serial: string
  index: number
  pgid: number
  dir: string
  qemuPid?: number
  timedOut: boolean
  canceled: boolean
  deviceLost: boolean
  physical: boolean
  timers: NodeJS.Timeout[]
}

const DEVICE_REFRESH_MS = 2000
/** Janelas de erro do Android que bloqueiam a tela (ANR / app parou). */
export const ERROR_DIALOG_RE = /Application Not Responding|Application Error|isn.t responding|has stopped|keeps stopping/i
const DESIRED_RETRY_MS = 5 * 60_000

export class Runner {
  private readonly p: ReturnType<typeof dataPaths>
  private queues = new Map<string, Queue>()
  private writeChains = new Map<string, Promise<void>>()
  private running = new Map<string, RunningAttempt>()
  private devices = new Map<string, Device>()
  private appVersions = new Map<string, number | undefined>() // serial → versionCode instalado
  private installing = new Set<string>()
  private prepared = new Set<string>() // celulares já configurados para testes (diálogos de erro desligados)
  private physical = new Map<string, number>() // aparelhos físicos ativados: serial → índice fixo
  private maintenance = new Map<number, { since: string; reason: string }>()
  private farmOps: FarmOp[] = []
  private farmBusy = false
  private farmJob?: { command: string; startedAt: string }
  private desired = 0
  private lastDesiredAttempt = 0
  private lastLowMemLog = 0
  private lastDeviceRefresh = 0
  private adbRaw = ""
  private catalog: Catalog | null = null
  private catalogStatus: RunnerState["catalogStatus"] = "missing"
  private catalogError?: string
  private snapshot: Snapshot | null = null
  private catalogBuild: Promise<void> | null = null
  private activeAppId?: string
  private appMetaCache = new Map<string, AppMeta | null>()
  private ticking = false
  private readonly startedAt = new Date().toISOString()

  constructor(
    private readonly cfg: Config,
    private readonly ad: Adapters,
    private readonly log: Log = (m) => console.log(`[runner ${new Date().toISOString()}] ${m}`),
    private readonly opts: { deviceRefreshMs?: number } = {},
  ) {
    this.p = dataPaths(cfg.dataDir)
  }

  // ------------------------------------------------------------ início ---
  async init(): Promise<void> {
    for (const d of [this.p.apps, this.p.queues, this.p.runs, this.p.commands, this.p.commandsDone, this.p.state, this.p.logs]) {
      await fsp.mkdir(d, { recursive: true })
    }
    // 1) mata processos robot que sobraram do runner anterior
    const prev = await readJson(this.p.runnerState, RunnerStateSchema.nullable(), null)
    for (const pgid of prev?.pgids ?? []) killGroup(pgid, "SIGKILL")
    this.activeAppId = prev?.activeAppId
    // 2) Appiums antigos (sessões presas) — sobem de novo sob demanda
    await this.ad.appium.killStray()
    // 3) filas: o que estava rodando volta para a fila
    const now = new Date().toISOString()
    for (const file of await listJsonFiles(this.p.queues)) {
      let q = await readJson(file, QueueSchema.nullable(), null)
      if (!q) continue
      const original = q
      for (const it of q.items) {
        if (it.status !== "running") continue
        const a = it.attempts.at(-1)
        // a tentativa terminou (result.json gravado) mas a fila não foi atualizada: aplica o resultado
        const res = a ? await readJson(path.join(this.p.runs, a.dir, "result.json"), RunResultSchema.nullable(), null) : null
        if (a && res) {
          q = applyResult(q, it.id, a.n, res, await this.resultTime(a.dir, res))
          continue
        }
        q = {
          ...q,
          items: q.items.map((x) =>
            x.id !== it.id
              ? x
              : {
                  ...x,
                  status: q!.status === "canceled" ? ("canceled" as const) : ("queued" as const),
                  attempts: x.attempts.map((t) =>
                    t.status === "running"
                      ? { ...t, status: "infra_error" as const, endedAt: now, message: "Runner reiniciado durante o caso", pgid: undefined }
                      : t,
                  ),
                },
          ),
        }
      }
      const fixed = finalizeIfDone(q, new Date())
      this.queues.set(fixed.id, fixed)
      if (fixed !== original) this.persistQueue(fixed.id)
    }
    this.desired = (await readJson(this.p.desired, DesiredSchema, { devices: 0 })).devices
    this.physical = new Map(Object.entries((await readJson(this.p.physical, PhysicalStateSchema, { enabled: {} })).enabled))
    this.catalog = await readJson(this.p.catalog, CatalogSchema.nullable(), null)
    this.catalogStatus = this.catalog ? "ready" : "missing"
    await this.pickActiveApp()
    void this.refreshCatalog(false)
    this.log(`iniciado (fake=${this.cfg.fake}) filas=${this.queues.size} desejados=${this.desired}`)
  }

  // -------------------------------------------------------------- loop ---
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.processCommands()
      if (Date.now() - this.lastDeviceRefresh >= (this.opts.deviceRefreshMs ?? DEVICE_REFRESH_MS)) {
        await this.refreshDevices()
        this.lastDeviceRefresh = Date.now()
      }
      this.reconcileFarm()
      this.processFarmOps()
      await this.reconcileOrphans()
      await this.dispatch()
      await this.writeRunnerState()
    } catch (e) {
      this.log(`erro no tick: ${(e as Error).stack ?? e}`)
    } finally {
      this.ticking = false
    }
  }

  async shutdown(): Promise<void> {
    await this.writeRunnerState()
    await Promise.all([...this.writeChains.values()])
  }

  // --------------------------------------------------------- persistência ---
  private persistQueue(id: string): void {
    const prev = this.writeChains.get(id) ?? Promise.resolve()
    const next = prev
      .then(async () => {
        const q = this.queues.get(id)
        if (q) await writeJsonAtomic(this.p.queue(id), q)
      })
      .catch((e) => this.log(`falha ao gravar fila ${id}: ${e}`))
    this.writeChains.set(id, next)
  }

  private setQueue(q: Queue): void {
    this.queues.set(q.id, q)
    this.persistQueue(q.id)
  }

  /**
   * Atualiza a fila a partir do estado ATUAL em memória (síncrono, sem await entre ler e gravar).
   * Nunca gravar uma cópia lida antes de um await: outra tentativa pode ter terminado no meio
   * e o resultado dela se perderia (bug real visto com 15 celulares).
   */
  private updateQueue(id: string, fn: (current: Queue) => Queue): Queue | undefined {
    const cur = this.queues.get(id)
    if (!cur) return undefined
    const next = fn(cur)
    this.setQueue(next)
    return next
  }

  private async writeRunnerState(): Promise<void> {
    const state: RunnerState = {
      pid: process.pid,
      startedAt: this.startedAt,
      heartbeatAt: new Date().toISOString(),
      fake: this.cfg.fake,
      activeAppId: this.activeAppId,
      pgids: [...this.running.values()].map((r) => r.pgid),
      farmJob: this.farmJob,
      catalogStatus: this.catalogStatus,
      catalogError: this.catalogError,
    }
    await writeJsonAtomic(this.p.runnerState, state)
  }

  private async appMeta(appId: string | undefined): Promise<AppMeta | null> {
    if (!appId) return null
    if (this.appMetaCache.has(appId)) return this.appMetaCache.get(appId) ?? null
    const meta = await readJson(this.p.appMeta(appId), AppMetaSchema.nullable(), null)
    if (meta) this.appMetaCache.set(appId, meta)
    return meta
  }

  /**
   * App ativo (um app por vez nos celulares): o da fila ativa mais antiga; sem fila ativa, o APK enviado
   * mais recentemente — assim ele já fica pré-instalado e a próxima fila começa sem esperar a instalação.
   */
  private async pickActiveApp(): Promise<void> {
    const active = [...this.queues.values()]
      .filter((q) => (q.status === "running" || q.status === "paused") && q.items.some((i) => i.status === "queued" || i.status === "running"))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    if (active) {
      this.activeAppId = active.appId
      return
    }
    const newest = await this.newestAppId()
    if (newest) this.activeAppId = newest
  }

  private async newestAppId(): Promise<string | undefined> {
    const dirs = await fsp.readdir(this.p.apps).catch(() => [] as string[])
    let best: AppMeta | null = null
    for (const d of dirs) {
      const m = await this.appMeta(d)
      if (m && (!best || m.uploadedAt > best.uploadedAt)) best = m
    }
    return best?.id
  }

  // ------------------------------------------------------------- catálogo ---
  private refreshCatalog(force: boolean): Promise<void> {
    if (this.catalogBuild) return this.catalogBuild
    this.catalogBuild = this.buildCatalog(force).finally(() => {
      this.catalogBuild = null
    })
    return this.catalogBuild
  }

  private async buildCatalog(force: boolean): Promise<void> {
    this.catalogStatus = "building"
    try {
      this.snapshot = await this.ad.snapshots.ensure()
      if (force || !this.catalog || this.catalog.snapshotHash !== this.snapshot.hash) {
        this.log(`gerando catálogo (snapshot ${this.snapshot.hash})`)
        this.catalog = await this.ad.catalog.build(this.snapshot.dir, this.snapshot.hash)
        this.log(`catálogo pronto: ${this.catalog.total} casos`)
      }
      this.catalogStatus = "ready"
      this.catalogError = undefined
      const keep = new Set([this.snapshot.hash, ...[...this.queues.values()].map((q) => q.snapshotHash ?? "")])
      await this.ad.snapshots.prune(keep)
    } catch (e) {
      this.catalogStatus = this.catalog ? "ready" : "error"
      this.catalogError = String((e as Error).message ?? e)
      this.log(`erro no catálogo: ${this.catalogError}`)
    }
  }

  // ------------------------------------------------------------ comandos ---
  private async processCommands(): Promise<void> {
    for (const file of await listJsonFiles(this.p.commands)) {
      const env = await readJson(file, CommandEnvelopeSchema.nullable(), null)
      const id = path.basename(file, ".json")
      let result: Omit<CommandResult, "id" | "createdAt" | "processedAt" | "command">
      if (!env) {
        result = { ok: false, message: "Comando inválido" }
      } else {
        try {
          result = await this.handle(env.command)
        } catch (e) {
          result = { ok: false, message: `Erro: ${(e as Error).message}` }
        }
      }
      const done: CommandResult = {
        id,
        createdAt: env?.createdAt ?? new Date().toISOString(),
        processedAt: new Date().toISOString(),
        command: env?.command ?? { type: "refresh_catalog" },
        ...result,
      }
      await writeJsonAtomic(this.p.commandDone(id), done)
      await fsp.rm(file, { force: true })
      this.log(`comando ${env?.command.type ?? "?"}: ${result.ok ? "ok" : "recusado"} — ${result.message}`)
    }
  }

  private async handle(c: Command): Promise<{ ok: boolean; message: string; data?: Record<string, unknown> }> {
    switch (c.type) {
      case "create_queue": {
        const meta = await this.appMeta(c.input.appId)
        if (!meta) return { ok: false, message: "App não encontrado" }
        const other = [...this.queues.values()].find(
          (q) => (q.status === "running" || q.status === "paused") && q.appId !== c.input.appId && q.items.some((i) => i.status === "queued" || i.status === "running"),
        )
        if (other) return { ok: false, message: `A fila "${other.name}" usa outro app. Um app por vez: aguarde, cancele ou use o mesmo app.` }
        if (!this.catalog && this.catalogBuild) await this.catalogBuild // 1ª geração ainda em andamento
        if (!this.catalog) return { ok: false, message: "Catálogo ainda não está pronto" }
        const snap = this.snapshot ?? (this.snapshot = await this.ad.snapshots.ensure())
        const byId = new Map(this.catalog.entries.map((e) => [e.id, e]))
        const { queue, missing } = buildQueue(newId("queue"), c.input, byId, new Date())
        if (queue.items.length === 0) return { ok: false, message: "Nenhum caso selecionado existe no catálogo atual" }
        this.setQueue({ ...queue, snapshotHash: snap.hash })
        await this.pickActiveApp()
        return {
          ok: true,
          message: `Fila criada com ${queue.items.length} caso(s)${missing.length ? ` (${missing.length} ignorado(s): não existem mais)` : ""}`,
          data: { queueId: queue.id, items: queue.items.length, missing },
        }
      }
      case "pause_queue":
      case "resume_queue": {
        const q = this.queues.get(c.queueId)
        if (!q) return { ok: false, message: "Fila não encontrada" }
        if (q.status === "done" || q.status === "canceled") return { ok: false, message: "Fila já terminou" }
        this.updateQueue(q.id, (cur) => ({ ...cur, status: c.type === "pause_queue" ? "paused" : "running" }))
        return { ok: true, message: c.type === "pause_queue" ? "Fila pausada" : "Fila retomada" }
      }
      case "cancel_queue": {
        const q = this.queues.get(c.queueId)
        if (!q) return { ok: false, message: "Fila não encontrada" }
        if (q.status === "done" || q.status === "canceled") return { ok: false, message: "Fila já terminou" }
        this.updateQueue(q.id, (cur) => cancelQueue(cur, new Date()))
        let killed = 0
        for (const ra of this.running.values()) {
          if (ra.queueId !== q.id) continue
          ra.canceled = true
          this.kill(ra)
          killed++
        }
        return { ok: true, message: `Fila cancelada${killed ? ` (${killed} caso(s) em execução interrompido(s))` : ""}` }
      }
      case "rerun_failed": {
        const q = this.queues.get(c.queueId)
        if (!q) return { ok: false, message: "Fila não encontrada" }
        const ids = failedTestIds(q)
        if (ids.length === 0) return { ok: false, message: "Não há falhas para rodar de novo" }
        return this.handle({
          type: "create_queue",
          input: { name: `${q.name} · re-run falhas`, appId: q.appId, env: q.env, timeoutSec: q.options.timeoutSec, retries: q.options.retries, testIds: ids },
        })
      }
      case "retry_item": {
        const q = this.queues.get(c.queueId)
        if (!q) return { ok: false, message: "Fila não encontrada" }
        const other = [...this.queues.values()].find(
          (x) => x.id !== q.id && (x.status === "running" || x.status === "paused") && x.appId !== q.appId && x.items.some((i) => i.status === "queued" || i.status === "running"),
        )
        if (other) return { ok: false, message: `A fila "${other.name}" usa outro app. Aguarde ou cancele antes de rodar este caso de novo.` }
        const it = q.items.find((i) => i.id === c.itemId)
        const reopened = this.updateQueue(q.id, (cur) => reopenItem(cur, c.itemId) ?? cur)
        if (!reopened || reopened.items.find((i) => i.id === c.itemId)?.status !== "queued") {
          return { ok: false, message: "Só é possível rodar de novo um caso que falhou" }
        }
        await this.pickActiveApp()
        return { ok: true, message: `"${it?.name}" voltou para a fila`, data: { queueId: q.id, itemId: c.itemId } }
      }
      case "delete_queue": {
        const q = this.queues.get(c.queueId)
        if (!q) return { ok: false, message: "Fila não encontrada" }
        if (q.status === "running" || q.status === "paused") return { ok: false, message: "Cancele a fila antes de apagar" }
        await this.deleteQueue(q.id)
        return { ok: true, message: `Fila "${q.name}" apagada` }
      }
      case "clear_queues": {
        const finished = [...this.queues.values()].filter((q) => q.status === "done" || q.status === "canceled")
        const active = this.queues.size - finished.length
        for (const q of finished) await this.deleteQueue(q.id)
        return {
          ok: true,
          message: `${finished.length} fila(s) apagada(s)${active ? `; ${active} em andamento mantida(s)` : ""}`,
          data: { deleted: finished.length, kept: active },
        }
      }
      case "start_devices": {
        this.desired = c.count
        await writeJsonAtomic(this.p.desired, { devices: c.count })
        this.farmOps.push({ kind: "start", count: c.count })
        this.lastDesiredAttempt = Date.now()
        return { ok: true, message: `Ligando ${c.count} celular(es)` }
      }
      case "stop_all_devices": {
        if (this.running.size > 0) return { ok: false, message: "Há casos em execução. Pause ou cancele as filas antes." }
        this.desired = 0
        await writeJsonAtomic(this.p.desired, { devices: 0 })
        this.farmOps = [{ kind: "stopAll" }]
        this.maintenance.clear()
        await this.ad.appium.stopAll()
        this.appVersions.clear()
        return { ok: true, message: "Desligando todos os celulares" }
      }
      case "restart_device": {
        const d = this.devices.get(c.serial)
        if (!d || d.kind !== "emulator" || !d.index) return { ok: false, message: "Só é possível reiniciar emuladores da fazenda" }
        if ([...this.running.values()].some((r) => r.serial === c.serial)) return { ok: false, message: "Celular ocupado com um caso" }
        this.restartDevice(d.index, "reinício pedido pelo usuário")
        return { ok: true, message: `Reiniciando ${c.serial}` }
      }
      case "set_physical": {
        const d = this.devices.get(c.serial)
        if (c.enabled) {
          if (!d) return { ok: false, message: "Aparelho não está conectado" }
          if (d.kind !== "physical") return { ok: false, message: "Só aparelhos físicos podem ser ativados" }
          if (!this.physical.has(c.serial)) this.physical.set(c.serial, nextPhysicalIndex(this.physical.values()))
          await writeJsonAtomic(this.p.physical, { enabled: Object.fromEntries(this.physical) })
          this.lastDeviceRefresh = 0
          return { ok: true, message: `${c.serial} ativado: vai receber casos (o app de teste será instalado nele)` }
        }
        if ([...this.running.values()].some((r) => r.serial === c.serial)) {
          return { ok: false, message: "Celular ocupado com um caso; desative quando ele terminar" }
        }
        this.physical.delete(c.serial)
        this.appVersions.delete(c.serial)
        this.prepared.delete(c.serial)
        await writeJsonAtomic(this.p.physical, { enabled: Object.fromEntries(this.physical) })
        this.lastDeviceRefresh = 0
        return { ok: true, message: `${c.serial} desativado: não recebe mais casos` }
      }
      case "restart_appiums": {
        if (this.running.size > 0) return { ok: false, message: "Há casos em execução. Pause ou cancele as filas antes." }
        await this.ad.appium.stopAll()
        return { ok: true, message: "Appiums reiniciados" }
      }
      case "delete_app": {
        const inUse = [...this.queues.values()].some((q) => q.appId === c.appId && (q.status === "running" || q.status === "paused"))
        if (inUse) return { ok: false, message: "App em uso por uma fila ativa" }
        await fsp.rm(this.p.app(c.appId), { recursive: true, force: true })
        this.appMetaCache.delete(c.appId)
        if (this.activeAppId === c.appId) this.activeAppId = undefined
        return { ok: true, message: "App apagado" }
      }
      case "refresh_catalog": {
        void this.refreshCatalog(true)
        return { ok: true, message: "Atualizando catálogo" }
      }
    }
  }

  /** Apaga a fila e todos os arquivos das execuções dela (logs, prints, output.xml). */
  private async deleteQueue(id: string): Promise<void> {
    await (this.writeChains.get(id) ?? Promise.resolve()) // termina gravação pendente antes de apagar
    this.queues.delete(id)
    this.writeChains.delete(id)
    await fsp.rm(this.p.queue(id), { force: true })
    await fsp.rm(path.join(this.p.runs, id), { recursive: true, force: true })
    this.log(`fila ${id} apagada`)
  }

  // ------------------------------------------------------------- celulares ---
  private restartDevice(index: number, reason: string): void {
    if (this.maintenance.has(index)) return
    this.maintenance.set(index, { since: new Date().toISOString(), reason })
    const serial = serialFromIndex(index)
    this.appVersions.delete(serial)
    this.prepared.delete(serial)
    this.farmOps.push({ kind: "stopOne", index }, { kind: "startOne", index })
    this.log(`manutenção farm-${index} (${reason})`)
  }

  private async refreshDevices(): Promise<void> {
    this.adbRaw = await this.ad.adb.devicesRaw()
    const parsed = parseAdbDevices(this.adbRaw)
    const qemu = await this.ad.farm.qemuPids()
    const meta = await this.appMeta(this.activeAppId)
    const busyBySerial = new Map([...this.running.values()].map((r) => [r.serial, r]))
    const now = new Date().toISOString()
    const next = new Map<string, Device>()

    // celular sumiu ou qemu trocou durante um caso → infra
    for (const ra of this.running.values()) {
      if (ra.deviceLost) continue
      const d = parsed.find((x) => x.serial === ra.serial)
      const pid = qemu.get(ra.index)
      if (!d || d.adbState !== "device" || (ra.qemuPid && pid !== ra.qemuPid)) {
        ra.deviceLost = true
        this.log(`celular ${ra.serial} caiu durante ${ra.queueId}/${ra.itemId}`)
        this.kill(ra)
        if (!ra.physical) this.restartDevice(ra.index, "caiu durante um caso") // aparelho físico nunca é reiniciado
      }
    }

    const readyChecks: Promise<void>[] = []
    for (const d of parsed) {
      const base: Device = {
        serial: d.serial,
        kind: d.kind,
        adbState: d.adbState,
        index: d.index,
        name: d.index ? `farm-${String(d.index).padStart(2, "0")}` : undefined,
        model: d.model,
        state: "offline",
        qemuPid: d.index ? qemu.get(d.index) : undefined,
        updatedAt: now,
      }
      const isPhysical = d.kind === "physical"
      if (isPhysical && !this.physical.has(d.serial)) {
        next.set(d.serial, { ...base, state: "external", enabled: false })
        continue
      }
      const idx = isPhysical ? this.physical.get(d.serial)! : d.index!
      if (isPhysical) Object.assign(base, { index: idx, name: d.model ?? d.serial, enabled: true })
      const ra = busyBySerial.get(d.serial)
      if (!isPhysical && this.maintenance.has(idx)) {
        next.set(d.serial, { ...base, state: "maintenance", note: this.maintenance.get(idx)!.reason })
        continue
      }
      if (ra) {
        const q = this.queues.get(ra.queueId)
        const it = q?.items.find((i) => i.id === ra.itemId)
        next.set(d.serial, {
          ...base,
          state: "busy",
          appVersionCode: this.appVersions.get(d.serial),
          currentQueueId: ra.queueId,
          currentItemId: ra.itemId,
          currentTestName: it?.name,
        })
        continue
      }
      if (d.adbState !== "device") {
        const hint = d.adbState === "unauthorized" ? " — autorize a depuração USB no celular" : ""
        next.set(d.serial, { ...base, state: base.qemuPid ? "booting" : "offline", note: `adb: ${d.adbState}${hint}` })
        continue
      }
      readyChecks.push(
        (async () => {
          const prev = this.devices.get(d.serial)
          const booted = prev && (prev.state === "ready" || prev.state === "installing") ? true : await this.ad.adb.bootCompleted(d.serial)
          if (!booted) {
            next.set(d.serial, { ...base, state: "booting" })
            return
          }
          await this.ad.appium.ensure(idx)
          if (!(await this.ad.appium.isReady(idx))) {
            next.set(d.serial, { ...base, state: "installing", note: "Iniciando Appium" })
            return
          }
          if (meta) {
            if (!this.appVersions.has(d.serial)) {
              this.appVersions.set(d.serial, await this.ad.adb.versionCode(d.serial, meta.package))
            }
            const vc = this.appVersions.get(d.serial)
            if (vc !== meta.versionCode) {
              this.startInstall(d.serial, meta)
              next.set(d.serial, { ...base, state: "installing", appVersionCode: vc, note: `Instalando ${meta.versionName} (${meta.versionCode})` })
              return
            }
          }
          if (!this.prepared.has(d.serial)) {
            // ANR do System UI no boot deixa um diálogo na tela que bloqueia todos os casos daquele celular.
            // Aparelho físico: não mexemos nas configurações do sistema dele (só fechamos diálogos antes de cada caso).
            if (!isPhysical) await this.ad.adb.putGlobalSetting(d.serial, "hide_error_dialogs", "1")
            await this.ad.adb.closeSystemDialogs(d.serial)
            this.prepared.add(d.serial)
          }
          next.set(d.serial, { ...base, state: "ready", appVersionCode: this.appVersions.get(d.serial) })
        })(),
      )
    }
    await Promise.all(readyChecks)

    // emulador que estava na fazenda e sumiu do adb (qemu morreu) → reinicia já, sem esperar a reconciliação
    const stopping = this.farmOps.some((o) => o.kind === "stopAll") || this.farmJob?.command === "desligar todos"
    for (const prev of this.devices.values()) {
      const idx = prev.index
      if (prev.kind !== "emulator" || !idx || next.has(prev.serial) || this.maintenance.has(idx)) continue
      if (stopping || idx > this.desired || prev.state === "maintenance") continue
      this.restartDevice(idx, "sumiu do adb")
    }

    // aparelho físico ativado mas desconectado continua visível (e ativado)
    for (const [serial, idx] of this.physical) {
      if (next.has(serial)) continue
      next.set(serial, { serial, kind: "physical", adbState: "missing", index: idx, name: serial, state: "offline", enabled: true, note: "Desconectado do USB", updatedAt: now })
    }

    // emuladores em manutenção que nem aparecem no adb continuam visíveis
    for (const [idx, m] of this.maintenance) {
      const serial = serialFromIndex(idx)
      if (!next.has(serial)) {
        next.set(serial, {
          serial,
          kind: "emulator",
          adbState: "missing",
          index: idx,
          name: `farm-${String(idx).padStart(2, "0")}`,
          state: "maintenance",
          note: m.reason,
          updatedAt: now,
        })
      }
    }
    this.devices = next
    const appiumReady: Record<string, boolean> = {}
    for (const d of next.values()) if (d.index) appiumReady[d.serial] = d.state === "ready" || d.state === "busy"
    const state: DevicesState = {
      updatedAt: now,
      devices: [...next.values()].sort(
        (a, b) => (a.kind === b.kind ? (a.index ?? 0) - (b.index ?? 0) : a.kind === "emulator" ? -1 : 1),
      ),
      adbRaw: this.adbRaw,
      appiumReady,
    }
    await writeJsonAtomic(this.p.devicesState, state)
  }

  private startInstall(serial: string, meta: AppMeta): void {
    if (this.installing.has(serial) || this.installing.size >= this.cfg.installConcurrency) return
    this.installing.add(serial)
    const apk = this.p.appApk(meta.id)
    this.log(`instalando ${meta.package} ${meta.versionCode} em ${serial}`)
    void this.ad.adb
      .install(serial, apk, meta.package, meta.versionCode)
      .then(async (r) => {
        if (!r.ok) this.log(`falha ao instalar em ${serial}: ${r.output.slice(-300)}`)
        this.appVersions.set(serial, await this.ad.adb.versionCode(serial, meta.package))
      })
      .finally(() => this.installing.delete(serial))
  }

  // ---------------------------------------------------------------- fazenda ---
  private reconcileFarm(): void {
    if (this.desired <= 0 || this.farmBusy || this.farmOps.length > 0) return
    if (Date.now() - this.lastDesiredAttempt < DESIRED_RETRY_MS) return
    const present = new Set([...this.devices.values()].filter((d) => d.kind === "emulator").map((d) => d.index))
    const missing = Array.from({ length: this.desired }, (_, k) => k + 1).filter((i) => !present.has(i) && !this.maintenance.has(i))
    if (missing.length === 0) return
    this.lastDesiredAttempt = Date.now()
    this.log(`faltam celulares ${missing.join(",")} (desejado ${this.desired}) → ligando`)
    this.farmOps.push({ kind: "start", count: this.desired })
  }

  private processFarmOps(): void {
    if (this.farmBusy || this.farmOps.length === 0) return
    const op = this.farmOps.shift()!
    this.farmBusy = true
    this.farmJob = { command: describeOp(op), startedAt: new Date().toISOString() }
    this.log(`fazenda: ${describeOp(op)}`)
    void this.ad.farm
      .exec(op, path.join(this.p.logs, "farm.log"))
      .then((r) => {
        this.log(`fazenda: ${describeOp(op)} → ${r.ok ? "ok" : `código ${r.code}`}`)
        if (op.kind === "startOne") this.maintenance.delete(op.index)
      })
      .finally(() => {
        this.farmBusy = false
        this.farmJob = undefined
        this.lastDeviceRefresh = 0
      })
  }

  /** Término real de uma tentativa recuperada: finishedAt do result.json, ou a data do arquivo. */
  private async resultTime(dir: string, res: { finishedAt?: string }): Promise<Date> {
    if (res.finishedAt) return new Date(res.finishedAt)
    const st = await fsp.stat(path.join(this.p.runs, dir, "result.json")).catch(() => null)
    return st ? st.mtime : new Date()
  }

  // -------------------------------------------------------------- execução ---
  /**
   * Rede de segurança: item "rodando" sem processo acompanhado pelo runner. Se a tentativa deixou
   * result.json, aplica o resultado; senão volta para a fila como erro de infraestrutura.
   */
  private async reconcileOrphans(): Promise<void> {
    for (const q of this.queues.values()) {
      for (const it of q.items) {
        if (it.status !== "running" || this.running.has(`${q.id}/${it.id}`)) continue
        const a = it.attempts.at(-1)
        if (!a) continue
        const res = await readJson(path.join(this.p.runs, a.dir, "result.json"), RunResultSchema.nullable(), null)
        if (this.running.has(`${q.id}/${it.id}`)) continue // começou de novo enquanto líamos
        const result = res ?? { status: "infra_error" as const, message: "Tentativa perdida pelo runner", screenshots: [], hasOutputXml: false }
        this.log(`reconciliado ${q.id}/${it.id}: ${result.status}${res ? " (result.json)" : " (sem result.json)"}`)
        const at = res ? await this.resultTime(a.dir, res) : new Date()
        this.updateQueue(q.id, (cur) => applyResult(cur, it.id, a.n, result, at))
      }
    }
  }

  private async dispatch(): Promise<void> {
    await this.pickActiveApp()
    const free = [...this.devices.values()]
      .filter((d) => (d.kind === "emulator" || d.enabled) && d.state === "ready" && d.index && ![...this.running.values()].some((r) => r.serial === d.serial))
      .map((d) => ({ serial: d.serial, index: d.index! }))
    if (free.length === 0) return
    const queues = [...this.queues.values()].filter((q) => q.appId === this.activeAppId)
    const running = [...this.running.values()].map((r) => {
      const it = this.queues.get(r.queueId)?.items.find((i) => i.id === r.itemId)
      return { queueId: r.queueId, itemId: r.itemId, serial: r.serial, accounts: it?.accounts ?? [] }
    })
    let memMb = await this.ad.farm.memAvailableMb()
    for (const a of schedule(queues, free, running)) {
      // sem memória livre, o caso espera na fila: com emuladores rodando teste o servidor pode travar (OOM)
      if (memMb < this.cfg.minFreeMemMb) {
        if (Date.now() - this.lastLowMemLog > 60_000) {
          this.lastLowMemLog = Date.now()
          this.log(`memória livre baixa (${memMb} MB < ${this.cfg.minFreeMemMb} MB): novos casos aguardam`)
        }
        break
      }
      const dev = free.find((f) => f.serial === a.serial)!
      if (!(await this.preflight(a.serial, dev.index))) continue // caso continua na fila para outro celular
      await this.startAttempt(a, dev.index)
      memMb -= this.cfg.caseMemMb
    }
  }

  /** Antes de cada caso: fecha diálogo de erro na tela; se não fechar, o celular vai para manutenção. */
  private async preflight(serial: string, index: number): Promise<boolean> {
    const focus = await this.ad.adb.focusedWindow(serial)
    if (!ERROR_DIALOG_RE.test(focus)) return true
    await this.ad.adb.closeSystemDialogs(serial)
    const after = await this.ad.adb.focusedWindow(serial)
    if (!ERROR_DIALOG_RE.test(after)) {
      this.log(`diálogo de erro fechado em ${serial}: "${focus}"`)
      return true
    }
    if (this.physical.has(serial)) {
      this.log(`diálogo de erro não fecha no aparelho físico ${serial}: "${after}" — caso fica na fila`)
      return false
    }
    this.log(`diálogo de erro não fecha em ${serial}: "${after}" → manutenção`)
    this.restartDevice(index, `diálogo de erro na tela: ${after}`)
    const d = this.devices.get(serial)
    if (d) this.devices.set(serial, { ...d, state: "maintenance", note: after })
    return false
  }

  private async startAttempt(a: Assignment, index: number): Promise<void> {
    const q = this.queues.get(a.queueId)
    const it = q?.items.find((i) => i.id === a.itemId)
    const meta = await this.appMeta(q?.appId)
    if (!q || !it || !meta) return
    let snap = this.snapshot
    if (!snap || (q.snapshotHash && snap.hash !== q.snapshotHash)) {
      const dir = path.join(this.p.workspaces, q.snapshotHash ?? "")
      snap = q.snapshotHash && fs.existsSync(dir) ? { hash: q.snapshotHash, dir } : await this.ad.snapshots.ensure()
    }
    if (this.cfg.fake) snap = await this.ad.snapshots.ensure()
    const n = it.attempts.length + 1
    const dir = this.p.attemptDir(q.id, it.id, n)
    await fsp.mkdir(dir, { recursive: true })
    const baseEnv = {
      PATH: [
        path.join(this.cfg.sdkRoot, "platform-tools"),
        path.dirname(this.cfg.appiumBin),
        path.join(this.cfg.javaHome, "bin"),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ].join(":"),
      HOME: process.env.HOME ?? "",
      LANG: "C.UTF-8",
      ANDROID_HOME: this.cfg.sdkRoot,
      ANDROID_SDK_ROOT: this.cfg.sdkRoot,
      JAVA_HOME: this.cfg.javaHome,
    }
    const env = buildRobotEnv(baseEnv, {
      AMBIENTE: q.env,
      QAFARM_SERIAL: a.serial,
      QAFARM_INDEX: String(index),
      QAFARM_APPIUM_URL: this.ad.appium.url(index),
      QAFARM_APP_PACKAGE: meta.package,
      QAFARM_APP_ACTIVITY: meta.launchableActivity,
    })
    const args = buildRobotArgs({
      listenerPath: path.join(this.cfg.repoRoot, "scripts/robot/qafarm_listener.py"),
      massaListenerPath: path.join(this.cfg.repoRoot, "scripts/robot/qafarm_massa.py"),
      env: q.env,
      fileLongName: it.fileLongName,
      outputDir: dir,
      suiteFile: it.file,
    })
    const spawned = this.ad.robot.spawn({ args, env, cwd: snap.dir, consoleFile: path.join(dir, "console.log") })
    const startedAt = new Date().toISOString()
    const relDir = path.relative(this.p.runs, dir)
    const qemuPid = (await this.ad.farm.qemuPids()).get(index)
    const ra: RunningAttempt = {
      queueId: q.id,
      itemId: it.id,
      n,
      serial: a.serial,
      index,
      pgid: spawned.pid,
      dir,
      qemuPid,
      timedOut: false,
      canceled: false,
      deviceLost: false,
      physical: this.physical.has(a.serial),
      timers: [],
    }
    this.running.set(`${q.id}/${it.id}`, ra)
    this.updateQueue(q.id, (cur) => ({
      ...cur,
      items: cur.items.map((i) =>
        i.id === it.id
          ? { ...i, status: "running", attempts: [...i.attempts, { n, serial: a.serial, startedAt, status: "running", dir: relDir, pgid: spawned.pid }] }
          : i,
      ),
    }))
    this.devices.set(a.serial, { ...this.devices.get(a.serial)!, state: "busy", currentQueueId: q.id, currentItemId: it.id, currentTestName: it.name })
    ra.timers.push(
      setTimeout(() => {
        ra.timedOut = true
        this.log(`timeout ${q.id}/${it.id} em ${a.serial}`)
        this.kill(ra)
      }, q.options.timeoutSec * 1000),
    )
    this.log(`▶ ${q.id}/${it.id} "${it.name}" em ${a.serial} (tentativa ${n})`)
    void spawned.exited.then((res) => this.finishAttempt(ra, res.code))
  }

  private kill(ra: RunningAttempt): void {
    killGroup(ra.pgid, "SIGTERM")
    ra.timers.push(setTimeout(() => killGroup(ra.pgid, "SIGKILL"), 10_000))
  }

  private async finishAttempt(ra: RunningAttempt, exitCode: number | null): Promise<void> {
    for (const t of ra.timers) clearTimeout(t)
    killGroup(ra.pgid, "SIGKILL") // garante que nenhum filho ficou para trás
    const read = (f: string) => fsp.readFile(path.join(ra.dir, f), "utf8").catch(() => undefined)
    const outputXml = await read("output.xml")
    const consoleFull = (await read("console.log")) ?? ""
    const files = await fsp.readdir(ra.dir).catch(() => [] as string[])
    const result = classifyRun({
      exitCode,
      canceled: ra.canceled,
      timedOut: ra.timedOut,
      deviceLost: ra.deviceLost,
      outputXml,
      consoleText: consoleFull.slice(-64 * 1024),
      screenshots: files.filter((f) => /\.(png|jpe?g)$/i.test(f)).sort(),
    })
    const massa = parseMassa(await read("massa.json"))
    if (massa.length) result.massa = massa
    const finishedAt = new Date()
    await writeJsonAtomic(path.join(ra.dir, "result.json"), { ...result, finishedAt: finishedAt.toISOString() })
    // sessão órfã (timeout/cancelamento/robot morto) ocuparia as portas do celular no Appium compartilhado
    const removed = await this.ad.appium.cleanupSessions(ra.index, ra.serial)
    if (removed) this.log(`${removed} sessão(ões) do Appium encerrada(s) para ${ra.serial}`)
    this.running.delete(`${ra.queueId}/${ra.itemId}`)
    this.updateQueue(ra.queueId, (cur) => applyResult(cur, ra.itemId, ra.n, result, finishedAt))
    this.log(`■ ${ra.queueId}/${ra.itemId} em ${ra.serial}: ${result.status}${result.message ? ` — ${result.message.split("\n")[0].slice(0, 160)}` : ""}`)
    const d = this.devices.get(ra.serial)
    if (d && d.state === "busy") this.devices.set(ra.serial, { ...d, state: "ready", currentItemId: undefined, currentQueueId: undefined, currentTestName: undefined })
    if (result.status === "infra_error" && !ra.deviceLost) {
      // sessão não abriu: recomeça o Appium desse celular antes de usá-lo de novo
      this.appVersions.delete(ra.serial)
    }
  }

  /** Mata todos os robots em execução (usado em testes e na limpeza). */
  killAllRunning(): void {
    for (const ra of this.running.values()) {
      for (const t of ra.timers) clearTimeout(t)
      killGroup(ra.pgid, "SIGKILL")
    }
  }

  /** Para testes: estado interno resumido. */
  snapshotForTests() {
    return {
      running: [...this.running.values()].map((r) => ({ queueId: r.queueId, itemId: r.itemId, serial: r.serial })),
      devices: [...this.devices.values()],
      queues: [...this.queues.values()],
      desired: this.desired,
      maintenance: [...this.maintenance.keys()],
    }
  }
}

