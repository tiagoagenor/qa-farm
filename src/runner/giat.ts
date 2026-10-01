import { spawn } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { Config } from "@/core/config"
import {
  GIAT_APPIUM_PORT,
  GIAT_MAX_RUNS,
  type GiatRun,
  type GiatState,
  GiatStateSchema,
  giatEnv,
  giatStatusFromExit,
  parseEnvFile,
  validGiatTest,
} from "@/core/giat"
import type { DataPaths } from "@/core/paths"
import { readJson, writeJsonAtomic } from "@/core/store"

import { killGroup, run } from "@/server/exec"

/** Appium do GI-App-Test parado depois de tanto tempo sem execução. */
const APPIUM_IDLE_MS = 10 * 60_000
/** Teto de uma execução inteira (instalar + rodar), além do --timeout do próprio run.mjs. */
const RUN_HARD_LIMIT_MS = 2 * 60 * 60_000
const TEST_TIMEOUT_SEC = 600

type Result = { ok: boolean; message: string; data?: Record<string, unknown> }

/**
 * GI-App-Test na fazenda: reserva de celulares (o runner deixa o reservado fora das filas e não mexe nele) e
 * execuções `install-apk.mjs` → `run.mjs` num ambiente limpo, com o Appium 4723 do próprio projeto sob demanda.
 */
export class Giat {
  private state: GiatState = { reservations: {}, runs: [] }
  private procs = new Map<string, { pgid: number; timer: NodeJS.Timeout }>()
  private appiumPgid: number | null = null
  private lastUse = 0
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private cfg: Config,
    private p: DataPaths,
    private log: (m: string) => void,
  ) {}

  enabled(): boolean {
    return fs.existsSync(path.join(this.cfg.giatDir, "run.mjs"))
  }

  /** Lê o estado; execução que estava em andamento quando o runner caiu é encerrada como erro. */
  async load(): Promise<void> {
    this.state = await readJson(this.p.giatState, GiatStateSchema, { reservations: {}, runs: [] })
    let changed = false
    for (const r of this.state.runs) {
      if (r.status !== "installing" && r.status !== "running") continue
      if (r.pgid) killGroup(r.pgid)
      Object.assign(r, {
        status: "error",
        message: "Runner reiniciado durante a execução",
        endedAt: new Date().toISOString(),
        pgid: undefined,
      })
      changed = true
    }
    if (changed) await this.persist()
    if (!this.cfg.fake) await this.killStrayAppium()
  }

  reserved(serial: string): boolean {
    return serial in this.state.reservations
  }

  reservedSerials(): string[] {
    return Object.keys(this.state.reservations)
  }

  activeRun(serial: string): GiatRun | undefined {
    return this.state.runs.find((r) => r.serial === serial && (r.status === "installing" || r.status === "running"))
  }

  async reserve(serial: string): Promise<Result> {
    if (!this.enabled()) return { ok: false, message: `GI-App-Test não encontrado em ${this.cfg.giatDir}` }
    if (this.reserved(serial)) return { ok: true, message: `${serial} já está reservado` }
    this.state.reservations[serial] = { since: new Date().toISOString() }
    await this.persist()
    return { ok: true, message: `${serial} reservado para o GI-App-Test: sai das filas quando terminar o caso atual` }
  }

  async release(serial: string): Promise<Result> {
    if (!this.reserved(serial)) return { ok: true, message: `${serial} não estava reservado` }
    if (this.activeRun(serial)) return { ok: false, message: `${serial} está rodando um teste do GI-App-Test: cancele antes` }
    delete this.state.reservations[serial]
    await this.persist()
    return { ok: true, message: `${serial} devolvido à fazenda` }
  }

  /** `ready`: o celular já está no estado "reservado" (caso da fila terminou e ele está ligado). */
  async start(serial: string, test: string, env: GiatRun["env"], ready: boolean): Promise<Result> {
    if (!this.enabled()) return { ok: false, message: `GI-App-Test não encontrado em ${this.cfg.giatDir}` }
    if (!this.reserved(serial)) return { ok: false, message: `Reserve ${serial} para o GI-App-Test antes` }
    if (!ready) return { ok: false, message: `${serial} ainda não está livre (caso da fila em andamento ou desligado)` }
    if (this.activeRun(serial)) return { ok: false, message: `${serial} já está rodando um teste do GI-App-Test` }
    if (!validGiatTest(test) || !fs.existsSync(path.join(this.cfg.giatDir, "tests", test)))
      return { ok: false, message: `Caso inválido: ${test}` }
    const id = `giat_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}_${Math.random().toString(16).slice(2, 8)}`
    const r: GiatRun = { id, serial, test, env, status: "installing", startedAt: new Date().toISOString(), files: [] }
    this.state.runs.unshift(r)
    await this.prune()
    await this.persist()
    this.lastUse = Date.now()
    void this.execute(r).catch((e: Error) => this.finish(r, null, `Erro interno: ${e.message}`))
    return { ok: true, message: `Rodando ${test} em ${serial}`, data: { runId: id } }
  }

  async cancel(runId: string): Promise<Result> {
    const r = this.state.runs.find((x) => x.id === runId)
    if (!r) return { ok: false, message: "Execução não encontrada" }
    const pr = this.procs.get(runId)
    if (!pr) return { ok: false, message: "A execução não está rodando" }
    r.message = "Cancelado pelo usuário"
    killGroup(pr.pgid, "SIGTERM") // o run.mjs fecha as sessões e sai com 143
    setTimeout(() => killGroup(pr.pgid, "SIGKILL"), 15_000).unref()
    return { ok: true, message: "Cancelando" }
  }

  /** Para o Appium do GI-App-Test quando fica ocioso. */
  async tick(): Promise<void> {
    const active = this.state.runs.some((r) => r.status === "installing" || r.status === "running")
    if (!active && this.appiumPgid && Date.now() - this.lastUse > APPIUM_IDLE_MS) {
      this.log("GI-App-Test: Appium 4723 ocioso — parando")
      killGroup(this.appiumPgid)
      this.appiumPgid = null
    }
  }

  async shutdown(): Promise<void> {
    for (const pr of this.procs.values()) clearTimeout(pr.timer)
    await this.writing
  }

  // ------------------------------------------------------------- execução ---
  private async execute(r: GiatRun): Promise<void> {
    const dir = this.p.giatRun(r.id)
    await fsp.mkdir(dir, { recursive: true })
    const logPath = path.join(dir, "output.log")
    const env = await this.env(r.serial)
    if (!this.cfg.fake && !(await this.ensureAppium(env))) {
      await fsp.appendFile(logPath, "Appium 4723 do GI-App-Test não respondeu\n")
      return this.finish(r, 3, "Appium 4723 do GI-App-Test não subiu (veja logs/giat-appium.log)")
    }
    // 1) APK por hash (o script nunca desinstala em celular físico: sai com 3 pedindo para desinstalar à mão)
    const inst = await this.spawnStep(r, ["scripts/install-apk.mjs", "-d", r.serial], env, logPath)
    if (inst !== 0) {
      const tail = (await fsp.readFile(logPath, "utf8").catch(() => "")).trim().split("\n").slice(-3).join(" ")
      return this.finish(r, inst, `Falha ao preparar o APK (código ${inst}): ${tail.slice(0, 300)}`)
    }
    if (r.status === "canceled" || r.message === "Cancelado pelo usuário") return this.finish(r, 143)
    r.status = "running"
    await this.persist()
    // 2) o caso
    const json = path.join(dir, "result.json")
    const code = await this.spawnStep(
      r,
      ["run.mjs", r.test, "-d", r.serial, "--env", r.env, "--json", json, "--timeout", String(TEST_TIMEOUT_SEC)],
      env,
      logPath,
    )
    await this.collect(r, json)
    return this.finish(r, code)
  }

  private spawnStep(r: GiatRun, args: string[], env: Record<string, string>, logPath: string): Promise<number | null> {
    return new Promise((resolve) => {
      const out = fs.openSync(logPath, "a")
      fs.writeSync(out, `\n$ node ${args.join(" ")}\n`)
      const child = spawn(process.execPath, args, {
        cwd: this.cfg.giatDir,
        env: env as NodeJS.ProcessEnv,
        detached: true,
        stdio: ["ignore", out, out],
      })
      fs.closeSync(out)
      const pgid = child.pid!
      r.pgid = pgid
      const timer = setTimeout(() => {
        this.log(`GI-App-Test: ${r.id} passou do limite de ${RUN_HARD_LIMIT_MS / 60_000} min — encerrando`)
        killGroup(pgid, "SIGTERM")
        setTimeout(() => killGroup(pgid, "SIGKILL"), 15_000).unref()
      }, RUN_HARD_LIMIT_MS)
      timer.unref()
      this.procs.set(r.id, { pgid, timer })
      void this.persist()
      child.on("error", (e) => {
        fs.appendFileSync(logPath, `erro ao iniciar: ${e.message}\n`)
      })
      child.on("close", (code, signal) => {
        clearTimeout(timer)
        this.procs.delete(r.id)
        resolve(code ?? (signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : null))
      })
    })
  }

  /** Resumo do --json e cópia dos prints/logs citados nele (só arquivos de dentro do projeto). */
  private async collect(r: GiatRun, json: string): Promise<void> {
    const files = ["output.log"]
    const raw = await fsp.readFile(json, "utf8").catch(() => null)
    if (raw) {
      files.push("result.json")
      try {
        const data = JSON.parse(raw) as { tests?: Array<{ ok?: boolean; log?: string; shot?: string }> }
        const tests = Array.isArray(data.tests) ? data.tests : []
        r.summary = { total: tests.length, passed: tests.filter((t) => t.ok).length, failed: tests.filter((t) => !t.ok).length }
        for (const t of tests) {
          for (const f of [t.log, t.shot]) {
            if (typeof f !== "string" || !f) continue
            const src = path.resolve(this.cfg.giatDir, f)
            if (!src.startsWith(path.resolve(this.cfg.giatDir) + path.sep)) continue
            const name = path.basename(src).replace(/[^\w.-]/g, "_")
            if (await fsp.copyFile(src, path.join(this.p.giatRun(r.id), name)).then(() => true, () => false)) files.push(name)
          }
        }
      } catch {
        /* JSON inválido: fica só o log */
      }
    }
    r.files = files
  }

  private async finish(r: GiatRun, code: number | null, message?: string): Promise<void> {
    const s = giatStatusFromExit(code)
    const canceled = r.message === "Cancelado pelo usuário"
    r.status = canceled ? "canceled" : s.status
    r.exitCode = code
    r.message = message ?? (canceled ? r.message : s.message)
    r.endedAt = new Date().toISOString()
    r.pgid = undefined
    if (!r.files.length) r.files = ["output.log"]
    this.lastUse = Date.now()
    this.log(`GI-App-Test: ${r.test} em ${r.serial} → ${r.status}${r.message ? ` (${r.message})` : ""}`)
    await this.persist()
  }

  private async env(serial: string): Promise<Record<string, string>> {
    const secrets = parseEnvFile(await fsp.readFile(path.join(this.cfg.giatDir, ".env.server"), "utf8").catch(() => ""))
    return giatEnv({
      nodeBin: path.dirname(process.execPath),
      sdkRoot: this.cfg.sdkRoot,
      javaHome: this.cfg.javaHome,
      home: os.homedir(),
      tmpDir: os.tmpdir(),
      serials: [serial],
      secrets,
    })
  }

  // ---------------------------------------------------------------- Appium ---
  private appiumBin(): string {
    return path.join(this.cfg.giatDir, "node_modules/.bin/appium")
  }

  private async appiumUp(): Promise<boolean> {
    try {
      const r = await fetch(`http://127.0.0.1:${GIAT_APPIUM_PORT}/status`, { signal: AbortSignal.timeout(3000) })
      return r.ok
    } catch {
      return false
    }
  }

  private async ensureAppium(env: Record<string, string>): Promise<boolean> {
    if (await this.appiumUp()) return true
    this.log("GI-App-Test: subindo o Appium 4723 do projeto")
    const out = fs.openSync(this.p.giatAppiumLog, "a")
    const child = spawn(this.appiumBin(), ["--address", "127.0.0.1", "--port", String(GIAT_APPIUM_PORT)], {
      cwd: this.cfg.giatDir,
      env: { ...env, APPIUM_HOME: this.cfg.giatDir } as unknown as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", out, out],
    })
    fs.closeSync(out)
    child.unref()
    this.appiumPgid = child.pid ?? null
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 1000))
      if (await this.appiumUp()) return true
    }
    return false
  }

  /** Appium 4723 que sobrou de um runner anterior: só o do projeto, pelo comando exato. */
  private async killStrayAppium(): Promise<void> {
    const pattern = `${this.appiumBin()} --address 127.0.0.1 --port ${GIAT_APPIUM_PORT}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    await run("pkill", ["-u", String(process.getuid?.() ?? ""), "-f", pattern]).catch(() => undefined)
  }

  // ----------------------------------------------------------- persistência ---
  private async prune(): Promise<void> {
    const old = this.state.runs.slice(GIAT_MAX_RUNS)
    this.state.runs = this.state.runs.slice(0, GIAT_MAX_RUNS)
    for (const r of old) await fsp.rm(this.p.giatRun(r.id), { recursive: true, force: true })
  }

  private persist(): Promise<void> {
    this.writing = this.writing
      .then(() => writeJsonAtomic(this.p.giatState, this.state))
      .catch((e: Error) => this.log(`GI-App-Test: falha ao gravar o estado: ${e.message}`))
    return this.writing
  }
}
