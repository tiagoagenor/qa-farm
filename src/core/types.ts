import { z } from "zod"

// ---------------------------------------------------------------- apps ---
export const AppMetaSchema = z.object({
  id: z.string(),
  originalName: z.string(),
  package: z.string(),
  versionName: z.string(),
  versionCode: z.number().int(),
  minSdk: z.number().int(),
  abis: z.array(z.string()),
  launchableActivity: z.string(),
  md5: z.string(),
  size: z.number().int(),
  uploadedAt: z.string(),
})
export type AppMeta = z.infer<typeof AppMetaSchema>

// ------------------------------------------------------------- catalog ---
export const CatalogEntrySchema = z.object({
  id: z.string(), // "<arquivo relativo>::<nome do caso>"
  name: z.string(),
  fileLongName: z.string(), // "<SuíteDoArquivo>.<nome do caso>" (usado no --test)
  suite: z.string(),
  file: z.string(), // relativo à raiz do projeto Robot (ex.: scenarios/login/login.robot)
  folder: z.string(), // ex.: scenarios/login
  line: z.number().int(),
  tags: z.array(z.string()),
  accounts: z.array(z.string()),
  duplicate: z.boolean(),
})
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>

export const CatalogSchema = z.object({
  generatedAt: z.string(),
  snapshotHash: z.string(),
  total: z.number().int(),
  entries: z.array(CatalogEntrySchema),
})
export type Catalog = z.infer<typeof CatalogSchema>

// -------------------------------------------------------------- queues ---
export const ENVIRONMENTS = ["hml", "dev", "pre"] as const
export const EnvSchema = z.enum(ENVIRONMENTS)
export type Env = z.infer<typeof EnvSchema>

export const ITEM_STATUSES = [
  "queued",
  "running",
  "passed",
  "failed",
  "timeout",
  "infra_error",
  "config_error",
  "canceled",
] as const
export const ItemStatusSchema = z.enum(ITEM_STATUSES)
export type ItemStatus = z.infer<typeof ItemStatusSchema>

export const ATTEMPT_STATUSES = [
  "running",
  "passed",
  "failed",
  "timeout",
  "infra_error",
  "config_error",
  "canceled",
] as const
export const AttemptStatusSchema = z.enum(ATTEMPT_STATUSES)
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>

export const AttemptSchema = z.object({
  n: z.number().int(),
  serial: z.string(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  status: AttemptStatusSchema,
  message: z.string().optional(),
  teardownMessage: z.string().optional(),
  dir: z.string(), // relativo a runs/
  pgid: z.number().int().optional(),
  screenshots: z.array(z.string()).optional(),
})
export type Attempt = z.infer<typeof AttemptSchema>

export const ItemSchema = z.object({
  id: z.string(),
  testId: z.string(),
  name: z.string(),
  fileLongName: z.string(),
  file: z.string(),
  accounts: z.array(z.string()),
  status: ItemStatusSchema,
  infraRequeues: z.number().int(),
  failRetries: z.number().int(),
  attempts: z.array(AttemptSchema),
})
export type Item = z.infer<typeof ItemSchema>

export const QUEUE_STATUSES = ["running", "paused", "canceled", "done"] as const
export const QueueStatusSchema = z.enum(QUEUE_STATUSES)
export type QueueStatus = z.infer<typeof QueueStatusSchema>

export const QueueOptionsSchema = z.object({
  timeoutSec: z.number().int().min(10).max(24 * 3600),
  retries: z.number().int().min(0).max(5),
})
export type QueueOptions = z.infer<typeof QueueOptionsSchema>

export const QueueSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  appId: z.string(),
  env: EnvSchema,
  status: QueueStatusSchema,
  options: QueueOptionsSchema,
  snapshotHash: z.string().optional(),
  items: z.array(ItemSchema),
})
export type Queue = z.infer<typeof QueueSchema>

// ------------------------------------------------------------- devices ---
export const DEVICE_STATES = [
  "offline",
  "booting",
  "installing",
  "ready",
  "busy",
  "maintenance",
  "external",
] as const
export const DeviceStateSchema = z.enum(DEVICE_STATES)
export type DeviceState = z.infer<typeof DeviceStateSchema>

export const DeviceSchema = z.object({
  serial: z.string(),
  kind: z.enum(["emulator", "physical"]),
  adbState: z.string(),
  index: z.number().int().optional(),
  name: z.string().optional(),
  model: z.string().optional(),
  state: DeviceStateSchema,
  appVersionCode: z.number().int().optional(),
  currentQueueId: z.string().optional(),
  currentItemId: z.string().optional(),
  currentTestName: z.string().optional(),
  qemuPid: z.number().int().optional(),
  note: z.string().optional(),
  updatedAt: z.string(),
})
export type Device = z.infer<typeof DeviceSchema>

export const DevicesStateSchema = z.object({
  updatedAt: z.string(),
  devices: z.array(DeviceSchema),
  adbRaw: z.string(),
  appiumReady: z.record(z.string(), z.boolean()),
})
export type DevicesState = z.infer<typeof DevicesStateSchema>

export const RunnerStateSchema = z.object({
  pid: z.number().int(),
  startedAt: z.string(),
  heartbeatAt: z.string(),
  fake: z.boolean(),
  activeAppId: z.string().optional(),
  pgids: z.array(z.number().int()),
  farmJob: z.object({ command: z.string(), startedAt: z.string() }).optional(),
  catalogStatus: z.enum(["missing", "building", "ready", "error"]),
  catalogError: z.string().optional(),
})
export type RunnerState = z.infer<typeof RunnerStateSchema>

export const DesiredSchema = z.object({ devices: z.number().int().min(0).max(18) })
export type Desired = z.infer<typeof DesiredSchema>

// ------------------------------------------------------------ commands ---
export const CreateQueueInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  appId: z.string().min(1),
  env: EnvSchema,
  timeoutSec: z.number().int().min(10).max(24 * 3600),
  retries: z.number().int().min(0).max(5),
  testIds: z.array(z.string()).min(1).max(5000),
})
export type CreateQueueInput = z.infer<typeof CreateQueueInputSchema>

export const CommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_queue"), input: CreateQueueInputSchema }),
  z.object({ type: z.literal("pause_queue"), queueId: z.string() }),
  z.object({ type: z.literal("resume_queue"), queueId: z.string() }),
  z.object({ type: z.literal("cancel_queue"), queueId: z.string() }),
  z.object({ type: z.literal("rerun_failed"), queueId: z.string() }),
  z.object({ type: z.literal("start_devices"), count: z.number().int().min(1).max(18) }),
  z.object({ type: z.literal("stop_all_devices") }),
  z.object({ type: z.literal("restart_device"), serial: z.string() }),
  z.object({ type: z.literal("restart_appiums") }),
  z.object({ type: z.literal("delete_app"), appId: z.string() }),
  z.object({ type: z.literal("refresh_catalog") }),
])
export type Command = z.infer<typeof CommandSchema>
export type CommandType = Command["type"]

export const CommandEnvelopeSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  command: CommandSchema,
})
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>

export const CommandResultSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  processedAt: z.string(),
  command: CommandSchema,
  ok: z.boolean(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
})
export type CommandResult = z.infer<typeof CommandResultSchema>

// --------------------------------------------------------------- result ---
export const RunResultSchema = z.object({
  status: AttemptStatusSchema,
  message: z.string().optional(),
  teardownMessage: z.string().optional(),
  elapsedMs: z.number().optional(),
  exitCode: z.number().nullable().optional(),
  screenshots: z.array(z.string()),
  hasOutputXml: z.boolean(),
})
export type RunResult = z.infer<typeof RunResultSchema>
