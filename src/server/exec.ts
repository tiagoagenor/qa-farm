import { execFile } from "node:child_process"

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Executa um comando sem shell (argv em array). Nunca lança: erros viram code != 0. */
export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs ?? 60_000,
        cwd: opts.cwd,
        env: opts.env,
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: unknown; killed?: boolean }) | null
        const code = !e ? 0 : typeof e.code === "number" ? e.code : e.killed ? null : 1
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (e && !stderr ? e.message : "") })
      },
    )
  })
}

/** Executa e devolve stdout como Buffer (ex.: screencap). */
export function runBuffer(cmd: string, args: string[], timeoutMs = 15_000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : (stdout as Buffer))
    })
  })
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Mata um grupo de processos (pgid) com o sinal dado. Ignora se já morreu. */
export function killGroup(pgid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    /* já terminou */
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
