import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

import { readJson, writeJsonAtomic } from "@/core/store"

// "Mundo" simulado do modo FAKE (QAFARM_FAKE=1): celulares e apps instalados, num arquivo JSON,
// compartilhado entre o runner (que liga/desliga/instala) e a web (que tira print).

const FakeDeviceSchema = z.object({
  serial: z.string(),
  kind: z.enum(["emulator", "physical"]),
  adbState: z.string(),
  bootAt: z.number(),
  pid: z.number().optional(),
  installed: z.record(z.string(), z.number()),
})
export type FakeDevice = z.infer<typeof FakeDeviceSchema>

const WorldSchema = z.object({
  bootDelayMs: z.number(),
  installDelayMs: z.number(),
  devices: z.array(FakeDeviceSchema),
})
export type World = z.infer<typeof WorldSchema>

export const ScenarioSchema = z.object({
  bootDelayMs: z.number().default(800),
  installDelayMs: z.number().default(300),
  physical: z.array(z.object({ serial: z.string(), adbState: z.string().default("device") })).default([]),
  emulators: z.number().int().default(0),
})

const DEFAULT_WORLD: World = { bootDelayMs: 800, installDelayMs: 300, devices: [] }

export function worldPath(dataDir: string): string {
  return path.join(dataDir, "fake", "world.json")
}

let chain: Promise<unknown> = Promise.resolve()

/** Lê o mundo fake (cria a partir do cenário na primeira vez). */
export async function readWorld(dataDir: string, scenarioFile?: string): Promise<World> {
  const file = worldPath(dataDir)
  try {
    await fs.access(file)
  } catch {
    let scenario = ScenarioSchema.parse({})
    if (scenarioFile) {
      try {
        scenario = ScenarioSchema.parse(JSON.parse(await fs.readFile(scenarioFile, "utf8")))
      } catch {
        /* usa o padrão */
      }
    }
    const now = Date.now()
    const world: World = {
      bootDelayMs: scenario.bootDelayMs,
      installDelayMs: scenario.installDelayMs,
      devices: [
        ...Array.from({ length: scenario.emulators }, (_, k) => ({
          serial: `emulator-${5554 + 2 * k}`,
          kind: "emulator" as const,
          adbState: "device",
          bootAt: now,
          pid: 200000 + k + 1,
          installed: {},
        })),
        ...scenario.physical.map((p) => ({
          serial: p.serial,
          kind: "physical" as const,
          adbState: p.adbState,
          bootAt: 0,
          installed: {},
        })),
      ],
    }
    await writeJsonAtomic(file, world)
    return world
  }
  return readJson(file, WorldSchema, DEFAULT_WORLD)
}

/** Altera o mundo de forma serializada (um processo por vez dentro deste processo). */
export function updateWorld(dataDir: string, fn: (w: World) => World | void): Promise<World> {
  const next = chain.then(async () => {
    const w = await readWorld(dataDir)
    const out = fn(w) ?? w
    await writeJsonAtomic(worldPath(dataDir), out)
    return out
  })
  chain = next.catch(() => undefined)
  return next
}

export function fakeAdbDevicesText(w: World): string {
  const lines = w.devices.map((d) =>
    d.kind === "emulator"
      ? `${d.serial}          ${d.adbState} product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1`
      : `${d.serial}            ${d.adbState} usb:1-3 product:fake model:Fisico_Fake device:fake transport_id:2`,
  )
  return ["List of devices attached", ...lines, ""].join("\n")
}

// PNG 1x1 cinza (placeholder de print no modo fake)
export const FAKE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
)
