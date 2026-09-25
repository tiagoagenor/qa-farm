import { execFile } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import { AGENT_PROTOCOL, type AgentHealth, type AgentState } from "@/core/agent-protocol"
import type { Config } from "@/core/config"
import { evaluateHealth, type HealthResult, type HealthState } from "@/core/health"
import {
  appiumGroups,
  globalIndex,
  localPorts,
  type Machine,
  type MachineState,
  type MachineStatus,
  MachinesFileSchema,
  nextSlot,
} from "@/core/machines"
import { type HostSample, MetricsHistory } from "@/core/metrics"
import { type AdbDevice, parseAdbDevices } from "@/core/parsers/adb-devices"
import type { dataPaths } from "@/core/paths"
import { readJson, writeJsonAtomic } from "@/core/store"
import { describeOp, type FarmOp } from "@/server/farm"
import { type AgentClient, agentClient } from "@/server/remote/agent-client"
import { Tunnel } from "@/server/remote/tunnel"

const exec = promisify(execFile)

export const HEARTBEAT_STALE_MS = 6000
const DESIRED_RETRY_MS = 5 * 60_000

/** Celular de um worker, já com a identidade global (serial "máquina:serial" e índice 100·slot + local). */
export interface RemoteDevice extends AdbDevice {
  key: string
  machineId: string
  localSerial: string
  localIndex?: number
  globalIndex?: number
  qemuPid?: number
}

interface Runtime {
  m: Machine
  client: AgentClient | null
  tunnel: Tunnel | null
  state: MachineState
  lastSeenAt?: number
  lastError?: string
  agentHealth?: AgentHealth
  lastState?: AgentState
  bootId?: string
  desired: number
  ops: FarmOp[]
  currentOp?: { opId: string; command: string; startedAt: string; op: FarmOp }
  lastDesiredAttempt: number
  history: MetricsHistory
  healthState: HealthState
  health: HealthResult | null
  draining: boolean
  deploying: boolean
  polling: boolean
}

export class RemoteMachines {
  private rt = new Map<string, Runtime>()
  /** chamado quando o worker reinicia (bootId mudou): o runner limpa versões instaladas/preparo */
  onReboot: (machineId: string) => void = () => undefined

  constructor(
    private readonly cfg: Config,
    private readonly p: ReturnType<typeof dataPaths>,
    private readonly log: (m: string) => void,
  ) {}

  get sshDir(): string {
    return path.join(this.p.state, "ssh")
  }
  get keyFile(): string {
    return path.join(this.sshDir, "qafarm_ed25519")
  }
  get knownHosts(): string {
    return path.join(this.sshDir, "known_hosts")
  }

  async load(desired: Record<string, number>): Promise<void> {
    const file = await readJson(this.p.machines, MachinesFileSchema, { machines: [] })
    for (const m of file.machines) this.upsertRuntime(m, desired[m.id] ?? 0)
    // túneis que sobraram de uma execução anterior do runner
    await exec("pkill", ["-f", "qafarm_ed25519.*-L 127.0.0.1:20"]).catch(() => undefined)
  }

  private upsertRuntime(m: Machine, desired?: number): Runtime {
    const cur = this.rt.get(m.id)
    const base = this.baseUrl(m)
    const client = base ? agentClient(base, m.token) : null
    if (cur) {
      cur.m = m
      cur.client = client
      if (desired !== undefined) cur.desired = desired
      if (m.transport === "ssh") {
        const spec = this.tunnelSpec(m)
        if (cur.tunnel) cur.tunnel.update(spec)
        else cur.tunnel = new Tunnel(spec, this.log)
      }
      return cur
    }
    const r: Runtime = {
      m,
      client,
      tunnel: m.transport === "ssh" ? new Tunnel(this.tunnelSpec(m), this.log) : null,
      state: m.enabled ? "connecting" : "disabled",
      desired: desired ?? 0,
      ops: [],
      lastDesiredAttempt: 0,
      history: new MetricsHistory(),
      healthState: {},
      health: null,
      draining: false,
      deploying: false,
      polling: false,
    }
    this.rt.set(m.id, r)
    return r
  }

  private tunnelSpec(m: Machine) {
    return {
      host: m.host,
      user: m.sshUser,
      port: m.sshPort,
      slot: m.slot,
      groups: appiumGroups(m.maxDevices, this.cfg.devicesPerAppium),
      appiumBasePort: this.cfg.appiumBasePort,
      keyFile: this.keyFile,
      knownHosts: this.knownHosts,
    }
  }

  private baseUrl(m: Machine): string | null {
    if (m.transport === "direct") return m.directUrl ?? null
    return `http://127.0.0.1:${localPorts(m.slot).agent}`
  }

  // ------------------------------------------------------------------ consultas ---
  ids(): Set<string> {
    return new Set(this.rt.keys())
  }
  machines(): Machine[] {
    return [...this.rt.values()].map((r) => r.m)
  }
  get(id: string): Machine | undefined {
    return this.rt.get(id)?.m
  }
  client(id: string): AgentClient | null {
    return this.rt.get(id)?.client ?? null
  }
  bySlot(slot: number): Machine | undefined {
    return [...this.rt.values()].find((r) => r.m.slot === slot)?.m
  }
  desiredOf(id: string): number {
    return this.rt.get(id)?.desired ?? 0
  }
  desiredMap(): Record<string, number> {
    return Object.fromEntries([...this.rt.values()].map((r) => [r.m.id, r.desired]))
  }

  /** Máquina apta a receber casos novos agora. */
  isOnline(id: string): boolean {
    const r = this.rt.get(id)
    return !!r && r.state === "online" && !r.draining && r.lastSeenAt !== undefined && Date.now() - r.lastSeenAt < HEARTBEAT_STALE_MS
  }
  /** Máquina respondendo (inclusive drenando): seus celulares continuam válidos. */
  isReachable(id: string): boolean {
    const r = this.rt.get(id)
    return !!r && (r.state === "online" || r.state === "degraded" || r.draining) && r.lastSeenAt !== undefined && Date.now() - r.lastSeenAt < this.cfg.remoteOfflineMs
  }
  /** Robot dos celulares desta máquina roda nela agora: opção ligada, venv instalado e máquina online. */
  runsRobot(id: string): boolean {
    return !!this.rt.get(id)?.m.runRobot && this.canRunRobot(id)
  }
  /** Worker online e com o robot instalado (ex.: para os casos do BrowserStack). */
  canRunRobot(id: string): boolean {
    return this.robotReady(id) && this.isOnline(id)
  }
  robotReady(id: string): boolean {
    return !!this.rt.get(id)?.lastState?.robot?.ready
  }
  memAvailableMb(id: string): number | null {
    const s = this.rt.get(id)?.lastState?.metrics
    return s ? s.memAvailableMb : null
  }
  healthOf(id: string): HealthResult | null {
    return this.rt.get(id)?.health ?? null
  }

  appiumUrl(machineId: string, localIndex: number): string {
    const r = this.rt.get(machineId)
    const g = Math.max(1, Math.ceil(localIndex / Math.max(1, this.cfg.devicesPerAppium)))
    if (r?.m.transport === "direct") {
      const host = r.m.directUrl ? new URL(r.m.directUrl).hostname : "127.0.0.1"
      return `http://${host}:${this.cfg.appiumBasePort + g}/wd/hub`
    }
    return `http://127.0.0.1:${localPorts(r?.m.slot ?? 0).appium(g)}/wd/hub`
  }

  /** Celulares dos workers que estão respondendo, com a identidade global. */
  devices(): RemoteDevice[] {
    const out: RemoteDevice[] = []
    for (const r of this.rt.values()) {
      if (!r.lastState || !this.isReachable(r.m.id)) continue
      for (const d of parseAdbDevices(r.lastState.adbRaw)) {
        const key = `${r.m.id}:${d.serial}`
        const gi = d.index && d.kind === "emulator" ? globalIndex(r.m.slot, d.index) : undefined
        out.push({
          ...d,
          serial: key,
          key,
          machineId: r.m.id,
          localSerial: d.serial,
          localIndex: d.index,
          globalIndex: gi,
          index: gi,
          qemuPid: d.index ? r.lastState.qemuPids[String(d.index)] : undefined,
        })
      }
    }
    return out
  }

  // ------------------------------------------------------------------ ciclo ---
  /** Consulta todos os workers em paralelo (prazo de 3 s cada): túnel, estado, métricas e saúde. */
  async poll(): Promise<void> {
    await Promise.allSettled([...this.rt.values()].map((r) => this.pollOne(r)))
  }

  private async pollOne(r: Runtime): Promise<void> {
    if (r.polling) return
    if (!r.m.enabled && !r.draining) {
      r.state = "disabled"
      r.tunnel?.stop()
      r.tunnel = null
      return
    }
    r.polling = true
    try {
      if (r.m.transport === "ssh") {
        if (!r.tunnel) r.tunnel = new Tunnel(this.tunnelSpec(r.m), this.log)
        if (!fs.existsSync(this.keyFile)) {
          r.state = "pending"
          r.lastError = "chave SSH do mestre ainda não foi criada"
          return
        }
        r.tunnel.ensure()
      }
      if (!r.client) return
      if (!r.agentHealth || r.state !== "online") {
        const h = await r.client.health()
        r.agentHealth = h
        if (h.protocol !== AGENT_PROTOCOL) {
          r.state = "incompatible"
          r.lastError = `agente com protocolo ${h.protocol}; o mestre usa ${AGENT_PROTOCOL} — atualize o agente`
          return
        }
      }
      const st = await r.client.state()
      r.tunnel?.markUp()
      if (r.bootId && st.bootId !== r.bootId) {
        this.log(`${r.m.id}: worker reiniciou`)
        this.onReboot(r.m.id)
      }
      r.bootId = st.bootId
      r.lastState = st
      r.lastSeenAt = Date.now()
      r.lastError = undefined
      r.state = r.draining ? "draining" : "online"
      if (st.metrics) this.addMetrics(r, st.metrics)
      await this.progressOps(r)
    } catch (e) {
      r.lastError = (e as Error).message
      if (r.tunnel && r.tunnel.state !== "up") r.lastError = r.tunnel.lastError || r.lastError
      const age = r.lastSeenAt === undefined ? Infinity : Date.now() - r.lastSeenAt
      r.state = age < this.cfg.remoteOfflineMs && r.lastSeenAt !== undefined ? "degraded" : r.lastSeenAt === undefined ? "connecting" : "offline"
      if (r.state === "offline") r.agentHealth = undefined
    } finally {
      r.polling = false
    }
  }

  private addMetrics(r: Runtime, s: HostSample): void {
    r.history.add(s)
    const h = evaluateHealth(s, r.healthState, Date.now(), this.cfg.health)
    const was = r.health?.brake ?? false
    r.healthState = h.state
    r.health = h
    if (h.brake && !was) this.log(`${r.m.id}: saúde crítica (${h.alerts.filter((a) => a.level === "crit").map((a) => a.message).join("; ")}): novos casos aguardam`)
    if (!h.brake && was) this.log(`${r.m.id}: saúde normalizada`)
  }

  // ------------------------------------------------------------------ fazenda ---
  queueOp(id: string, ...ops: FarmOp[]): void {
    const r = this.rt.get(id)
    if (r) r.ops.push(...ops)
  }

  setDesired(id: string, n: number): void {
    const r = this.rt.get(id)
    if (r) {
      r.desired = n
      r.lastDesiredAttempt = 0
    }
  }

  /** Emuladores faltando para o desejado da máquina → pede "ligar". */
  reconcileDesired(presentLocalIndexes: (id: string) => Set<number>, inMaintenance: (id: string, local: number) => boolean): void {
    for (const r of this.rt.values()) {
      if (r.desired <= 0 || !this.isOnline(r.m.id) || r.currentOp || r.ops.length) continue
      if (r.health?.blockStart) continue
      if (Date.now() - r.lastDesiredAttempt < DESIRED_RETRY_MS) continue
      const present = presentLocalIndexes(r.m.id)
      const missing = Array.from({ length: r.desired }, (_, k) => k + 1).filter((i) => !present.has(i) && !inMaintenance(r.m.id, i))
      if (!missing.length) continue
      r.lastDesiredAttempt = Date.now()
      this.log(`${r.m.id}: faltam celulares ${missing.join(",")} (desejado ${r.desired}) → ligando`)
      r.ops.push({ kind: "start", count: r.desired })
    }
  }

  /** Dispara a próxima operação e acompanha a atual (uma por máquina; máquinas em paralelo). */
  private async progressOps(r: Runtime): Promise<void> {
    if (!r.client) return
    if (r.currentOp) {
      const st = await r.client.farmOpStatus(r.currentOp.opId).catch(() => null)
      if (st && st.state !== "running") {
        this.log(`${r.m.id}: fazenda: ${r.currentOp.command} → ${st.state === "ok" ? "ok" : `código ${st.code}`}`)
        this.onOpDone(r.m.id, r.currentOp.op)
        r.currentOp = undefined
      }
      return
    }
    const op = r.ops.shift()
    if (!op) return
    const opId = randomUUID()
    r.currentOp = { opId, command: describeOp(op), startedAt: new Date().toISOString(), op }
    this.log(`${r.m.id}: fazenda: ${describeOp(op)}`)
    await r.client.farmOp(opId, op)
  }
  onOpDone: (machineId: string, op: FarmOp) => void = () => undefined

  farmJob(id: string): { command: string; startedAt: string } | undefined {
    const c = this.rt.get(id)?.currentOp
    return c ? { command: c.command, startedAt: c.startedAt } : undefined
  }

  // ------------------------------------------------------------------ cadastro ---
  async ensureKey(): Promise<string> {
    await fsp.mkdir(this.sshDir, { recursive: true, mode: 0o700 })
    if (!fs.existsSync(this.keyFile)) {
      await exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `qa-farm@${this.cfg.machineId}`, "-f", this.keyFile, "-q"])
    }
    return (await fsp.readFile(`${this.keyFile}.pub`, "utf8")).trim()
  }

  async publicKey(): Promise<string | null> {
    return (await fsp.readFile(`${this.keyFile}.pub`, "utf8").catch(() => "")).trim() || null
  }

  private async save(): Promise<void> {
    await writeJsonAtomic(this.p.machines, { machines: this.machines() })
    await fsp.chmod(this.p.machines, 0o600).catch(() => undefined)
  }

  async add(input: {
    id: string
    name: string
    host: string
    sshUser: string
    sshPort: number
    maxDevices: number
    directUrl?: string
    token?: string
  }): Promise<Machine> {
    if (this.rt.has(input.id) || input.id === this.cfg.machineId) throw new Error(`Já existe uma máquina "${input.id}"`)
    const slot = nextSlot(this.machines().map((m) => m.slot))
    if (slot === null) throw new Error("Limite de máquinas atingido")
    if (!input.directUrl) await this.ensureKey()
    const m: Machine = {
      id: input.id,
      name: input.name,
      host: input.host,
      sshUser: input.sshUser,
      sshPort: input.sshPort,
      slot,
      maxDevices: input.maxDevices,
      enabled: true,
      token: input.token ?? randomBytes(32).toString("hex"),
      transport: input.directUrl ? "direct" : "ssh",
      directUrl: input.directUrl,
      runRobot: false,
      createdAt: new Date().toISOString(),
    }
    this.upsertRuntime(m, 0)
    await this.save()
    return m
  }

  async update(id: string, patch: Partial<Pick<Machine, "name" | "host" | "sshUser" | "sshPort" | "maxDevices">>): Promise<Machine> {
    const r = this.rt.get(id)
    if (!r) throw new Error("Máquina não encontrada")
    this.upsertRuntime({ ...r.m, ...patch })
    await this.save()
    return this.rt.get(id)!.m
  }

  async setEnabled(id: string, enabled: boolean, hasRunning: boolean): Promise<void> {
    const r = this.rt.get(id)
    if (!r) throw new Error("Máquina não encontrada")
    r.m = { ...r.m, enabled }
    r.draining = !enabled && hasRunning
    if (enabled) r.state = "connecting"
    await this.save()
  }

  async setRunRobot(id: string, runRobot: boolean): Promise<void> {
    const r = this.rt.get(id)
    if (!r) throw new Error("Máquina não encontrada")
    r.m = { ...r.m, runRobot }
    await this.save()
  }

  /** Terminou de drenar: sem casos rodando na máquina desativada. */
  drained(id: string): void {
    const r = this.rt.get(id)
    if (r?.draining) {
      r.draining = false
      r.state = "disabled"
    }
  }

  async remove(id: string): Promise<void> {
    const r = this.rt.get(id)
    if (!r) throw new Error("Máquina não encontrada")
    r.tunnel?.stop()
    this.rt.delete(id)
    await this.save()
  }

  async rotateToken(id: string): Promise<void> {
    const r = this.rt.get(id)
    if (!r) throw new Error("Máquina não encontrada")
    this.upsertRuntime({ ...r.m, token: randomBytes(32).toString("hex") })
    r.agentHealth = undefined
    await this.save()
  }

  /** Testa a conexão agora (túnel + agente + protocolo) e devolve uma mensagem legível. */
  async test(id: string): Promise<{ ok: boolean; message: string }> {
    const r = this.rt.get(id)
    if (!r) return { ok: false, message: "Máquina não encontrada" }
    if (r.m.transport === "ssh") {
      const ssh = await exec(
        "ssh",
        [
          "-i",
          this.keyFile,
          "-p",
          String(r.m.sshPort),
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=8",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          `UserKnownHostsFile=${this.knownHosts}`,
          `${r.m.sshUser}@${r.m.host}`,
          "echo ok",
        ],
        { timeout: 15_000 },
      ).catch((e: { stderr?: string; message: string }) => ({ stdout: "", stderr: e.stderr || e.message }))
      if (!ssh.stdout.includes("ok")) {
        const why = String(ssh.stderr).trim().split("\n").pop() ?? ""
        return { ok: false, message: `SSH falhou: ${why}. Cole a chave pública do mestre no ~/.ssh/authorized_keys de ${r.m.sshUser}@${r.m.host}.` }
      }
    }
    try {
      const h = await r.client!.health()
      if (h.protocol !== AGENT_PROTOCOL) return { ok: false, message: `SSH ok · agente com protocolo ${h.protocol} ≠ ${AGENT_PROTOCOL}: atualize o agente` }
      return { ok: true, message: `SSH ok · agente ${h.agentVersion} (${h.commit}) em ${h.hostname} · protocolo ok` }
    } catch (e) {
      return { ok: false, message: `SSH ok · agente sem resposta (${(e as Error).message}). Use "Instalar agente".` }
    }
  }

  /** Instala/atualiza o agente no worker (em segundo plano). */
  deploy(id: string, repoRoot: string, done: (ok: boolean, output: string) => void): { ok: boolean; message: string } {
    const r = this.rt.get(id)
    if (!r) return { ok: false, message: "Máquina não encontrada" }
    if (r.m.transport !== "ssh") return { ok: false, message: "Máquina de teste (sem SSH): nada a instalar" }
    if (r.deploying) return { ok: false, message: "Instalação já em andamento" }
    r.deploying = true
    execFile(
      path.join(repoRoot, "scripts/ops/worker-deploy.sh"),
      [],
      {
        timeout: 5 * 60_000,
        env: {
          ...process.env,
          W_HOST: r.m.host,
          W_USER: r.m.sshUser,
          W_PORT: String(r.m.sshPort),
          W_KEY: this.keyFile,
          W_KNOWN_HOSTS: this.knownHosts,
          W_MACHINE_ID: r.m.id,
          W_MAX_DEVICES: String(r.m.maxDevices),
          W_TOKEN: r.m.token,
        },
      },
      (err, stdout, stderr) => {
        r.deploying = false
        r.agentHealth = undefined
        r.tunnel?.restart()
        done(!err, `${stdout}\n${stderr}`.trim())
      },
    )
    return { ok: true, message: `Instalando o agente em ${r.m.name}…` }
  }

  // ------------------------------------------------------------------ saída ---
  status(): MachineStatus[] {
    return [...this.rt.values()].map((r) => {
      const emus = r.lastState ? parseAdbDevices(r.lastState.adbRaw).filter((d) => d.kind === "emulator").length : 0
      return {
        id: r.m.id,
        state: r.deploying ? "connecting" : r.state,
        lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt).toISOString() : undefined,
        lastError: r.deploying ? "instalando o agente…" : r.lastError,
        agentVersion: r.agentHealth?.agentVersion,
        agentCommit: r.agentHealth?.commit,
        protocol: r.agentHealth?.protocol,
        bootId: r.bootId,
        clockSkewMs: r.lastState ? Date.parse(r.lastState.now) - (r.lastSeenAt ?? Date.now()) : undefined,
        tunnel: r.m.transport === "direct" ? "direct" : (r.tunnel?.state ?? "down"),
        desired: r.desired,
        emulators: emus,
        farmJob: this.farmJob(r.m.id),
        versions: r.lastState?.versions,
        robotReady: r.lastState?.robot?.ready,
        robotRuns: r.lastState?.robot?.runs,
      }
    })
  }

  metricsEntries() {
    return [...this.rt.values()].map((r) => ({
      id: r.m.id,
      name: r.m.name,
      role: "worker" as const,
      sample: r.lastState?.metrics ? { ...r.lastState.metrics, emulatorsRunning: parseAdbDevices(r.lastState.adbRaw).filter((d) => d.kind === "emulator").length } : null,
      history: r.history.list(),
      health: r.health
        ? { level: r.health.level, alerts: r.health.alerts, brake: r.health.brake, blockStart: r.health.blockStart }
        : { level: "ok" as const, alerts: [], brake: false, blockStart: false },
      state: r.state,
    }))
  }

  shutdown(): void {
    for (const r of this.rt.values()) r.tunnel?.stop()
  }
}
