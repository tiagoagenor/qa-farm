export interface AdbDevice {
  serial: string // normalizado: emuladores sempre como emulator-<porta console>
  rawSerials: string[]
  adbState: string // device | offline | unauthorized | ...
  kind: "emulator" | "physical"
  index?: number // 1..N para emuladores (farm-01..)
  consolePort?: number
  model?: string
}

export const EMULATOR_BASE_PORT = 5554

export function indexFromConsolePort(port: number): number {
  return (port - EMULATOR_BASE_PORT) / 2 + 1
}

export function consolePortFromIndex(index: number): number {
  return EMULATOR_BASE_PORT + 2 * (index - 1)
}

export function serialFromIndex(index: number): string {
  return `emulator-${consolePortFromIndex(index)}`
}

/** Porta console do emulador a partir do serial (emulator-5554 ou 127.0.0.1:5555). */
function consolePortOf(serial: string): number | undefined {
  const emu = /^emulator-(\d+)$/.exec(serial)
  if (emu) return Number(emu[1])
  const tcp = /^(?:127\.0\.0\.1|localhost):(\d+)$/.exec(serial)
  if (tcp) return Number(tcp[1]) - 1
  return undefined
}

const STATE_RANK: Record<string, number> = { device: 3, unauthorized: 2, offline: 1 }

/**
 * Lê `adb devices -l`. Um emulador pode aparecer duas vezes (emulator-5554 e 127.0.0.1:5555):
 * as duas linhas viram um único aparelho, com o melhor estado entre elas.
 */
export function parseAdbDevices(text: string): AdbDevice[] {
  const byKey = new Map<string, AdbDevice>()
  for (const line of text.split("\n")) {
    const m = /^(\S+)\s+(device|offline|unauthorized|no permissions|recovery|bootloader|sideload|authorizing|connecting)\b(.*)$/.exec(
      line.trim(),
    )
    if (!m || line.startsWith("List of devices")) continue
    const [, raw, state, rest] = m
    const model = /\bmodel:(\S+)/.exec(rest)?.[1]
    const port = consolePortOf(raw)
    const isEmu = port !== undefined && port >= EMULATOR_BASE_PORT && (port - EMULATOR_BASE_PORT) % 2 === 0
    const serial = isEmu ? `emulator-${port}` : raw
    const prev = byKey.get(serial)
    if (prev) {
      prev.rawSerials.push(raw)
      if ((STATE_RANK[state] ?? 0) > (STATE_RANK[prev.adbState] ?? 0)) prev.adbState = state
      prev.model ??= model
      continue
    }
    byKey.set(serial, {
      serial,
      rawSerials: [raw],
      adbState: state,
      kind: isEmu ? "emulator" : "physical",
      index: isEmu ? indexFromConsolePort(port) : undefined,
      consolePort: isEmu ? port : undefined,
      model,
    })
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "emulator" ? -1 : 1
    return (a.index ?? 0) - (b.index ?? 0) || a.serial.localeCompare(b.serial)
  })
}

/** Índices dos aparelhos físicos ativados começam aqui (não colidem com os emuladores 1..18). */
export const PHYSICAL_BASE_INDEX = 50

/** Próximo índice livre para um aparelho físico. */
export function nextPhysicalIndex(used: Iterable<number>): number {
  const taken = new Set(used)
  let i = PHYSICAL_BASE_INDEX + 1
  while (taken.has(i)) i++
  return i
}

/** Grupo de Appium do emulador: um servidor Appium atende `perGroup` celulares (1..5 → 1, 6..10 → 2...). */
export function appiumGroup(index: number, perGroup = 5): number {
  return Math.ceil(index / Math.max(1, perGroup))
}

/** Portas fixas por índice de emulador (o Appium é compartilhado pelo grupo). */
export function portsFor(index: number, appiumBase = 4800, perGroup = 5) {
  return {
    appium: appiumBase + appiumGroup(index, perGroup),
    system: 8200 + index,
    mjpeg: 9200 + index,
    chromedriver: 9600 + index,
  }
}
