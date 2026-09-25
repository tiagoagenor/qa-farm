import { z } from "zod"

import { HistoryPointSchema, HostSampleSchema } from "./metrics"

// Protocolo mestre ↔ agente (worker). O mestre sempre inicia (pull); o agente só escuta em 127.0.0.1
// e todas as chamadas levam "Authorization: Bearer <token>" e "X-QAFarm-Protocol".

export const AGENT_PROTOCOL = 1
export const PROTOCOL_HEADER = "x-qafarm-protocol"

export const FarmOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), count: z.number().int().min(1).max(18) }),
  z.object({ kind: z.literal("startOne"), index: z.number().int().min(1).max(99) }),
  z.object({ kind: z.literal("stopOne"), index: z.number().int().min(1).max(99) }),
  z.object({ kind: z.literal("stopAll") }),
])

export const AgentHealthSchema = z.object({
  protocol: z.number(),
  agentVersion: z.string(),
  commit: z.string(),
  hostname: z.string(),
  bootId: z.string(),
  startedAt: z.string(),
  now: z.string(),
})
export type AgentHealth = z.infer<typeof AgentHealthSchema>

export const AgentStateSchema = z.object({
  protocol: z.number(),
  bootId: z.string(),
  now: z.string(),
  /** saída de `adb devices -l` do worker */
  adbRaw: z.string(),
  /** índice LOCAL do emulador → pid do qemu */
  qemuPids: z.record(z.string(), z.number()),
  farmJob: z.object({ opId: z.string(), command: z.string(), startedAt: z.string() }).nullable(),
  apks: z.array(z.string()),
  metrics: HostSampleSchema.nullable(),
  versions: z.object({ emulator: z.string().optional(), appium: z.string().optional() }),
})
export type AgentState = z.infer<typeof AgentStateSchema>

export const AgentMetricsSchema = z.object({ points: z.array(HistoryPointSchema) })

export const FarmOpRequestSchema = z.object({ opId: z.string().min(1).max(80), op: FarmOpSchema })
export const FarmOpStatusSchema = z.object({ opId: z.string(), state: z.enum(["running", "ok", "failed"]), code: z.number().nullable() })

export const InstallRequestSchema = z.object({
  apkMd5: z.string().regex(/^[a-f0-9]{32}$/),
  package: z.string().min(1),
  versionCode: z.number().int(),
  allowUninstall: z.boolean(),
})

/** Ações permitidas no celular (lista branca). */
export const DeviceActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("closeSystemDialogs") }),
  z.object({ action: z.literal("disableLockscreen") }),
  z.object({ action: z.literal("forceStop"), package: z.string().min(1) }),
  z.object({ action: z.literal("keyevent"), key: z.enum(["HOME", "SLEEP", "WAKEUP"]) }),
  z.object({ action: z.literal("putGlobalSetting"), key: z.enum(["hide_error_dialogs"]), value: z.string().max(10) }),
])
export type DeviceAction = z.infer<typeof DeviceActionSchema>
