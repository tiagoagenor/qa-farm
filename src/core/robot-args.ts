import type { Env } from "./types"

/** Escapa caracteres de glob que o `--test` do Robot interpreta (*, ? e [). */
export function escapeRobotPattern(name: string): string {
  return name.replace(/[[*?]/g, (c) => `[${c}]`)
}

/**
 * Variáveis de espera do projeto (ex.: `TIMEOUT_L = '20s'`) → segundos. Aceita "20s", "20", "1.5 s", "500ms".
 * Só nomes em MAIÚSCULAS com TIMEOUT/TEMPO/WAIT (o arquivo é do projeto; nada é executado, só lido como texto).
 */
export function parseTimeoutVariables(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  const re = /^([A-Z0-9_]*(?:TIMEOUT|TEMPO|WAIT)[A-Z0-9_]*)\s*=\s*['"]?\s*([\d.]+)\s*(ms|s|sec|seconds?)?\s*['"]?\s*(?:#.*)?$/gm
  for (const m of text.matchAll(re)) {
    const n = Number(m[2])
    if (!Number.isFinite(n)) continue
    out[m[1]] = m[3] === "ms" ? n / 1000 : n
  }
  return out
}

/** Esperas multiplicadas pelo fator da fila, como argumentos `-v NOME:Ns` do Robot (linha de comando vence o arquivo). */
export function scaledTimeoutArgs(vars: Record<string, number>, factor: number): string[] {
  if (!(factor > 1)) return []
  return Object.entries(vars).flatMap(([k, sec]) => ["-v", `${k}:${Math.ceil(sec * factor)}s`])
}

export interface RobotArgsInput {
  listenerPath: string
  /** listener que grava massa.json (opcional) */
  massaListenerPath?: string
  env: Env
  fileLongName: string
  outputDir: string
  suiteFile: string
  /** variáveis extras (-v NOME:valor), ex.: esperas multiplicadas */
  extraVars?: string[]
}

/** Argumentos do `robot` para rodar exatamente um caso (sem shell: argv em array). */
export function buildRobotArgs(i: RobotArgsInput): string[] {
  return [
    "--listener",
    i.listenerPath,
    ...(i.massaListenerPath ? ["--listener", i.massaListenerPath] : []),
    "-v",
    "LOC:local",
    "-v",
    "FORMATO:apk",
    "-v",
    `AMBIENTE:${i.env}`,
    ...(i.extraVars ?? []),
    "--test",
    escapeRobotPattern(i.fileLongName),
    "--outputdir",
    i.outputDir,
    "--console",
    "verbose",
    "--consolecolors",
    "off",
    i.suiteFile,
  ]
}

export const ROBOT_ENV_WHITELIST = [
  "PATH",
  "HOME",
  "LANG",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "JAVA_HOME",
  "AMBIENTE",
  "QAFARM_SERIAL",
  "QAFARM_INDEX",
  "QAFARM_APPIUM_URL",
  "QAFARM_APP_PACKAGE",
  "QAFARM_APP_ACTIVITY",
] as const

/** Monta o ambiente do processo `robot` só com variáveis permitidas (nada de segredos do painel). */
export function buildRobotEnv(
  base: Record<string, string | undefined>,
  extra: Partial<Record<(typeof ROBOT_ENV_WHITELIST)[number], string>>,
): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...base, ...extra }
  const out: Record<string, string> = {}
  for (const k of ROBOT_ENV_WHITELIST) {
    const v = merged[k]
    if (v !== undefined) out[k] = v
  }
  return out
}
