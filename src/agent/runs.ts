import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import { RUN_OUT, RUN_REPO, type RunRequest, type RunStatus } from "@/core/agent-protocol"
import type { Config } from "@/core/config"
import { buildRobotEnv } from "@/core/robot-args"
import type { Adapters } from "@/server/adapters"
import { isAlive, killGroup, run } from "@/server/exec"

// Robot rodando no worker: o mestre manda o snapshot do projeto (tar) e pede "rode este caso"; o console e os
// artefatos ficam em data/runs/<runId> até o mestre copiar e apagar. O processo é detached (grupo próprio):
// reiniciar o agente não derruba o caso — meta.json/exit.json no disco guardam o estado.

const READY_MARK = ".qafarm-workspace"
const KEEP_WORKSPACES = 3
/** o mestre consulta a cada ~3 s; sem notícia dele por este tempo o robot é órfão (mestre caiu/reiniciou) */
export const RUN_LEASE_MS = 90_000
const RUN_MAX_AGE_MS = 24 * 3600_000

interface RunEntry {
  pid: number
  state: "running" | "exited"
  code: number | null
  touchedAt: number
}

export interface RunManagerOptions {
  cfg: Config
  ad: Adapters
  log: (m: string) => void
  leaseMs?: number
}

export class RunManager {
  readonly wsDir: string
  readonly runsDir: string
  private runs = new Map<string, RunEntry>()
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly o: RunManagerOptions) {
    this.wsDir = path.join(o.cfg.dataDir, "workspaces")
    this.runsDir = path.join(o.cfg.dataDir, "runs")
  }

  get robotReady(): boolean {
    return this.o.cfg.fake || fs.existsSync(this.o.cfg.robotBin)
  }
  get runningCount(): number {
    return [...this.runs.values()].filter((r) => r.state === "running").length
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.wsDir, { recursive: true, mode: 0o700 })
    await fsp.mkdir(this.runsDir, { recursive: true, mode: 0o700 })
    // execuções de antes de um reinício do agente: segue acompanhando as vivas
    for (const id of await fsp.readdir(this.runsDir).catch(() => [] as string[])) {
      const meta = await this.readMeta(id)
      if (!meta) continue
      const exit = await this.readExit(id)
      this.runs.set(id, {
        pid: meta.pid,
        state: exit || !isAlive(meta.pid) ? "exited" : "running",
        code: exit?.code ?? null,
        touchedAt: Date.now(),
      })
    }
    this.timer = setInterval(() => void this.sweep(), 15_000)
    this.timer.unref()
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
  }

  // ------------------------------------------------------------ snapshots ---
  hasWorkspace(hash: string): boolean {
    return fs.existsSync(path.join(this.wsDir, hash, READY_MARK))
  }

  /** Recebe o tar.gz do snapshot (stream) e publica atomicamente em workspaces/<hash>. */
  async receiveWorkspace(hash: string, body: NodeJS.ReadableStream): Promise<void> {
    if (this.hasWorkspace(hash)) return
    const tmp = path.join(this.wsDir, `${hash}.tmp-${process.pid}-${Date.now()}`)
    const tgz = `${tmp}.tgz`
    try {
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(tgz, { mode: 0o600 })
        body.pipe(out)
        out.on("finish", resolve)
        out.on("error", reject)
        body.on("error", reject)
      })
      await fsp.mkdir(tmp, { recursive: true, mode: 0o700 })
      const r = await run("tar", ["-xzf", tgz, "-C", tmp, "--no-same-owner"], { timeoutMs: 120_000 })
      if (r.code !== 0) throw new Error(`tar falhou: ${r.stderr.slice(0, 300)}`)
      // o snapshot do mestre é somente leitura (inclusive a raiz, que o tar reaplica): libera só a raiz para a marca
      await fsp.chmod(tmp, 0o700)
      await fsp.writeFile(path.join(tmp, READY_MARK), new Date().toISOString())
      await fsp.rename(tmp, path.join(this.wsDir, hash)).catch(async () => {
        await this.rmTree(tmp) // outro envio publicou antes
      })
    } finally {
      await fsp.rm(tgz, { force: true })
      if (fs.existsSync(tmp)) await this.rmTree(tmp)
    }
    await this.pruneWorkspaces(hash)
  }

  private async pruneWorkspaces(keep: string): Promise<void> {
    const names = (await fsp.readdir(this.wsDir).catch(() => [] as string[])).filter(
      (n) => !n.includes(".tmp-"),
    )
    const withTime = await Promise.all(
      names.map(async (n) => ({
        n,
        t: (await fsp.stat(path.join(this.wsDir, n)).catch(() => null))?.mtimeMs ?? 0,
      })),
    )
    const old = withTime.sort((a, b) => b.t - a.t).slice(KEEP_WORKSPACES)
    for (const w of old) if (w.n !== keep) await this.rmTree(path.join(this.wsDir, w.n))
  }

  private async rmTree(p: string): Promise<void> {
    await run("chmod", ["-R", "u+w", p]).catch(() => undefined)
    await fsp.rm(p, { recursive: true, force: true })
  }

  // ------------------------------------------------------------ execuções ---
  async start(req: RunRequest): Promise<RunStatus> {
    const existing = this.runs.get(req.runId)
    if (existing) return this.status(req.runId)! // idempotente (retry do mestre)
    if (!this.robotReady) throw new Error(`robot não instalado neste worker (${this.o.cfg.robotBin})`)
    const ws = path.join(this.wsDir, req.workspace)
    if (!this.hasWorkspace(req.workspace))
      throw new Error("snapshot do projeto não está neste worker (envie antes)")
    const dir = path.join(this.runsDir, req.runId)
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    const args = req.args.map((a) => a.split(RUN_OUT).join(dir).split(RUN_REPO).join(this.o.cfg.repoRoot))
    const cfg = this.o.cfg
    const base = {
      PATH: [
        path.join(cfg.sdkRoot, "platform-tools"),
        path.dirname(cfg.appiumBin),
        path.join(cfg.javaHome, "bin"),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ].join(":"),
      HOME: process.env.HOME ?? "",
      LANG: "C.UTF-8",
      ANDROID_HOME: cfg.sdkRoot,
      ANDROID_SDK_ROOT: cfg.sdkRoot,
      JAVA_HOME: cfg.javaHome,
    }
    const extra: Record<string, string> = { ...req.env }
    if (req.appiumIndex) extra.QAFARM_APPIUM_URL = this.o.ad.appium.url(req.appiumIndex)
    const env = buildRobotEnv(base, extra)
    const spawned = this.o.ad.robot.spawn({ args, env, cwd: ws, consoleFile: path.join(dir, "console.log") })
    await fsp.writeFile(
      path.join(dir, ".meta.json"),
      JSON.stringify({ pid: spawned.pid, startedAt: new Date().toISOString() }),
    )
    const entry: RunEntry = { pid: spawned.pid, state: "running", code: null, touchedAt: Date.now() }
    this.runs.set(req.runId, entry)
    this.o.log(`robot ${req.runId} iniciado (pid ${spawned.pid})`)
    void spawned.exited.then(async (res) => {
      entry.state = "exited"
      entry.code = res.code
      await fsp
        .writeFile(path.join(dir, ".exit.json"), JSON.stringify({ code: res.code }))
        .catch(() => undefined)
      killGroup(spawned.pid, "SIGKILL") // nenhum filho fica para trás
      this.o.log(`robot ${req.runId} terminou (código ${res.code})`)
    })
    return { runId: req.runId, state: "running", code: null }
  }

  /** Consulta do mestre (renova o lease). null = execução desconhecida. */
  status(runId: string): RunStatus | null {
    const r = this.runs.get(runId)
    if (!r) return null
    r.touchedAt = Date.now()
    if (r.state === "running" && !isAlive(r.pid)) r.state = "exited"
    return { runId, state: r.state, code: r.code }
  }

  kill(runId: string, signal: NodeJS.Signals): boolean {
    const r = this.runs.get(runId)
    if (!r) return false
    if (r.state === "running") killGroup(r.pid, signal)
    return true
  }

  async files(runId: string): Promise<Array<{ name: string; size: number }> | null> {
    if (!this.runs.has(runId)) return null
    const root = path.join(this.runsDir, runId)
    const out: Array<{ name: string; size: number }> = []
    const walk = async (d: string) => {
      for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.isFile() && !e.name.startsWith("."))
          out.push({ name: path.relative(root, p), size: (await fsp.stat(p)).size })
      }
    }
    await walk(root)
    return out
  }

  /** Caminho seguro de um arquivo da execução (nada fora da pasta dela). */
  filePath(runId: string, name: string): string | null {
    if (!this.runs.has(runId)) return null
    const root = path.join(this.runsDir, runId)
    const p = path.resolve(root, name)
    if (!p.startsWith(`${root}${path.sep}`) || path.basename(p).startsWith(".")) return null
    return p
  }

  async remove(runId: string): Promise<void> {
    const r = this.runs.get(runId)
    if (r?.state === "running") killGroup(r.pid, "SIGKILL")
    this.runs.delete(runId)
    await fsp.rm(path.join(this.runsDir, runId), { recursive: true, force: true })
  }

  /** Mata robots órfãos (mestre sumiu) e apaga execuções antigas que o mestre nunca buscou. */
  async sweep(now = Date.now()): Promise<void> {
    const lease = this.o.leaseMs ?? RUN_LEASE_MS
    for (const [id, r] of this.runs) {
      if (r.state === "running" && now - r.touchedAt > lease) {
        this.o.log(
          `robot ${id} sem notícia do mestre há ${Math.round((now - r.touchedAt) / 1000)} s → encerrando`,
        )
        killGroup(r.pid, "SIGKILL")
      }
      if (r.state === "exited" && now - r.touchedAt > RUN_MAX_AGE_MS) await this.remove(id)
    }
  }

  private async readMeta(id: string): Promise<{ pid: number } | null> {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(this.runsDir, id, ".meta.json"), "utf8")) as {
        pid?: number
      }
      return typeof j.pid === "number" ? { pid: j.pid } : null
    } catch {
      return null
    }
  }
  private async readExit(id: string): Promise<{ code: number | null } | null> {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.runsDir, id, ".exit.json"), "utf8")) as {
        code: number | null
      }
    } catch {
      return null
    }
  }
}
