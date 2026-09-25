import { z } from "zod"

// Máquinas "worker" que estendem a fazenda (o server01 é o mestre). Funções puras + schemas.
//
// Identidade dos celulares em todo o runner:
// - local (mestre): serial puro ("emulator-5554") e índice local (1..18, físicos 51+) — como sempre foi
// - remoto: serial "server02:emulator-5554" e índice global = 100 × slot + índice local (farm-03 do slot 1 = 103)
//   → nenhuma colisão de serial, índice, manutenção ou porta entre máquinas.

export const MACHINE_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/
export const SLOT_BASE = 100
export const MAX_SLOTS = 20
export const AGENT_PORT = 7100

export const MachineSchema = z.object({
  id: z.string().regex(MACHINE_ID_RE),
  name: z.string().min(1).max(60),
  host: z.string().min(1).max(255),
  sshUser: z.string().min(1).max(64),
  sshPort: z.number().int().min(1).max(65535),
  /** 1..20 — define o índice global dos celulares e as portas locais do túnel */
  slot: z.number().int().min(1).max(MAX_SLOTS),
  maxDevices: z.number().int().min(1).max(18),
  enabled: z.boolean(),
  /** token do agente: nunca vai para o navegador */
  token: z.string().min(16),
  /** ssh = túnel aberto pelo mestre; direct = URL direta (modo fake/testes) */
  transport: z.enum(["ssh", "direct"]),
  directUrl: z.string().optional(),
  /** o robot dos casos nos celulares desta máquina roda nela mesma (tira carga do mestre) */
  runRobot: z.boolean().default(false),
  createdAt: z.string(),
})
export type Machine = z.infer<typeof MachineSchema>

export const MachinesFileSchema = z.object({ machines: z.array(MachineSchema) })

export const MACHINE_STATES = ["pending", "connecting", "online", "degraded", "offline", "incompatible", "draining", "disabled"] as const
export type MachineState = (typeof MACHINE_STATES)[number]

export const MachineStatusSchema = z.object({
  id: z.string(),
  state: z.enum(MACHINE_STATES),
  lastSeenAt: z.string().optional(),
  lastError: z.string().optional(),
  agentVersion: z.string().optional(),
  agentCommit: z.string().optional(),
  protocol: z.number().optional(),
  bootId: z.string().optional(),
  clockSkewMs: z.number().optional(),
  tunnel: z.enum(["up", "down", "starting", "direct"]),
  desired: z.number().int(),
  emulators: z.number().int(),
  farmJob: z.object({ command: z.string(), startedAt: z.string() }).optional(),
  versions: z.object({ emulator: z.string().optional(), appium: z.string().optional() }).optional(),
  /** venv do robot instalado no worker */
  robotReady: z.boolean().optional(),
  /** robots rodando agora no worker */
  robotRuns: z.number().int().optional(),
})
export type MachineStatus = z.infer<typeof MachineStatusSchema>
export const MachinesStatusFileSchema = z.object({ updatedAt: z.string(), machines: z.array(MachineStatusSchema) })

/** Chave global do celular: local = serial puro; remoto = "máquina:serial". */
export function deviceKey(machineId: string | undefined, serial: string): string {
  return machineId ? `${machineId}:${serial}` : serial
}

/** Separa a chave pelo PRIMEIRO ":" (id de máquina não tem ":", serial TCP pode ter "127.0.0.1:5555"). */
export function parseDeviceKey(key: string, knownMachines: ReadonlySet<string>): { machineId?: string; serial: string } {
  const i = key.indexOf(":")
  if (i > 0) {
    const id = key.slice(0, i)
    if (knownMachines.has(id)) return { machineId: id, serial: key.slice(i + 1) }
  }
  return { serial: key }
}

export function globalIndex(slot: number, localIndex: number): number {
  return slot * SLOT_BASE + localIndex
}

/** Índice global → slot (0 = mestre) e índice local. */
export function splitIndex(index: number): { slot: number; local: number } {
  if (index < SLOT_BASE) return { slot: 0, local: index }
  return { slot: Math.floor(index / SLOT_BASE), local: index % SLOT_BASE }
}

/** Portas no MESTRE (lado local do túnel): agente e Appiums do grupo g (1, 2, …). */
export function localPorts(slot: number): { agent: number; appium: (group: number) => number } {
  const base = 20_000 + 100 * slot
  return { agent: base, appium: (g) => base + g }
}

export function appiumGroups(maxDevices: number, perGroup: number): number {
  return Math.max(1, Math.ceil(maxDevices / Math.max(1, perGroup)))
}

/** Quantos casos novos cabem na máquina agora (memória + freio de saúde + estado da máquina). */
export function dispatchBudget(
  m: { online: boolean; memAvailableMb: number | null; brake: boolean },
  cfg: { minFreeMemMb: number; caseMemMb: number },
): number {
  if (!m.online || m.brake || m.memAvailableMb === null) return 0
  return Math.max(0, Math.floor((m.memAvailableMb - cfg.minFreeMemMb) / Math.max(1, cfg.caseMemMb)) + 1)
}

/** Próximo slot livre (1..20). */
export function nextSlot(used: Iterable<number>): number | null {
  const taken = new Set(used)
  for (let s = 1; s <= MAX_SLOTS; s++) if (!taken.has(s)) return s
  return null
}

/** Intercala os celulares livres por máquina (um de cada, na ordem dada), para espalhar a carga. */
export function interleaveByMachine<T extends { machineId?: string }>(items: T[]): T[] {
  const groups = new Map<string, T[]>()
  for (const it of items) {
    const k = it.machineId ?? ""
    groups.set(k, [...(groups.get(k) ?? []), it])
  }
  const out: T[] = []
  const lists = [...groups.values()]
  for (let i = 0; out.length < items.length; i++) for (const l of lists) if (l[i]) out.push(l[i])
  return out
}
