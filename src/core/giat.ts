import { z } from "zod"

// GI-App-Test: runner de testes Appium separado (projeto QA_Automacao_TESTE). A fazenda só reserva celulares
// para ele e dispara `node run.mjs` num ambiente limpo; nada do GI-App-Test entra no fluxo das filas.

export const GIAT_ENVS = ["HML", "PROD", "MOCK"] as const
export const GiatEnvSchema = z.enum(GIAT_ENVS)

export const GIAT_RUN_STATUSES = ["installing", "running", "passed", "failed", "error", "canceled"] as const
export type GiatRunStatus = (typeof GIAT_RUN_STATUSES)[number]

export const GiatRunSchema = z.object({
  id: z.string(),
  serial: z.string(),
  test: z.string(),
  env: GiatEnvSchema,
  status: z.enum(GIAT_RUN_STATUSES),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  message: z.string().optional(),
  summary: z.object({ total: z.number(), passed: z.number(), failed: z.number() }).optional(),
  /** arquivos guardados na pasta da execução (log, JSON, prints) */
  files: z.array(z.string()).default([]),
  pgid: z.number().int().optional(),
})
export type GiatRun = z.infer<typeof GiatRunSchema>

export const GiatStateSchema = z.object({
  reservations: z.record(z.string(), z.object({ since: z.string() })).default({}),
  runs: z.array(GiatRunSchema).default([]),
})
export type GiatState = z.infer<typeof GiatStateSchema>

export const GIAT_MAX_RUNS = 100
export const GIAT_APPIUM_PORT = 4723

/** Caso válido: caminho relativo a tests/, terminando em .mjs, sem "..", fora de tests/flows/. */
export function validGiatTest(test: string): boolean {
  if (!/^[\w][\w./-]*\.mjs$/.test(test)) return false
  const parts = test.split("/")
  if (parts.some((s) => s === ".." || s === "." || s === "")) return false
  return parts[0] !== "flows"
}

/** Código de saída do run.mjs → status da execução. */
export function giatStatusFromExit(code: number | null): { status: GiatRunStatus; message?: string } {
  switch (code) {
    case 0:
      return { status: "passed" }
    case 1:
      return { status: "failed" }
    case 2:
      return { status: "error", message: "Uso inválido (celular fora da reserva ou caso inexistente)" }
    case 3:
      return { status: "error", message: "Infraestrutura (Appium fora do ar, celular ausente ou sem porta livre)" }
    case 130:
    case 143:
      return { status: "canceled", message: "Cancelado" }
    default:
      return { status: "error", message: `Saiu com código ${code ?? "desconhecido"}` }
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
 * Ambiente LIMPO do processo do GI-App-Test: nada herdado da fazenda (o runner dele lê DEVICE_SERIAL,
 * APPIUM_URL, APP_ENV, SYSTEM_PORT…). Os segredos vêm do .env.server dele; o serial permitido é sempre o reservado.
 */
export function giatEnv(o: {
  nodeBin: string
  sdkRoot: string
  javaHome: string
  home: string
  tmpDir: string
  serials: string[]
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
    GIAT_ALLOWED_DEVICES: o.serials.join(","),
  }
}
