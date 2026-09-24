import type { Attempt, CatalogEntry, Item, Queue } from "@/core/types"

let seq = 0

export function item(id: string, accounts: string[] = [], over: Partial<Item> = {}): Item {
  return {
    id,
    testId: `scenarios/x.robot::${id}`,
    name: id,
    fileLongName: `X.${id}`,
    file: "scenarios/x.robot",
    accounts,
    status: "queued",
    infraRequeues: 0,
    failRetries: 0,
    attempts: [],
    ...over,
  }
}

export function attempt(over: Partial<Attempt> = {}): Attempt {
  return {
    n: 1,
    serial: "emulator-5554",
    startedAt: "2026-09-24T10:00:00.000Z",
    status: "running",
    dir: "q/i/a1",
    ...over,
  }
}

export function queue(items: Item[], over: Partial<Queue> = {}): Queue {
  seq += 1
  return {
    id: over.id ?? `queue_20260924-10000${seq % 10}_00000${seq % 10}`,
    name: "fila",
    createdAt: over.createdAt ?? `2026-09-24T10:00:0${seq % 10}.000Z`,
    appId: "app_20260924-100000_aaaaaa",
    env: "hml",
    status: "running",
    options: { timeoutSec: 900, retries: 0 },
    items,
    ...over,
  }
}

export function device(serial: string, index?: number) {
  const port = Number(serial.replace("emulator-", ""))
  return { serial, index: index ?? (port - 5554) / 2 + 1 }
}

export function entry(name: string, over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: `scenarios/login/login.robot::${name}`,
    name,
    fileLongName: `Login.${name}`,
    suite: "Login",
    file: "scenarios/login/login.robot",
    folder: "scenarios/login",
    line: 10,
    tags: ["regressivo"],
    accounts: [],
    duplicate: false,
    ...over,
  }
}
