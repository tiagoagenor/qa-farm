import { z } from "zod"

import type { CatalogEntry, RunResult } from "./types"

// GI-App-Test (projeto QA_Automacao_TESTE, Node + WebdriverIO): segundo projeto de testes da fazenda. Os casos
// entram nas mesmas filas do Robot; cada caso roda `node run.mjs <caso> -d <serial>` com o Appium da fazenda.
// Sem imports de node:* — este arquivo também vai para o navegador.

export const PROJECTS = ["robot", "giat"] as const
export const ProjectSchema = z.enum(PROJECTS)
export type Project = z.infer<typeof ProjectSchema>

export const PROJECT_LABEL: Record<Project, string> = {
  robot: "Robot (QA_Automacao_APP)",
  giat: "GI-App-Test (QA_Automacao_TESTE)",
}

/** Ambientes de cada projeto (valor gravado na fila; o GI-App-Test recebe em maiúsculas). */
export const PROJECT_ENVS = { robot: ["hml", "dev", "pre"], giat: ["hml", "prod", "mock"] } as const

export const GIAT_ID_PREFIX = "giat:"

/** Caso válido: caminho relativo a tests/, terminando em .mjs, sem "..". Tudo em tests/ é caso (o que não for, fica fora de tests/). */
export function validGiatTest(test: string): boolean {
  if (!/^[\w][\w./-]*\.mjs$/.test(test)) return false
  const parts = test.split("/")
  return !parts.some((s) => s === ".." || s === "." || s === "")
}

/** Entrada do catálogo a partir do caminho relativo a tests/ (nome bonito opcional, vindo do `run.mjs --list`). */
export function giatEntry(rel: string, name?: string, tags: string[] = []): CatalogEntry {
  const parts = rel.split("/")
  const dir = parts.slice(0, -1).join("/")
  const base = parts.at(-1)!.replace(/\.mjs$/, "")
  return {
    id: `${GIAT_ID_PREFIX}${rel}`,
    name: name?.trim() || base,
    fileLongName: rel,
    suite: dir || "tests",
    file: `tests/${rel}`,
    folder: dir ? `tests/${dir}` : "tests",
    line: 1,
    tags,
    accounts: [],
    duplicate: false,
  }
}

/** Lê um arquivo KEY=VALUE (comentários e linhas vazias ignorados; aspas simples/duplas removidas). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

/**
 * Ambiente LIMPO do processo do caso: nada herdado da fazenda. Os segredos vêm do .env.server do projeto; o
 * celular, o Appium e a porta do UiAutomator2 são sempre os que a fazenda escolheu (vencem o .env.server).
 */
export function giatEnv(o: {
  nodeBin: string
  sdkRoot: string
  javaHome: string
  home: string
  tmpDir: string
  serial: string
  appiumUrl: string
  systemPort: number
  secrets: Record<string, string>
}): Record<string, string> {
  return {
    ...o.secrets,
    PATH: [o.nodeBin, `${o.sdkRoot}/platform-tools`, `${o.javaHome}/bin`, "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    HOME: o.home,
    TMPDIR: o.tmpDir,
    LANG: "C.UTF-8",
    ANDROID_HOME: o.sdkRoot,
    ANDROID_SDK_ROOT: o.sdkRoot,
    JAVA_HOME: o.javaHome,
    GIAT_ALLOWED_DEVICES: o.serial,
    DEVICE_SERIAL: o.serial,
    APPIUM_URL: o.appiumUrl,
    SYSTEM_PORT: String(o.systemPort),
  }
}

/** Um teste no --json do run.mjs. */
export interface GiatJsonResult {
  ok?: boolean
  infra?: boolean
  error?: string
  shot?: string
  log?: string
  /** passo em que o teste parou (o texto já vem com as senhas mascaradas pelo GI-App-Test) */
  failedAt?: { file?: string; line?: number; source?: string } | null
}

/** Erro + onde parou: "<erro>\nPasso: login-sucesso.mjs:39 — await app.tap(...)". */
function failureText(r: GiatJsonResult | undefined): string | undefined {
  const err = r?.error?.trim()
  const at = r?.failedAt
  if (!at?.file && !at?.source) return err
  const where = `Passo: ${at.file ? `${at.file.split("/").pop()}${at.line ? `:${at.line}` : ""}` : ""}${at.source ? `${at.file ? " — " : ""}${at.source.trim()}` : ""}`
  return err ? `${err}\n${where}` : where
}

/**
 * Resultado da tentativa a partir do código de saída e do --json. Saída: 0 passou; 1 falhou; 2 uso inválido
 * (config); 3 infraestrutura (Appium, celular, porta); 130/143 interrompido pela fazenda.
 */
export function classifyGiat(o: {
  exitCode: number | null
  canceled: boolean
  timedOut: boolean
  deviceLost: boolean
  results: GiatJsonResult[]
  screenshots: string[]
}): RunResult {
  const err = failureText(o.results.find((r) => !r.ok))
  const base = { screenshots: o.screenshots, hasOutputXml: false, exitCode: o.exitCode }
  if (o.canceled) return { ...base, status: "canceled", message: "Cancelado" }
  if (o.deviceLost) return { ...base, status: "infra_error", message: "Celular caiu durante o caso" }
  if (o.timedOut) return { ...base, status: "timeout", message: "Tempo limite da fila estourado" }
  switch (o.exitCode) {
    case 0:
      return { ...base, status: "passed" }
    case 1:
      return o.results.some((r) => r.infra)
        ? { ...base, status: "infra_error", message: err ?? "Erro de infraestrutura" }
        : { ...base, status: "failed", message: err ?? "Falhou" }
    case 2:
      return { ...base, status: "config_error", message: err ?? "Uso inválido do run.mjs (caso inexistente ou celular fora da lista)" }
    case 3:
      return { ...base, status: "infra_error", message: err ?? "Infraestrutura: Appium fora do ar, celular ausente ou sem porta" }
    default:
      return { ...base, status: "infra_error", message: err ?? `run.mjs saiu com código ${o.exitCode ?? "desconhecido"}` }
  }
}
