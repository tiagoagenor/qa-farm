import type { Env } from "./types"

/** Escapa caracteres de glob que o `--test` do Robot interpreta (*, ? e [). */
export function escapeRobotPattern(name: string): string {
  return name.replace(/[[*?]/g, (c) => `[${c}]`)
}

export interface RobotArgsInput {
  listenerPath: string
  env: Env
  fileLongName: string
  outputDir: string
  suiteFile: string
}

/** Argumentos do `robot` para rodar exatamente um caso (sem shell: argv em array). */
export function buildRobotArgs(i: RobotArgsInput): string[] {
  return [
    "--listener",
    i.listenerPath,
    "-v",
    "LOC:local",
    "-v",
    "FORMATO:apk",
    "-v",
    `AMBIENTE:${i.env}`,
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
