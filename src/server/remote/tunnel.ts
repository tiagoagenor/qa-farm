import { type ChildProcess, spawn } from "node:child_process"

import { AGENT_PORT, localPorts } from "@/core/machines"

// Túnel SSH aberto pelo MESTRE até o worker: leva o agente (7100) e os Appiums (4800+g) para portas locais
// do mestre (20000+100·slot …). Nenhuma porta nova fica exposta na rede do worker.

export interface TunnelSpec {
  host: string
  user: string
  port: number
  slot: number
  groups: number
  appiumBasePort: number
  keyFile: string
  knownHosts: string
}

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]

export class Tunnel {
  private proc: ChildProcess | null = null
  private failures = 0
  private retryAt = 0
  private stopped = false
  state: "up" | "down" | "starting" = "down"
  lastError = ""

  constructor(
    private spec: TunnelSpec,
    private readonly log: (m: string) => void,
  ) {}

  args(): string[] {
    const p = localPorts(this.spec.slot)
    const fw = ["-L", `127.0.0.1:${p.agent}:127.0.0.1:${AGENT_PORT}`]
    for (let g = 1; g <= this.spec.groups; g++) fw.push("-L", `127.0.0.1:${p.appium(g)}:127.0.0.1:${this.spec.appiumBasePort + g}`)
    return [
      "-N",
      "-i",
      this.spec.keyFile,
      "-p",
      String(this.spec.port),
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${this.spec.knownHosts}`,
      ...fw,
      `${this.spec.user}@${this.spec.host}`,
    ]
  }

  /** Garante o processo ssh rodando (com espera crescente depois de falhas). */
  ensure(): void {
    if (this.stopped || this.proc || Date.now() < this.retryAt) return
    this.state = "starting"
    const proc = spawn("ssh", this.args(), { stdio: ["ignore", "ignore", "pipe"] })
    this.proc = proc
    let err = ""
    proc.stderr?.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-600)
    })
    proc.on("exit", (code) => {
      this.proc = null
      this.state = "down"
      this.lastError = err.trim().split("\n").pop() || `ssh saiu (código ${code})`
      const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]
      this.failures++
      this.retryAt = Date.now() + wait
      if (!this.stopped) this.log(`túnel ${this.spec.user}@${this.spec.host} caiu: ${this.lastError} (nova tentativa em ${wait / 1000}s)`)
    })
    proc.on("error", (e) => {
      this.lastError = e.message
    })
  }

  /** O agente respondeu por este túnel: considera de pé e zera a espera. */
  markUp(): void {
    if (this.proc) {
      this.state = "up"
      this.failures = 0
    }
  }

  get running(): boolean {
    return this.proc !== null
  }

  update(spec: TunnelSpec): void {
    const changed = JSON.stringify(spec) !== JSON.stringify(this.spec)
    this.spec = spec
    if (changed) this.restart()
  }

  restart(): void {
    this.proc?.kill("SIGTERM")
    this.proc = null
    this.retryAt = 0
  }

  stop(): void {
    this.stopped = true
    this.proc?.kill("SIGTERM")
    this.proc = null
    this.state = "down"
  }
}
