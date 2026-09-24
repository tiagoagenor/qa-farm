import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import type { Config } from "@/core/config"

export interface SpawnedRobot {
  pid: number
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

export interface RobotLauncher {
  spawn(opts: { args: string[]; env: Record<string, string>; cwd: string; consoleFile: string }): SpawnedRobot
}

function launch(cmd: string, argv: string[], env: Record<string, string>, cwd: string, consoleFile: string): SpawnedRobot {
  fs.mkdirSync(path.dirname(consoleFile), { recursive: true })
  const out = fs.openSync(consoleFile, "a")
  // detached: o robot vira líder de um grupo de processos (pgid = pid) → timeout/cancelar matam o grupo todo
  const child = spawn(cmd, argv, { cwd, env: env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", out, out] })
  fs.closeSync(out)
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }))
    child.on("error", () => resolve({ code: 127, signal: null }))
  })
  return { pid: child.pid ?? -1, exited }
}

export function realRobot(cfg: Config): RobotLauncher {
  return {
    spawn: ({ args, env, cwd, consoleFile }) => launch(cfg.robotBin, args, env, cwd, consoleFile),
  }
}

/** Fake: roda scripts/robot/fake_robot.mjs com os mesmos argumentos do robot. */
export function fakeRobot(cfg: Config): RobotLauncher {
  const script = path.join(cfg.repoRoot, "scripts/robot/fake_robot.mjs")
  return {
    spawn: ({ args, env, cwd, consoleFile }) =>
      launch(
        process.execPath,
        [script, ...args],
        { ...env, QAFARM_FAKE_SPEED: String(cfg.fakeSpeed), QAFARM_REPO_ROOT: cfg.repoRoot },
        cwd,
        consoleFile,
      ),
  }
}
