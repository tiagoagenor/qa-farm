import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import { RUN_OUT, RUN_REPO } from "@/core/agent-protocol"
import { type GitOp, maskSecrets, type ProjectGitState } from "@/core/project-git"
import type { Config } from "@/core/config"
import { newId } from "@/core/ids"
import { deviceKey, dispatchBudget, globalIndex, interleaveByMachine, parseDeviceKey, splitIndex } from "@/core/machines"
import { BS_APP_MAX_AGE_MS, BS_MACHINE_ID, BsAppsSchema, bsBudget, type BsPlan, type BsState, BsStateSchema, nextSlotId, slotIdFromKey, slotIndex, slotKey } from "@/core/browserstack"
import { evaluateHealth, type HealthResult, type HealthState } from "@/core/health"
import { type HostSample, MetricsFileSchema, MetricsHistory } from "@/core/metrics"
import { parseMassa } from "@/core/massa"
import { nextPhysicalIndex, parseAdbDevices, serialFromIndex } from "@/core/parsers/adb-devices"
import { classifyRun } from "@/core/parsers/robot-output"
import { dataPaths } from "@/core/paths"
import { applyResult, buildQueue, cancelQueue, failedTestIds, finalizeIfDone, reopenItem, setQueueRetries } from "@/core/queue-logic"
import { buildRobotArgs, buildRobotEnv, parseTimeoutVariables, scaledTimeoutArgs } from "@/core/robot-args"
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
  EmulatorsDisabledSchema,
  type Settings,
  SettingsSchema,
  PhysicalStateSchema,
  type Queue,
  QueueSchema,
  type RunnerState,
  RunnerStateSchema,
  RunResultSchema,
} from "@/core/types"
import type { Adapters } from "@/server/adapters"
import { INSTALL_NEEDS_UNINSTALL_RE } from "@/server/adb"
import type { Adb } from "@/server/adb"
import type { AppiumPool } from "@/server/appium"
import { killGroup } from "@/server/exec"
import type { FarmOp } from "@/server/farm"
import { describeOp } from "@/server/farm"
import { projectSecrets } from "@/server/project-git"
import type { Snapshot } from "@/server/snapshot"

import { RemoteMachines } from "./remote"
import { routedAdb, routedAppium } from "./routing"

type Log = (msg: string) => void

interface RunningAttempt {
  queueId: string
  itemId: string
  n: number
  serial: string
  index: number
  machineId?: string
  /** vaga do BrowserStack (sem adb/Appium locais) */
  cloud?: boolean
  /** grupo do robot local (0 = robot rodando num worker) */
  pgid: number
  /** robot rodando num worker (divide a carga do mestre) */
  remote?: RemoteRun
  dir: string
  qemuPid?: number
  timedOut: boolean
  canceled: boolean
  deviceLost: boolean
  physical: boolean
  timers: NodeJS.Timeout[]
}

interface RemoteRun {
  host: string
  runId: string
  /** bytes do console já copiados */
  offset: number
  lastOkAt: number
  polling: boolean
  finishing: boolean
  /** worker sem resposta: artefatos ficam lá (limpeza pendente) */
  unreachable?: boolean
}

const DEVICE_REFRESH_MS = 2000
/** consulta do robot remoto (renova o lease no worker: 90 s sem consulta → o worker mata o robot) */
const REMOTE_POLL_MS = 3000
/** arquivo de artefato maior que isso não é copiado do worker */
const REMOTE_FILE_MAX = 200 * 1024 * 1024
const WORKSPACE_RETRY_MS = 2 * 60_000
const INSTALL_RETRY_MS = 3 * 60_000
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
  /** última falha de instalação por celular: não tenta de novo a cada ciclo (e mostra o motivo no cartão) */
  private installFailures = new Map<string, { versionCode: number; at: number; note: string }>()
  private prepared = new Set<string>() // celulares já configurados para testes (diálogos de erro desligados)
  private physical = new Map<string, number>() // aparelhos físicos ativados: serial → índice fixo
  private disabledEmulators = new Set<string>() // emuladores ligados mas fora do conjunto de testes
  private maintenance = new Map<number, { since: string; reason: string }>()
  private farmOps: FarmOp[] = []
  private farmBusy = false
  private farmJob?: { command: string; startedAt: string }
  private desired = 0
  private lastDesiredAttempt = 0
  private lastLowMemLog = 0
  // saúde desta máquina (memória, CPU, temperatura): leitura periódica, histórico curto e freio
  private metricsHistory = new MetricsHistory()
  private healthState: HealthState = {}
  private lastSample: HostSample | null = null
  private health: HealthResult | null = null
  private lastMetricsAt = 0
  private lastMetricsWrite = 0
  private lastHealthLevel: HealthResult["level"] = "ok"
  private lastBrakeLog = 0
  private lastDeviceRefresh = 0
  private adbRaw = ""
  private catalog: Catalog | null = null
  private catalogStatus: RunnerState["catalogStatus"] = "missing"
  private catalogError?: string
  private snapshot: Snapshot | null = null
  private catalogBuild: Promise<void> | null = null
  // ---- projeto Robot (git): uma operação por vez; a trava também cobre a cópia (snapshot) do projeto,
  // para um pull no meio do rsync não gerar um snapshot que não bate com o hash
  private projectChain: Promise<unknown> = Promise.resolve()
  private gitOp?: GitOp
  private gitPreview?: string
  private gitState: Omit<ProjectGitState, "updatedAt" | "op"> = {}
  private lastGitStatus = 0
  private gitStatusBusy = false
  private activeAppId?: string
  private appMetaCache = new Map<string, AppMeta | null>()
  private ticking = false
  private readonly startedAt = new Date().toISOString()
  /** máquinas worker (server02…) e roteamento de adb/Appium para elas */
  private readonly remote: RemoteMachines
  private readonly adb: Adb
  private readonly appium: AppiumPool
  private lastStatusWrite = 0
  private settings: Settings = { maxParallel: 0 }
  // BrowserStack: vagas, plano (sessões paralelas da conta) e APKs já enviados
  private bs: BsState = { enabled: false, slots: [] }
  /** robots de worker a encerrar/apagar (mestre reiniciou, worker sumiu no meio do caso) */
  private remoteCleanup: Array<{ host: string; runId: string; since: number }> = []
  private lastBsHostLog = 0
  /** envio do projeto para o worker falhou: por um tempo o robot dos celulares dele volta para o mestre */
  private workspaceFailAt = new Map<string, number>()
  private bsPlan: BsPlan | null = null
  private bsPlanAt = 0
  private bsError?: string
  private bsApps: Record<string, { appUrl: string; uploadedAt: string }> = {}
  private bsUploading = new Map<string, Promise<void>>()
  private bsDevicesAt = 0
  private lastParallelLog = 0

  constructor(
    private readonly cfg: Config,
    private readonly ad: Adapters,
    private readonly log: Log = (m) => console.log(`[runner ${new Date().toISOString()}] ${m}`),
    private readonly opts: { deviceRefreshMs?: number; remotePollMs?: number } = {},
  ) {
    this.p = dataPaths(cfg.dataDir)
    this.remote = new RemoteMachines(cfg, this.p, log)
    this.adb = routedAdb(ad.adb, this.remote)
    this.appium = routedAppium(ad.appium, this.remote)
    this.remote.onReboot = (id) => this.forgetMachine(id)
    this.remote.onOpDone = (id, op) => {
      const m = this.remote.get(id)
      if (m && op.kind === "startOne") this.maintenance.delete(globalIndex(m.slot, op.index))
      this.lastDeviceRefresh = 0
    }
  }

  /** Worker reiniciou: versões instaladas e preparo dos celulares dele não valem mais. */
  private forgetMachine(id: string): void {
    const prefix = `${id}:`
    for (const k of [...this.appVersions.keys()]) if (k.startsWith(prefix)) this.appVersions.delete(k)
    for (const k of [...this.prepared]) if (k.startsWith(prefix)) this.prepared.delete(k)
    const m = this.remote.get(id)
    if (m) for (const i of [...this.maintenance.keys()]) if (splitIndex(i).slot === m.slot) this.maintenance.delete(i)
  }

  private async saveDesired(): Promise<void> {
    await writeJsonAtomic(this.p.desired, { devices: this.desired, machines: this.remote.desiredMap() })
  }

  // ------------------------------------------------------------ início ---
  async init(): Promise<void> {
    for (const d of [this.p.apps, this.p.queues, this.p.runs, this.p.commands, this.p.commandsDone, this.p.state, this.p.logs]) {
      await fsp.mkdir(d, { recursive: true })
    }
    // 1) mata processos robot que sobraram do runner anterior
    const prev = await readJson(this.p.runnerState, RunnerStateSchema.nullable(), null)
    for (const pgid of prev?.pgids ?? []) killGroup(pgid, "SIGKILL")
    // robots que o runner anterior deixou nos workers: encerra assim que o worker responder
    for (const r of prev?.remoteRuns ?? []) this.remoteCleanup.push({ ...r, since: Date.now() })
    this.activeAppId = prev?.activeAppId
    // 2) Appiums antigos (sessões presas) — sobem de novo sob demanda
    await this.appium.killStray()
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
    const desired = await readJson(this.p.desired, DesiredSchema, { devices: 0 })
    this.desired = desired.devices
    await this.remote.load(desired.machines ?? {})
    // chave SSH dedicada do mestre (a página Máquinas mostra a pública para colar no worker)
    await this.remote.ensureKey().catch((e: Error) => this.log(`não consegui criar a chave SSH do mestre: ${e.message}`))
    this.physical = new Map(Object.entries((await readJson(this.p.physical, PhysicalStateSchema, { enabled: {} })).enabled))
    this.disabledEmulators = new Set((await readJson(this.p.emulatorsDisabled, EmulatorsDisabledSchema, { disabled: [] })).disabled)
    this.settings = await readJson(this.p.settings, SettingsSchema, { maxParallel: 0 })
    this.bs = await readJson(this.p.browserstack, BsStateSchema, { enabled: false, slots: [] })
    this.bsApps = (await readJson(this.p.browserstackApps, BsAppsSchema, { apps: {} })).apps
    const saved = await readJson(this.p.metrics, MetricsFileSchema.nullable(), null)
    this.metricsHistory = new MetricsHistory(saved?.machines.find((m) => m.id === this.cfg.machineId)?.history ?? [])
    this.catalog = await readJson(this.p.catalog, CatalogSchema.nullable(), null)
    this.catalogStatus = this.catalog ? "ready" : "missing"
    await this.pickActiveApp()
    void this.refreshCatalog(false)
    void this.refreshGitState()
    this.log(`iniciado (fake=${this.cfg.fake}) filas=${this.queues.size} desejados=${this.desired}`)
  }

  // -------------------------------------------------------------- loop ---
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.processCommands()
      await this.remote.poll()
      await this.pollBrowserStack()
      if (Date.now() - this.lastDeviceRefresh >= (this.opts.deviceRefreshMs ?? DEVICE_REFRESH_MS)) {
        await this.refreshDevices()
        this.lastDeviceRefresh = Date.now()
      }
      this.reconcileFarm()
      this.processFarmOps()
      this.reconcileRemoteFarms()
      await this.reconcileOrphans()
      await this.processRemoteCleanup()
      if (Date.now() - this.lastGitStatus > 60_000) void this.refreshGitState()
      await this.collectMetrics()
      await this.dispatch()
      await this.writeRunnerState()
      await this.writeMachinesStatus()
    } catch (e) {
      this.log(`erro no tick: ${(e as Error).stack ?? e}`)
    } finally {
      this.ticking = false
    }
  }

  async shutdown(): Promise<void> {
    this.remote.shutdown()
    await this.writeRunnerState()
    await Promise.all([...this.writeChains.values()])
  }

  // ------------------------------------------------------------ BrowserStack ---
  /** Plano (sessões paralelas) a cada 30 s e lista de aparelhos a cada 6 h; grava o status para a tela. */
  private async pollBrowserStack(): Promise<void> {
    const bs = this.ad.browserstack
    const now = Date.now()
    if (bs.configured && (this.bs.enabled || this.bsPlanAt === 0) && now - this.bsPlanAt >= 30_000) {
      this.bsPlanAt = now
      try {
        this.bsPlan = await bs.plan()
        this.bsError = undefined
      } catch (e) {
        this.bsPlan = null
        this.bsError = (e as Error).message
      }
      if (now - this.bsDevicesAt > 6 * 3600_000) {
        try {
          const list = (await bs.devices()).filter((d) => d.os === "android")
          await writeJsonAtomic(path.join(this.p.state, "browserstack-devices.json"), { updatedAt: new Date().toISOString(), devices: list })
          this.bsDevicesAt = now
        } catch {
          /* tenta de novo no próximo ciclo */
        }
      }
      await writeJsonAtomic(this.p.browserstackStatus, {
        updatedAt: new Date().toISOString(),
        configured: bs.configured,
        user: bs.user,
        plan: this.bsPlan,
        error: this.bsError,
        ourRunning: [...this.running.values()].filter((r) => r.cloud).length,
      })
    }
  }

  /** Vagas como "celulares" do tipo cloud. */
  private bsDevices(meta: AppMeta | null, busyBySerial: Map<string, RunningAttempt>, now: string): Device[] {
    const bs = this.ad.browserstack
    const md5 = meta?.md5 ?? ""
    const app = md5 ? this.bsApps[md5] : undefined
    const fresh = !!app && Date.now() - Date.parse(app.uploadedAt) < BS_APP_MAX_AGE_MS
    if (this.bs.enabled && bs.configured && meta && !fresh) this.bsUpload(meta)
    return this.bs.slots.map((slot) => {
      const serial = slotKey(slot.id)
      const base: Device = {
        serial,
        kind: "cloud",
        adbState: "cloud",
        index: slotIndex(slot.id),
        name: `${slot.device} · Android ${slot.osVersion}`,
        model: slot.device,
        machineId: BS_MACHINE_ID,
        enabled: slot.enabled && this.bs.enabled,
        state: "offline",
        updatedAt: now,
      }
      const ra = busyBySerial.get(serial)
      if (ra) {
        const it = this.queues.get(ra.queueId)?.items.find((i) => i.id === ra.itemId)
        return { ...base, state: "busy", currentQueueId: ra.queueId, currentItemId: ra.itemId, currentTestName: it?.name, appVersionCode: meta?.versionCode }
      }
      if (!bs.configured) return { ...base, note: "Credenciais do BrowserStack não configuradas no .env do painel" }
      if (!this.bs.enabled) return { ...base, note: "BrowserStack desligado" }
      if (this.bsError) return { ...base, note: `BrowserStack: ${this.bsError}` }
      if (meta && !fresh) return { ...base, state: "installing", note: `Enviando ${meta.versionName} (${meta.versionCode}) ao BrowserStack` }
      return { ...base, state: "ready", appVersionCode: meta?.versionCode }
    })
  }

  /** Envia o APK ao BrowserStack uma vez por md5 (em segundo plano). */
  private bsUpload(meta: AppMeta): void {
    if (this.bsUploading.has(meta.md5)) return
    this.log(`enviando ${meta.versionName} (${meta.versionCode}) ao BrowserStack`)
    const job = this.ad.browserstack
      .upload(this.p.appApk(meta.id), `qafarm-${meta.md5}`)
      .then(async (appUrl) => {
        this.bsApps = { ...this.bsApps, [meta.md5]: { appUrl, uploadedAt: new Date().toISOString() } }
        await writeJsonAtomic(this.p.browserstackApps, { apps: this.bsApps })
        this.log(`APK ${meta.versionCode} no BrowserStack: ${appUrl}`)
        this.lastDeviceRefresh = 0
      })
      .catch((e: Error) => {
        this.bsError = `falha ao enviar o APK: ${e.message}`
        this.log(this.bsError)
      })
      .finally(() => setTimeout(() => this.bsUploading.delete(meta.md5), 60_000))
    this.bsUploading.set(meta.md5, job)
  }

  /** Variáveis do caso numa vaga do BrowserStack (o listener abre a sessão lá). */
  private bsEnv(serial: string, queueName: string, testName: string, meta: AppMeta): Record<string, string> {
    const id = slotIdFromKey(serial)
    if (id === null) return {}
    const slot = this.bs.slots.find((x) => x.id === id)
    const app = this.bsApps[meta.md5]
    if (!slot || !app) return {}
    return {
      QAFARM_BS_APP: app.appUrl,
      QAFARM_BS_DEVICE: slot.device,
      QAFARM_BS_OS: slot.osVersion,
      QAFARM_BS_USER: this.cfg.bsUser,
      QAFARM_BS_KEY: this.cfg.bsKey,
      QAFARM_BS_BUILD: `QA Farm · ${queueName}`.slice(0, 250),
      QAFARM_BS_SESSION: testName.slice(0, 250),
    }
  }

  /** Fim do caso no BrowserStack: marca passou/falhou, encerra sessão órfã e devolve o link do vídeo/logs. */
  private async finishBsSession(ra: RunningAttempt, status: string, message?: string): Promise<string | undefined> {
    const s = await readJson(path.join(ra.dir, "session.json"), z.object({ sessionId: z.string().nullable().optional() }).nullable(), null)
    const id = s?.sessionId
    if (!id) return undefined
    const bs = this.ad.browserstack
    try {
      if (ra.timedOut || ra.canceled || ra.deviceLost) await bs.deleteSession(id)
      await bs.setSessionStatus(id, status === "passed" ? "passed" : "failed", status === "passed" ? "" : (message ?? status).split("\n")[0])
      return (await bs.session(id)).publicUrl
    } catch (e) {
      this.log(`BrowserStack: não consegui fechar a sessão ${id}: ${(e as Error).message}`)
      return undefined
    }
  }

  // ------------------------------------------------------- saúde da máquina ---
  /** Lê memória/CPU/temperatura a cada `metricsIntervalMs`, avalia os alertas e grava state/metrics.json. */
  private async collectMetrics(): Promise<void> {
    const now = Date.now()
    if (now - this.lastMetricsAt < this.cfg.metricsIntervalMs) return
    this.lastMetricsAt = now
    let sample: HostSample
    try {
      sample = await this.ad.metrics.sample()
    } catch (e) {
      this.log(`falha ao ler a saúde da máquina: ${(e as Error).message}`)
      return
    }
    this.lastSample = sample
    this.metricsHistory.add(sample)
    const h = evaluateHealth(sample, this.healthState, now, this.cfg.health)
    this.healthState = h.state
    const wasBraking = this.health?.brake ?? false
    this.health = h
    const crit = h.alerts.filter((a) => a.level === "crit").map((a) => a.message)
    if (h.brake && !wasBraking) this.log(`saúde crítica (${crit.join("; ")}): novos casos aguardam`)
    if (!h.brake && wasBraking) this.log("saúde normalizada: novos casos liberados")
    const levelChanged = h.level !== this.lastHealthLevel
    this.lastHealthLevel = h.level
    if (levelChanged || now - this.lastMetricsWrite >= 5000) {
      this.lastMetricsWrite = now
      await this.writeMetrics()
    }
  }

  private async writeMachinesStatus(): Promise<void> {
    if (Date.now() - this.lastStatusWrite < 2000) return
    this.lastStatusWrite = Date.now()
    if (this.remote.machines().length === 0 && !fs.existsSync(this.p.machinesStatus)) return
    await writeJsonAtomic(this.p.machinesStatus, { updatedAt: new Date().toISOString(), machines: this.remote.status() })
  }

  private async writeMetrics(): Promise<void> {
    const h = this.health
    await writeJsonAtomic(this.p.metrics, {
      updatedAt: new Date().toISOString(),
      machines: [
        {
          id: this.cfg.machineId,
          name: this.cfg.machineId,
          role: "master",
          sample: this.lastSample ? { ...this.lastSample, emulatorsRunning: [...this.devices.values()].filter((d) => d.kind === "emulator").length } : null,
          history: this.metricsHistory.list(),
          health: h ? { level: h.level, alerts: h.alerts, brake: h.brake, blockStart: h.blockStart } : { level: "ok", alerts: [], brake: false, blockStart: false },
        },
        ...this.remote.metricsEntries(),
      ],
    })
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
      pgids: [...this.running.values()].map((r) => r.pgid).filter((p) => p > 1),
      remoteRuns: [...this.running.values()].flatMap((r) => (r.remote ? [{ host: r.remote.host, runId: r.remote.runId }] : [])),
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
   * App ativo (um app por vez nos celulares): o da fila ativa mais antiga; sem fila ativa, o da fila mais
   * recente (os celulares não trocam de versão quando a fila acaba); sem nenhuma fila, o APK enviado por último
   * (fica pré-instalado e a primeira fila começa sem esperar a instalação).
   */
  private async pickActiveApp(): Promise<void> {
    const active = [...this.queues.values()]
      .filter((q) => (q.status === "running" || q.status === "paused") && q.items.some((i) => i.status === "queued" || i.status === "running"))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    if (active) {
      this.activeAppId = active.appId
      return
    }
    // sem fila ativa: mantém a versão da fila mais recente (mesmo terminada) — não troca o app dos celulares
    // quando a fila acaba (voltar para um APK mais antigo obriga desinstalar no aparelho físico).
    // Nunca houve fila: pré-instala o APK enviado por último.
    const latest = [...this.queues.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    if (latest && (await this.appMeta(latest.appId))) {
      this.activeAppId = latest.appId
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

  // ------------------------------------------------------ projeto (git) ---
  /** Serializa tudo que lê ou muda a pasta do projeto (cópia para snapshot e operações git). */
  private withProject<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.projectChain.then(fn, fn)
    this.projectChain = next.catch(() => undefined)
    return next
  }

  private ensureSnapshot(): Promise<Snapshot> {
    return this.withProject(() => this.ad.snapshots.ensure())
  }

  /** Lê branch, commits, alterações e branches remotas (sem rede) e grava state/project-git.json. */
  private async refreshGitState(): Promise<void> {
    if (this.gitStatusBusy) return
    this.gitStatusBusy = true
    this.lastGitStatus = Date.now()
    try {
      const snap = await this.withProject(() => this.ad.git.snapshot(this.gitPreview))
      this.gitState = { ...this.gitState, ...snap, remoteUrl: await this.ad.git.remoteUrl().catch(() => undefined), error: undefined }
    } catch (e) {
      this.gitState = { ...this.gitState, error: (e as Error).message }
    } finally {
      this.gitStatusBusy = false
    }
    await this.writeGitState()
  }

  private async writeGitState(): Promise<void> {
    const secrets = await projectSecrets(this.cfg).catch(() => [] as string[])
    const mask = (t: string) => maskSecrets(t, secrets).text
    const state: ProjectGitState = {
      ...this.gitState,
      updatedAt: new Date().toISOString(),
      op: this.gitOp && { ...this.gitOp, message: this.gitOp.message && mask(this.gitOp.message), log: this.gitOp.log.map(mask) },
    }
    await writeJsonAtomic(this.p.projectGit, state)
  }

  /** Busca (fetch) ou atualiza (troca de branch + fast-forward) em segundo plano; uma por vez. */
  private startGitOp(kind: GitOp["kind"], branch?: string): { ok: boolean; message: string } {
    if (this.gitOp?.status === "running") return { ok: false, message: "Operação git em andamento; aguarde terminar" }
    const op: GitOp = { id: newId("git"), kind, branch, status: "running", startedAt: new Date().toISOString(), log: [] }
    this.gitOp = op
    const log = (l: string) => {
      op.log.push(l)
      if (op.log.length > 300) op.log.splice(0, op.log.length - 300)
    }
    const timer = setInterval(() => void this.writeGitState(), 1000)
    this.log(`projeto: ${kind === "fetch" ? "buscando atualizações (fetch)" : `atualizando para ${branch}`}`)
    void (async () => {
      let ok = false
      try {
        if (kind === "fetch") {
          await this.withProject(() => this.ad.git.fetch(log))
          ok = true
          op.message = "Branches e commits do servidor git atualizados"
        } else {
          const r = await this.withProject(() => this.ad.git.update(branch!, log))
          ok = r.ok
          op.message = r.message
        }
        if (ok) this.gitState = { ...this.gitState, fetchedAt: new Date().toISOString() }
      } catch (e) {
        op.message = (e as Error).message
        log(`✖ ${op.message}`)
      }
      clearInterval(timer)
      op.status = ok ? "ok" : "error"
      op.endedAt = new Date().toISOString()
      if (kind === "update" && ok) this.gitPreview = undefined
      this.log(`projeto: ${op.status === "ok" ? "ok" : "falhou"} — ${op.message ?? ""}`)
      await this.refreshGitState()
      // código novo → snapshot e catálogo novos (filas em andamento seguem com o snapshot delas)
      if (kind === "update" && ok) void this.refreshCatalog(false)
    })()
    return { ok: true, message: kind === "fetch" ? "Buscando atualizações do servidor git…" : `Atualizando o projeto para ${branch}…` }
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
      this.snapshot = await this.ensureSnapshot()
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
        const snap = this.snapshot ?? (this.snapshot = await this.ensureSnapshot())
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
          input: { name: `${q.name} · re-run falhas`, appId: q.appId, env: q.env, timeoutSec: q.options.timeoutSec, retries: q.options.retries, closeAppAfter: q.options.closeAppAfter, allowSameAccount: q.options.allowSameAccount, waitFactor: q.options.waitFactor, testIds: ids },
        })
      }
      case "set_queue_retries": {
        const q = this.queues.get(c.queueId)
        if (!q) return { ok: false, message: "Fila não encontrada" }
        const preview = setQueueRetries(q, c.retries)
        if (preview.reopened > 0) {
          const other = [...this.queues.values()].find(
            (x) => x.id !== q.id && (x.status === "running" || x.status === "paused") && x.appId !== q.appId && x.items.some((i) => i.status === "queued" || i.status === "running"),
          )
          if (other) return { ok: false, message: `A fila "${other.name}" usa outro app. Aguarde ou cancele antes de rodar falhas de novo nesta.` }
        }
        this.updateQueue(q.id, (cur) => setQueueRetries(cur, c.retries).queue)
        await this.pickActiveApp()
        const parts = [`Tentativas extras: ${c.retries}`]
        if (preview.reopened) parts.push(`${preview.reopened} caso(s) com falha voltaram para a fila`)
        if (preview.reverted) parts.push(`${preview.reverted} nova(s) tentativa(s) cancelada(s)`)
        return { ok: true, message: parts.join(" · "), data: { reopened: preview.reopened, reverted: preview.reverted } }
      }
      case "bs_set_enabled": {
        if (c.enabled && !this.ad.browserstack.configured) return { ok: false, message: "Configure QAFARM_BS_USER e QAFARM_BS_KEY no .env do painel" }
        this.bs = { ...this.bs, enabled: c.enabled }
        await writeJsonAtomic(this.p.browserstack, this.bs)
        this.bsPlanAt = 0
        this.lastDeviceRefresh = 0
        return { ok: true, message: c.enabled ? "BrowserStack ligado: as vagas ativadas recebem casos" : "BrowserStack desligado: os casos em andamento terminam; nenhum novo vai para lá" }
      }
      case "bs_add_slot": {
        if (this.bs.slots.length >= 20) return { ok: false, message: "Limite de 20 vagas" }
        const slot = { id: nextSlotId(this.bs.slots), device: c.device, osVersion: c.osVersion, enabled: true }
        this.bs = { ...this.bs, slots: [...this.bs.slots, slot] }
        await writeJsonAtomic(this.p.browserstack, this.bs)
        this.lastDeviceRefresh = 0
        return { ok: true, message: `Vaga ${slot.id}: ${c.device} · Android ${c.osVersion}` }
      }
      case "bs_remove_slot": {
        if ([...this.running.values()].some((r) => r.serial === slotKey(c.id))) return { ok: false, message: "Vaga ocupada com um caso; aguarde terminar" }
        this.bs = { ...this.bs, slots: this.bs.slots.filter((x) => x.id !== c.id) }
        await writeJsonAtomic(this.p.browserstack, this.bs)
        this.lastDeviceRefresh = 0
        return { ok: true, message: `Vaga ${c.id} removida` }
      }
      case "bs_set_slot_enabled": {
        if (!this.bs.slots.some((x) => x.id === c.id)) return { ok: false, message: "Vaga não encontrada" }
        this.bs = { ...this.bs, slots: this.bs.slots.map((x) => (x.id === c.id ? { ...x, enabled: c.enabled } : x)) }
        await writeJsonAtomic(this.p.browserstack, this.bs)
        this.lastDeviceRefresh = 0
        return { ok: true, message: `Vaga ${c.id} ${c.enabled ? "ativada" : "desativada (termina o caso atual)"}` }
      }
      case "bs_set_run_on": {
        const id = c.machineId || undefined
        if (id && !this.remote.get(id)) return { ok: false, message: "Máquina não encontrada" }
        this.bs = { ...this.bs, runOn: id }
        await writeJsonAtomic(this.p.browserstack, this.bs)
        return {
          ok: true,
          message: id
            ? `Casos do BrowserStack passam a rodar o robot em ${this.remote.get(id)!.name} (os em andamento terminam onde estão)`
            : "Casos do BrowserStack passam a rodar o robot no mestre",
        }
      }
      case "set_settings": {
        this.settings = { ...this.settings, maxParallel: c.maxParallel }
        await writeJsonAtomic(this.p.settings, this.settings)
        return {
          ok: true,
          message: c.maxParallel ? `Máximo de ${c.maxParallel} caso(s) ao mesmo tempo (os que já estão rodando continuam)` : "Sem limite de casos ao mesmo tempo",
        }
      }
      case "set_queue_wait_factor": {
        const q = this.queues.get(c.queueId)
        if (!q) return { ok: false, message: "Fila não encontrada" }
        this.updateQueue(q.id, (cur) => ({ ...cur, options: { ...cur.options, waitFactor: c.waitFactor } }))
        return { ok: true, message: `Esperas ×${c.waitFactor} a partir dos próximos casos` }
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
        if (c.machineId && c.machineId !== this.cfg.machineId) {
          const m = this.remote.get(c.machineId)
          if (!m) return { ok: false, message: "Máquina não encontrada" }
          if (c.count > m.maxDevices) return { ok: false, message: `${m.name} aceita no máximo ${m.maxDevices} emuladores` }
          this.remote.setDesired(m.id, c.count)
          this.remote.queueOp(m.id, { kind: "start", count: c.count })
          await this.saveDesired()
          return { ok: true, message: `Ligando ${c.count} celular(es) em ${m.name}` }
        }
        this.desired = c.count
        await this.saveDesired()
        this.farmOps.push({ kind: "start", count: c.count })
        this.lastDesiredAttempt = Date.now()
        return { ok: true, message: `Ligando ${c.count} celular(es)` }
      }
      case "stop_all_devices": {
        if (c.machineId && c.machineId !== this.cfg.machineId) {
          const m = this.remote.get(c.machineId)
          if (!m) return { ok: false, message: "Máquina não encontrada" }
          if ([...this.running.values()].some((r) => r.machineId === m.id)) return { ok: false, message: `Há casos rodando em ${m.name}. Aguarde ou cancele antes.` }
          this.remote.setDesired(m.id, 0)
          this.remote.queueOp(m.id, { kind: "stopAll" })
          await this.saveDesired()
          return { ok: true, message: `Desligando os celulares de ${m.name}` }
        }
        if ([...this.running.values()].some((r) => !r.machineId)) return { ok: false, message: "Há casos em execução. Pause ou cancele as filas antes." }
        this.desired = 0
        await this.saveDesired()
        this.farmOps = [{ kind: "stopAll" }]
        this.maintenance.clear()
        await this.appium.stopAll()
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
      case "set_emulator_enabled": {
        if (!/^([a-z0-9-]+:)?emulator-\d+$/.test(c.serial)) return { ok: false, message: "Use esta opção só em emuladores" }
        if (c.enabled) this.disabledEmulators.delete(c.serial)
        else this.disabledEmulators.add(c.serial)
        await writeJsonAtomic(this.p.emulatorsDisabled, { disabled: [...this.disabledEmulators].sort() })
        this.lastDeviceRefresh = 0
        const busyNow = [...this.running.values()].some((r) => r.serial === c.serial)
        return {
          ok: true,
          message: c.enabled
            ? `${c.serial} ativado: volta a receber casos`
            : `${c.serial} desativado: ${busyNow ? "termina o caso atual e " : ""}não recebe mais casos`,
        }
      }
      case "add_machine": {
        if (c.directUrl && !this.cfg.fake) return { ok: false, message: "URL direta só no modo simulado" }
        try {
          const m = await this.remote.add({ id: c.id, name: c.name, host: c.host, sshUser: c.sshUser, sshPort: c.sshPort, maxDevices: c.maxDevices, directUrl: c.directUrl, token: c.token })
          return { ok: true, message: `Máquina ${m.name} cadastrada (slot ${m.slot})`, data: { id: m.id, slot: m.slot } }
        } catch (e) {
          return { ok: false, message: (e as Error).message }
        }
      }
      case "update_machine": {
        try {
          const { type: _t, id, ...patch } = c
          const m = await this.remote.update(id, patch)
          return { ok: true, message: `Máquina ${m.name} atualizada` }
        } catch (e) {
          return { ok: false, message: (e as Error).message }
        }
      }
      case "remove_machine": {
        if ([...this.running.values()].some((r) => r.machineId === c.id)) return { ok: false, message: "Há casos rodando nessa máquina. Desative e aguarde terminar." }
        try {
          await this.remote.remove(c.id)
          await this.saveDesired()
          return { ok: true, message: "Máquina removida (os emuladores dela continuam como estão)" }
        } catch (e) {
          return { ok: false, message: (e as Error).message }
        }
      }
      case "set_machine_enabled": {
        const busyThere = [...this.running.values()].some((r) => r.machineId === c.id)
        try {
          await this.remote.setEnabled(c.id, c.enabled, busyThere)
        } catch (e) {
          return { ok: false, message: (e as Error).message }
        }
        return {
          ok: true,
          message: c.enabled ? "Máquina ativada: volta a receber casos" : busyThere ? "Máquina drenando: termina os casos atuais e não recebe novos" : "Máquina desativada",
        }
      }
      case "project_fetch":
        return this.startGitOp("fetch")
      case "project_update":
        return this.startGitOp("update", c.branch)
      case "project_preview": {
        this.gitPreview = c.branch
        await this.refreshGitState()
        return { ok: true, message: `Mostrando o que a branch ${c.branch} traria` }
      }
      case "set_machine_run_robot": {
        try {
          await this.remote.setRunRobot(c.id, c.enabled)
        } catch (e) {
          return { ok: false, message: (e as Error).message }
        }
        const ready = this.remote.robotReady(c.id)
        return {
          ok: true,
          message: c.enabled
            ? ready
              ? "Robot dos casos desta máquina passa a rodar nela (tira carga do mestre)"
              : "Ligado, mas o robot ainda não está instalado no worker: os casos seguem rodando o robot no mestre"
            : "Robot dos casos desta máquina volta a rodar no mestre",
        }
      }
      case "test_machine": {
        return this.remote.test(c.id)
      }
      case "deploy_machine": {
        return this.remote.deploy(c.id, this.cfg.repoRoot, (ok, out) => {
          this.log(`agente em ${c.id}: ${ok ? "instalado" : "falhou"} — ${out.split("\n").slice(-3).join(" | ")}`)
        })
      }
      case "rotate_machine_token": {
        try {
          await this.remote.rotateToken(c.id)
          return { ok: true, message: "Token trocado. Use \"Instalar agente\" para levar o token novo ao worker." }
        } catch (e) {
          return { ok: false, message: (e as Error).message }
        }
      }
      case "restart_appiums": {
        if (this.running.size > 0) return { ok: false, message: "Há casos em execução. Pause ou cancele as filas antes." }
        await this.appium.stopAll()
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
    const { slot, local } = splitIndex(index)
    const m = slot ? this.remote.bySlot(slot) : undefined
    if (slot && (!m || !this.remote.isReachable(m.id))) return // worker sem resposta: não mexe nos emuladores dele
    this.maintenance.set(index, { since: new Date().toISOString(), reason })
    const serial = m ? deviceKey(m.id, serialFromIndex(local)) : serialFromIndex(index)
    this.appVersions.delete(serial)
    this.prepared.delete(serial)
    if (m) this.remote.queueOp(m.id, { kind: "stopOne", index: local }, { kind: "startOne", index: local })
    else this.farmOps.push({ kind: "stopOne", index }, { kind: "startOne", index })
    this.log(`manutenção ${m ? `${m.id} · ` : ""}farm-${local} (${reason})`)
  }

  private reconcileRemoteFarms(): void {
    this.remote.reconcileDesired(
      (id) =>
        new Set(
          [...this.devices.values()].filter((d) => d.machineId === id && d.kind === "emulator" && d.index).map((d) => splitIndex(d.index!).local),
        ),
      (id, local) => {
        const m = this.remote.get(id)
        return !!m && this.maintenance.has(globalIndex(m.slot, local))
      },
    )
    // desativada e sem casos rodando: termina de drenar
    for (const m of this.remote.machines()) {
      if (!m.enabled && ![...this.running.values()].some((r) => r.machineId === m.id || r.remote?.host === m.id)) this.remote.drained(m.id)
    }
  }

  private async refreshDevices(): Promise<void> {
    this.adbRaw = await this.ad.adb.devicesRaw()
    const remoteDevices = this.remote.devices()
    const parsed: Array<ReturnType<typeof parseAdbDevices>[number] & { machineId?: string }> = [...parseAdbDevices(this.adbRaw), ...remoteDevices]
    const qemu = await this.ad.farm.qemuPids()
    for (const d of remoteDevices) if (d.globalIndex && d.qemuPid) qemu.set(d.globalIndex, d.qemuPid)
    const meta = await this.appMeta(this.activeAppId)
    const busyBySerial = new Map([...this.running.values()].map((r) => [r.serial, r]))
    const now = new Date().toISOString()
    const next = new Map<string, Device>()

    // celular sumiu ou qemu trocou durante um caso → infra
    for (const ra of this.running.values()) {
      if (ra.deviceLost || ra.cloud) continue
      const d = parsed.find((x) => x.serial === ra.serial)
      const pid = qemu.get(ra.index)
      if (!d || d.adbState !== "device" || (ra.qemuPid && pid !== ra.qemuPid)) {
        ra.deviceLost = true
        this.log(`celular ${ra.serial} caiu durante ${ra.queueId}/${ra.itemId}`)
        this.kill(ra)
        if (!ra.physical) this.restartDevice(ra.index, "caiu durante um caso") // aparelho físico nunca é reiniciado (e worker offline não)
      }
    }

    const readyChecks: Promise<void>[] = []
    for (const d of parsed) {
      const base: Device = {
        serial: d.serial,
        kind: d.kind,
        adbState: d.adbState,
        index: d.index,
        name: d.index ? `${d.machineId ? `${d.machineId} · ` : ""}farm-${String(splitIndex(d.index).local).padStart(2, "0")}` : undefined,
        machineId: d.machineId,
        model: d.model,
        state: "offline",
        qemuPid: d.index ? qemu.get(d.index) : undefined,
        updatedAt: now,
      }
      const isPhysical = d.kind === "physical"
      if (isPhysical && d.machineId) {
        next.set(d.serial, { ...base, state: "external", enabled: false, note: "Aparelho USB em worker ainda não é usado nos testes" })
        continue
      }
      if (isPhysical && !this.physical.has(d.serial)) {
        next.set(d.serial, { ...base, state: "external", enabled: false })
        continue
      }
      const idx = isPhysical ? this.physical.get(d.serial)! : d.index!
      if (isPhysical) Object.assign(base, { index: idx, name: d.model ?? d.serial, enabled: true })
      else base.enabled = !this.disabledEmulators.has(d.serial)
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
          const booted = prev && (prev.state === "ready" || prev.state === "installing") ? true : await this.adb.bootCompleted(d.serial)
          if (!booted) {
            next.set(d.serial, { ...base, state: "booting" })
            return
          }
          await this.appium.ensure(idx)
          if (!(await this.appium.isReady(idx))) {
            next.set(d.serial, { ...base, state: "installing", note: "Iniciando Appium" })
            return
          }
          if (meta) {
            if (!this.appVersions.has(d.serial)) {
              this.appVersions.set(d.serial, await this.adb.versionCode(d.serial, meta.package))
            }
            const vc = this.appVersions.get(d.serial)
            if (vc !== meta.versionCode) {
              const failed = this.installFailures.get(d.serial)
              const recent = failed && failed.versionCode === meta.versionCode && Date.now() - failed.at < INSTALL_RETRY_MS
              if (!recent) this.startInstall(d.serial, meta, isPhysical)
              const note = recent ? failed.note : `Instalando ${meta.versionName} (${meta.versionCode})`
              next.set(d.serial, { ...base, state: "installing", appVersionCode: vc, note })
              return
            }
          }
          if (!this.prepared.has(d.serial)) {
            // ANR do System UI no boot deixa um diálogo na tela que bloqueia todos os casos daquele celular.
            // Aparelho físico: não mexemos nas configurações do sistema dele (só fechamos diálogos antes de cada caso).
            if (!isPhysical) await this.adb.putGlobalSetting(d.serial, "hide_error_dialogs", "1")
            await this.adb.closeSystemDialogs(d.serial)
            if (!isPhysical) {
              // sem tela de bloqueio + tela apagada enquanto espera caso: não gasta CPU desenhando a tela à toa
              await this.adb.disableLockscreen(d.serial)
              await this.adb.keyevent(d.serial, "SLEEP")
            }
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
      if (prev.kind !== "emulator" || prev.machineId === BS_MACHINE_ID || !idx || next.has(prev.serial) || this.maintenance.has(idx)) continue
      if (prev.machineId) {
        // worker: só reinicia se a máquina está respondendo (sem resposta = problema de rede, não do emulador)
        if (!this.remote.isReachable(prev.machineId) || splitIndex(idx).local > this.remote.desiredOf(prev.machineId)) continue
        if (prev.state === "maintenance") continue
        this.restartDevice(idx, "sumiu do adb")
        continue
      }
      if (stopping || idx > this.desired || prev.state === "maintenance") continue
      this.restartDevice(idx, "sumiu do adb")
    }

    // vagas do BrowserStack (sem adb: prontas quando o APK da fila ativa já está no BrowserStack)
    for (const d of this.bsDevices(meta, busyBySerial, now)) next.set(d.serial, d)

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

  private startInstall(serial: string, meta: AppMeta, physical: boolean): void {
    if (this.installing.has(serial) || this.installing.size >= this.cfg.installConcurrency) return
    this.installing.add(serial)
    const apk = this.p.appApk(meta.id)
    this.log(`instalando ${meta.package} ${meta.versionCode} em ${serial}`)
    // emulador é descartável: se só desinstalando resolve (versão mais nova/assinatura), desinstala.
    // Aparelho físico: nunca apaga os dados do app sozinho — avisa no cartão.
    void this.adb
      .install(serial, apk, meta.package, meta.versionCode, { allowUninstall: !physical })
      .then(async (r) => {
        if (r.ok) this.installFailures.delete(serial)
        else {
          this.log(`falha ao instalar em ${serial}: ${r.output.slice(-300)}`)
          const note =
            physical && INSTALL_NEEDS_UNINSTALL_RE.test(r.output)
              ? `O aparelho tem uma versão mais nova do app: desinstale o app nele para usar ${meta.versionName} (${meta.versionCode})`
              : `Falha ao instalar ${meta.versionName} (${meta.versionCode}); nova tentativa em ${INSTALL_RETRY_MS / 60_000} min`
          this.installFailures.set(serial, { versionCode: meta.versionCode, at: Date.now(), note })
        }
        this.appVersions.set(serial, await this.adb.versionCode(serial, meta.package))
      })
      .finally(() => this.installing.delete(serial))
  }

  // ---------------------------------------------------------------- fazenda ---
  private reconcileFarm(): void {
    if (this.desired <= 0 || this.farmBusy || this.farmOps.length > 0) return
    if (this.health?.blockStart) return // disco quase cheio: não liga emuladores novos
    if (Date.now() - this.lastDesiredAttempt < DESIRED_RETRY_MS) return
    const present = new Set([...this.devices.values()].filter((d) => d.kind === "emulator" && !d.machineId).map((d) => d.index))
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
      .filter((d) => d.enabled !== false && (d.kind === "emulator" || d.enabled) && d.state === "ready" && d.index && ![...this.running.values()].some((r) => r.serial === d.serial))
      .map((d) => ({ serial: d.serial, index: d.index!, machineId: d.machineId }))
    if (free.length === 0) return
    const queues = [...this.queues.values()].filter((q) => q.appId === this.activeAppId)
    const running = [...this.running.values()].map((r) => {
      const it = this.queues.get(r.queueId)?.items.find((i) => i.id === r.itemId)
      return { queueId: r.queueId, itemId: r.itemId, serial: r.serial, accounts: it?.accounts ?? [] }
    })
    // orçamento por máquina: saúde crítica (temperatura, swap trocando, CPU saturada) segura casos novos NAQUELA
    // máquina; os que estão rodando seguem. Worker também precisa estar online e com memória.
    const budget = new Map<string, number>()
    if (this.health?.brake) {
      budget.set("", 0)
      if (Date.now() - this.lastBrakeLog > 60_000) {
        this.lastBrakeLog = Date.now()
        this.log(`freio de saúde ativo (${this.health.alerts.filter((a) => a.level === "crit").map((a) => a.message).join("; ")}): novos casos aguardam`)
      }
    }
    for (const m of this.remote.machines()) {
      budget.set(
        m.id,
        dispatchBudget(
          { online: this.remote.isOnline(m.id), memAvailableMb: this.remote.memAvailableMb(m.id), brake: this.remote.healthOf(m.id)?.brake ?? false },
          this.cfg,
        ),
      )
    }
    // robot do BrowserStack escolhido para rodar num worker: com ele fora do ar os casos esperam (não voltam a
    // pesar no mestre sem o usuário pedir)
    const bsHost = this.robotHostFor(BS_MACHINE_ID)
    if (bsHost === null && this.bs.enabled && Date.now() - this.lastBsHostLog > 60_000) {
      this.lastBsHostLog = Date.now()
      this.log(`BrowserStack: robot configurado para ${this.bs.runOn}, que não está pronto (offline ou sem robot): casos aguardam`)
    }
    budget.set(
      BS_MACHINE_ID,
      this.bs.enabled && this.ad.browserstack.configured && bsHost !== null
        ? bsBudget({
            freeSlots: free.filter((f) => f.machineId === BS_MACHINE_ID).length,
            ourRunning: [...this.running.values()].filter((r) => r.cloud).length,
            plan: this.bsPlan,
            reserve: this.cfg.bsReserve,
          })
        : 0,
    )
    const usable = interleaveByMachine(free.filter((f) => (budget.get(f.machineId ?? "") ?? Infinity) > 0))
    if (usable.length === 0) return
    // memória do MESTRE: o robot roda aqui, salvo quando a máquina do celular roda o próprio robot
    let memMb = await this.ad.farm.memAvailableMb()
    // limite de casos ao mesmo tempo (painel → Máquinas): o robot de todo caso roda neste servidor
    let slots = this.settings.maxParallel > 0 ? this.settings.maxParallel - this.running.size : Infinity
    if (slots <= 0) {
      if (Date.now() - this.lastParallelLog > 60_000) {
        this.lastParallelLog = Date.now()
        this.log(`limite de ${this.settings.maxParallel} caso(s) ao mesmo tempo atingido: novos casos aguardam`)
      }
      return
    }
    for (const a of schedule(queues, usable, running)) {
      if (slots <= 0) break
      // sem memória livre, o caso espera na fila: com emuladores rodando teste o servidor pode travar (OOM)
      if (memMb < this.cfg.minFreeMemMb) {
        if (Date.now() - this.lastLowMemLog > 60_000) {
          this.lastLowMemLog = Date.now()
          this.log(`memória livre baixa (${memMb} MB < ${this.cfg.minFreeMemMb} MB): novos casos aguardam`)
        }
        break
      }
      const dev = usable.find((f) => f.serial === a.serial)!
      const key = dev.machineId ?? ""
      if ((budget.get(key) ?? Infinity) <= 0) continue
      if (!(await this.preflight(a.serial, dev.index))) continue // caso continua na fila para outro celular
      const host = this.robotHostFor(dev.machineId)
      if (host === null) continue
      await this.startAttempt(a, dev.index, dev.machineId)
      budget.set(key, (budget.get(key) ?? Infinity) - 1)
      // robot rodando num worker: a memória dele sai de lá (vaga do BrowserStack desconta do worker escolhido)
      if (host && host !== key) budget.set(host, (budget.get(host) ?? Infinity) - 1)
      slots--
      memMb -= host ? 0 : dev.machineId ? this.cfg.robotMemMb : this.cfg.caseMemMb
    }
  }

  /**
   * Depois de cada caso: fecha o app (opção da fila) e, no emulador, apaga a tela. O projeto deixa o app aberto
   * (dontStopAppOnReset) e um vídeo em loop seguiria decodificando e renderizando com o celular parado.
   */
  private async afterCase(ra: RunningAttempt): Promise<void> {
    const q = this.queues.get(ra.queueId)
    if (ra.deviceLost || ra.cloud) return
    try {
      if (q?.options.closeAppAfter !== false) {
        const meta = await this.appMeta(q?.appId)
        if (meta) await this.adb.forceStop(ra.serial, meta.package)
        await this.adb.keyevent(ra.serial, "HOME")
      }
      if (!ra.physical) await this.adb.keyevent(ra.serial, "SLEEP")
    } catch (e) {
      this.log(`não consegui fechar o app/apagar a tela em ${ra.serial}: ${(e as Error).message}`)
    }
  }

  /** Antes de cada caso: fecha diálogo de erro na tela; se não fechar, o celular vai para manutenção. */
  private async preflight(serial: string, index: number): Promise<boolean> {
    if (slotIdFromKey(serial) !== null) return true // BrowserStack: aparelho novo a cada sessão
    await this.adb.keyevent(serial, "WAKEUP").catch(() => undefined) // a tela fica apagada entre os casos
    let focus: string
    try {
      focus = await this.adb.focusedWindow(serial)
    } catch (e) {
      this.log(`celular ${serial} sem resposta antes do caso: ${(e as Error).message} — caso fica na fila`)
      return false
    }
    if (!ERROR_DIALOG_RE.test(focus)) return true
    await this.adb.closeSystemDialogs(serial)
    const after = await this.adb.focusedWindow(serial)
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

  private async startAttempt(a: Assignment, index: number, machineId?: string): Promise<void> {
    const q = this.queues.get(a.queueId)
    const it = q?.items.find((i) => i.id === a.itemId)
    const meta = await this.appMeta(q?.appId)
    if (!q || !it || !meta) return
    let snap = this.snapshot
    if (!snap || (q.snapshotHash && snap.hash !== q.snapshotHash)) {
      const dir = path.join(this.p.workspaces, q.snapshotHash ?? "")
      snap = q.snapshotHash && fs.existsSync(dir) ? { hash: q.snapshotHash, dir } : await this.ensureSnapshot()
    }
    if (this.cfg.fake) snap = await this.ensureSnapshot()
    const host = this.robotHostFor(machineId)
    if (host === null) return
    const agent = host ? this.remote.client(host) : null
    if (host && !agent) return
    if (host) {
      try {
        await agent!.ensureWorkspace(snap.hash, snap.dir) // 1 envio por revisão do projeto
      } catch (e) {
        this.workspaceFailAt.set(host, Date.now())
        this.log(`não consegui enviar o projeto para ${host}: ${(e as Error).message} — por ${WORKSPACE_RETRY_MS / 60_000} min o robot dos celulares dele roda no mestre`)
        return
      }
    }
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
    const robotVars = {
      AMBIENTE: q.env,
      // celular de worker: serial e índice LOCAIS da máquina (o Appium roda lá) e a URL pelo túnel
      QAFARM_SERIAL: machineId ? parseDeviceKey(a.serial, this.remote.ids()).serial : a.serial,
      QAFARM_INDEX: String(splitIndex(index).local),
      QAFARM_APPIUM_URL: machineId === BS_MACHINE_ID ? this.ad.browserstack.hubUrl : this.appium.url(index),
      QAFARM_APP_PACKAGE: meta.package,
      QAFARM_APP_ACTIVITY: meta.launchableActivity,
      ...this.bsEnv(a.serial, q.name, it.name, meta),
    }
    // robot no worker: o agente completa PATH/SDK/Java com os caminhos de lá (e a URL do Appium local dele)
    const env = host ? buildRobotEnv({}, robotVars) : buildRobotEnv(baseEnv, robotVars)
    const appiumIndex = host && machineId !== BS_MACHINE_ID ? splitIndex(index).local : undefined
    if (appiumIndex) delete env.QAFARM_APPIUM_URL
    // "Esperas ×N" da fila: multiplica as variáveis de espera do projeto sem alterar o projeto
    const factor = q.options.waitFactor ?? 1
    const timeoutText = factor > 1 ? await fsp.readFile(path.join(snap.dir, this.cfg.robotTimeoutFile), "utf8").catch(() => "") : ""
    const args = buildRobotArgs({
      extraVars: scaledTimeoutArgs(parseTimeoutVariables(timeoutText), factor),
      listenerPath: path.join(host ? RUN_REPO : this.cfg.repoRoot, "scripts/robot/qafarm_listener.py"),
      massaListenerPath: path.join(host ? RUN_REPO : this.cfg.repoRoot, "scripts/robot/qafarm_massa.py"),
      env: q.env,
      fileLongName: it.fileLongName,
      outputDir: host ? RUN_OUT : dir,
      suiteFile: it.file,
    })
    let pgid = 0
    let remote: RemoteRun | undefined
    let exited: Promise<{ code: number | null }> | undefined
    if (host) {
      const runId = `${q.id}__${it.id}__${n}`.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 200)
      try {
        await agent!.runStart({ runId, workspace: snap.hash, args, env, appiumIndex })
      } catch (e) {
        this.log(`não consegui iniciar o robot em ${host}: ${(e as Error).message} — caso fica na fila`)
        return
      }
      remote = { host, runId, offset: 0, lastOkAt: Date.now(), polling: false, finishing: false }
    } else {
      const spawned = this.ad.robot.spawn({ args, env, cwd: snap.dir, consoleFile: path.join(dir, "console.log") })
      pgid = spawned.pid
      exited = spawned.exited
    }
    const startedAt = new Date().toISOString()
    const relDir = path.relative(this.p.runs, dir)
    const qemuPid = machineId ? this.devices.get(a.serial)?.qemuPid : (await this.ad.farm.qemuPids()).get(index)
    const cloud = machineId === BS_MACHINE_ID
    const ra: RunningAttempt = {
      queueId: q.id,
      itemId: it.id,
      n,
      serial: a.serial,
      index,
      machineId,
      cloud,
      pgid,
      remote,
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
          ? { ...i, status: "running", attempts: [...i.attempts, { n, serial: a.serial, startedAt, status: "running", dir: relDir, pgid: pgid || undefined, machineId, robotOn: host }] }
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
    this.log(`▶ ${q.id}/${it.id} "${it.name}" em ${a.serial} (tentativa ${n}${host ? `, robot em ${host}` : ""})`)
    if (exited) void exited.then((res) => this.finishAttempt(ra, res.code))
    else ra.timers.push(setInterval(() => void this.pollRemoteRun(ra), this.opts.remotePollMs ?? REMOTE_POLL_MS))
  }

  /**
   * Onde roda o robot do caso: undefined = mestre; id = worker; null = ninguém agora (o caso espera).
   * Celular de worker com "Robot nesta máquina" ligado e venv instalado → no próprio worker; BrowserStack →
   * a máquina escolhida no card (se ela não estiver pronta, espera em vez de voltar a pesar no mestre).
   */
  private robotHostFor(machineId?: string): string | undefined | null {
    const failedRecently = (id: string) => Date.now() - (this.workspaceFailAt.get(id) ?? 0) < WORKSPACE_RETRY_MS
    if (machineId === BS_MACHINE_ID) {
      const id = this.bs.runOn
      if (!id) return undefined
      return this.remote.canRunRobot(id) && !failedRecently(id) ? id : null
    }
    return machineId && this.remote.runsRobot(machineId) && !failedRecently(machineId) ? machineId : undefined
  }

  /** Acompanha o robot no worker: status (renova o lease), console ao vivo e fim. */
  private async pollRemoteRun(ra: RunningAttempt): Promise<void> {
    const rr = ra.remote!
    if (rr.polling || rr.finishing) return
    rr.polling = true
    try {
      const c = this.remote.client(rr.host)
      if (!c) throw new Error("máquina sem agente")
      const st = await c.runStatus(rr.runId)
      rr.lastOkAt = Date.now()
      await this.pullRemoteConsole(ra)
      // BrowserStack: a sessão atual fica copiada aqui para o mestre fechá-la mesmo se o worker cair
      if (ra.cloud) {
        const buf = await c.runFile(rr.runId, "session.json").catch(() => null)
        if (buf?.length) await fsp.writeFile(path.join(ra.dir, "session.json"), buf)
      }
      if (!st || st.state === "exited") {
        rr.finishing = true
        await this.finishAttempt(ra, st?.code ?? null)
      }
    } catch (e) {
      const silent = Date.now() - rr.lastOkAt
      if (silent > this.cfg.remoteOfflineMs * 2 && !rr.finishing) {
        this.log(`${rr.host} sem resposta há ${Math.round(silent / 1000)} s durante ${ra.queueId}/${ra.itemId} (${(e as Error).message}): caso volta para a fila`)
        rr.finishing = true
        rr.unreachable = true
        ra.deviceLost = true
        await this.finishAttempt(ra, null)
      }
    } finally {
      rr.polling = false
    }
  }

  private async pullRemoteConsole(ra: RunningAttempt): Promise<void> {
    const rr = ra.remote!
    const buf = await this.remote.client(rr.host)?.runFile(rr.runId, "console.log", rr.offset).catch(() => null)
    if (!buf?.length) return
    await fsp.appendFile(path.join(ra.dir, "console.log"), buf)
    rr.offset += buf.length
  }

  /** Traz os artefatos do worker para runs/ do mestre e apaga a cópia de lá. */
  private async collectRemoteRun(ra: RunningAttempt): Promise<void> {
    const rr = ra.remote!
    const c = this.remote.client(rr.host)
    if (!c) return
    try {
      await this.pullRemoteConsole(ra)
      const root = path.resolve(ra.dir)
      for (const f of await c.runFiles(rr.runId)) {
        if (f.name === "console.log") continue
        const dest = path.resolve(root, f.name)
        if (!dest.startsWith(`${root}${path.sep}`)) continue
        if (f.size > REMOTE_FILE_MAX) {
          this.log(`artefato ${f.name} de ${ra.queueId}/${ra.itemId} grande demais (${Math.round(f.size / 1048576)} MB): ficou em ${rr.host}`)
          continue
        }
        await fsp.mkdir(path.dirname(dest), { recursive: true })
        await fsp.writeFile(dest, await c.runFile(rr.runId, f.name))
      }
      await c.runDelete(rr.runId)
    } catch (e) {
      this.log(`não consegui trazer os artefatos de ${ra.queueId}/${ra.itemId} de ${rr.host}: ${(e as Error).message}`)
      this.remoteCleanup.push({ host: rr.host, runId: rr.runId, since: Date.now() })
    }
  }

  /** Encerra e apaga robots de worker que ficaram para trás (tenta por até 30 min). */
  private async processRemoteCleanup(): Promise<void> {
    if (!this.remoteCleanup.length) return
    const pending = this.remoteCleanup
    this.remoteCleanup = []
    for (const r of pending) {
      const c = this.remote.client(r.host)
      const ok = c
        ? await c
            .runKill(r.runId, "SIGKILL")
            .then(() => c.runDelete(r.runId))
            .then(() => true)
            .catch((e: Error) => /desconhecida/.test(e.message))
        : false
      if (ok) this.log(`robot ${r.runId} encerrado em ${r.host}`)
      else if (Date.now() - r.since < 30 * 60_000) this.remoteCleanup.push(r)
    }
  }

  private kill(ra: RunningAttempt): void {
    if (ra.remote) {
      const { host, runId } = ra.remote
      const c = this.remote.client(host)
      void c?.runKill(runId, "SIGTERM").catch(() => undefined)
      ra.timers.push(setTimeout(() => void c?.runKill(runId, "SIGKILL").catch(() => undefined), 10_000))
      return
    }
    killGroup(ra.pgid, "SIGTERM")
    ra.timers.push(setTimeout(() => killGroup(ra.pgid, "SIGKILL"), 10_000))
  }

  private async finishAttempt(ra: RunningAttempt, exitCode: number | null): Promise<void> {
    for (const t of ra.timers) clearTimeout(t)
    killGroup(ra.pgid, "SIGKILL") // garante que nenhum filho ficou para trás
    if (ra.remote && !ra.remote.unreachable) await this.collectRemoteRun(ra)
    else if (ra.remote) this.remoteCleanup.push({ host: ra.remote.host, runId: ra.remote.runId, since: Date.now() })
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
    // sessão órfã (timeout/cancelamento/robot morto) ocuparia as portas do celular no Appium compartilhado
    // worker fora do ar não pode travar o fim do caso (o resultado precisa ser gravado de qualquer jeito)
    if (ra.cloud) {
      const url = await this.finishBsSession(ra, result.status, result.message)
      if (url) result.cloudUrl = url
    }
    const removed = ra.cloud
      ? 0
      : await this.appium.cleanupSessions(ra.index, ra.serial).catch((e: Error) => {
          this.log(`não consegui limpar as sessões do Appium de ${ra.serial}: ${e.message}`)
          return 0
        })
    if (removed) this.log(`${removed} sessão(ões) do Appium encerrada(s) para ${ra.serial}`)
    await writeJsonAtomic(path.join(ra.dir, "result.json"), { ...result, finishedAt: finishedAt.toISOString() })
    this.running.delete(`${ra.queueId}/${ra.itemId}`)
    this.updateQueue(ra.queueId, (cur) => applyResult(cur, ra.itemId, ra.n, result, finishedAt))
    this.log(`■ ${ra.queueId}/${ra.itemId} em ${ra.serial}: ${result.status}${result.message ? ` — ${result.message.split("\n")[0].slice(0, 160)}` : ""}`)
    await this.afterCase(ra)
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
      if (ra.remote) void this.remote.client(ra.remote.host)?.runKill(ra.remote.runId, "SIGKILL").catch(() => undefined)
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

