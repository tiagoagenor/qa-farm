import type { RunResult } from "../types"

export interface RobotTestResult {
  name: string
  status: "PASS" | "FAIL" | "SKIP" | "NOT RUN"
  message: string
  teardownMessage?: string
  elapsedMs?: number
}

const TEARDOWN_MARK = "\n\nAlso teardown failed:"

export function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
}

/** "20260923 22:14:52.965" → epoch ms */
function robotTime(t: string): number {
  const m = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(t)
  if (!m) return NaN
  const [, y, mo, d, h, mi, s, ms] = m
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms)
}

/** Separa a mensagem principal do sufixo "Also teardown failed:" que o Robot anexa. */
export function splitTeardown(message: string): { message: string; teardownMessage?: string } {
  const i = message.indexOf(TEARDOWN_MARK)
  if (i < 0) return { message }
  return {
    message: message.slice(0, i),
    teardownMessage: message.slice(i + TEARDOWN_MARK.length).replace(/^\n/, ""),
  }
}

/**
 * Lê os casos de um output.xml do Robot Framework 6.x (schemaversion 4).
 * O status do caso é o último elemento <status> filho direto de <test>.
 */
export function parseRobotOutput(xml: string): RobotTestResult[] {
  const results: RobotTestResult[] = []
  const testRe = /<test\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/test>/g
  for (const m of xml.matchAll(testRe)) {
    const name = decodeXml(m[1])
    const body = m[2]
    // o status do caso é o último <status> do bloco (os anteriores são das keywords)
    const tail = body.slice(body.lastIndexOf("<status "))
    const statusRe =
      /^<status status="([A-Z ]+)"(?: starttime="([^"]*)")?(?: endtime="([^"]*)")?[^>]*?(?:\/>|>([\s\S]*?)<\/status>)\s*$/
    const sm = statusRe.exec(tail)
    if (!sm) continue
    const status = sm[1] as RobotTestResult["status"]
    const raw = decodeXml(sm[4] ?? "")
    const { message, teardownMessage } = splitTeardown(raw)
    const start = sm[2] ? robotTime(sm[2]) : NaN
    const end = sm[3] ? robotTime(sm[3]) : NaN
    results.push({
      name,
      status,
      message,
      teardownMessage,
      elapsedMs: Number.isFinite(start) && Number.isFinite(end) ? end - start : undefined,
    })
  }
  return results
}

const INFRA_PATTERNS = [
  /Could not start a new session/i,
  /ECONNREFUSED/,
  /socket hang up/i,
  /instrumentation process is not running/i,
  /Failed to establish a new connection/i,
  /Connection refused/i,
  /Connection aborted/i,
  /device '?[\w.:-]+'? not found/i,
  /UiAutomator2 server.*(?:not|isn't) (?:running|responding)/i,
]

export function looksLikeInfra(text: string): boolean {
  return INFRA_PATTERNS.some((re) => re.test(text))
}

export interface ClassifyInput {
  exitCode: number | null
  canceled: boolean
  timedOut: boolean
  deviceLost: boolean
  outputXml?: string
  consoleText: string
  screenshots?: string[]
}

function lastLines(text: string, n: number): string {
  return text.trim().split("\n").slice(-n).join("\n")
}

/** Decide o status final de uma tentativa a partir do que o processo deixou. */
export function classifyRun(input: ClassifyInput): RunResult {
  const screenshots = input.screenshots ?? []
  const tests = input.outputXml ? parseRobotOutput(input.outputXml) : []
  const hasOutputXml = tests.length > 0
  const t = tests[0]
  const elapsedMs = t?.elapsedMs
  const base = { screenshots, hasOutputXml, exitCode: input.exitCode, elapsedMs }

  if (input.canceled) return { ...base, status: "canceled", message: "Cancelado pelo usuário" }
  if (input.timedOut) return { ...base, status: "timeout", message: "Tempo limite do caso excedido" }
  if (input.deviceLost)
    return { ...base, status: "infra_error", message: "Celular caiu durante o caso", teardownMessage: t?.teardownMessage }

  if (input.exitCode === 252) {
    const err = /\[ ERROR \] (.*)/.exec(input.consoleText)?.[1]
    return { ...base, status: "config_error", message: err ?? "Robot não encontrou o caso (código 252)" }
  }

  if (t) {
    if (t.status === "PASS") return { ...base, status: "passed", message: t.message || undefined }
    const msg = t.message || "Falhou sem mensagem"
    const status = looksLikeInfra(msg) ? "infra_error" : "failed"
    return { ...base, status, message: msg, teardownMessage: t.teardownMessage }
  }

  if (looksLikeInfra(input.consoleText)) {
    return { ...base, status: "infra_error", message: lastLines(input.consoleText, 5) }
  }
  return {
    ...base,
    status: "failed",
    message: `Robot terminou sem output.xml (código ${input.exitCode ?? "?"})\n${lastLines(input.consoleText, 5)}`.trim(),
  }
}
