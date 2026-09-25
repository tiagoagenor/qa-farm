import path from "node:path"

/** Layout de pastas dentro do diretório de dados (~/qa-farm-data). */
export function dataPaths(dataDir: string) {
  return {
    root: dataDir,
    apps: path.join(dataDir, "apps"),
    app: (appId: string) => path.join(dataDir, "apps", appId),
    appApk: (appId: string) => path.join(dataDir, "apps", appId, "app.apk"),
    appMeta: (appId: string) => path.join(dataDir, "apps", appId, "meta.json"),
    uploads: path.join(dataDir, "uploads"),
    catalog: path.join(dataDir, "catalog", "catalog.json"),
    queues: path.join(dataDir, "queues"),
    queue: (queueId: string) => path.join(dataDir, "queues", `${queueId}.json`),
    runs: path.join(dataDir, "runs"),
    attemptDir: (queueId: string, itemId: string, n: number) =>
      path.join(dataDir, "runs", queueId, itemId, `a${n}`),
    workspaces: path.join(dataDir, "workspaces"),
    commands: path.join(dataDir, "commands"),
    command: (id: string) => path.join(dataDir, "commands", `${id}.json`),
    commandsDone: path.join(dataDir, "commands", "done"),
    commandDone: (id: string) => path.join(dataDir, "commands", "done", `${id}.json`),
    state: path.join(dataDir, "state"),
    devicesState: path.join(dataDir, "state", "devices.json"),
    runnerState: path.join(dataDir, "state", "runner.json"),
    desired: path.join(dataDir, "state", "desired.json"),
    physical: path.join(dataDir, "state", "physical.json"),
    emulatorsDisabled: path.join(dataDir, "state", "emulators-disabled.json"),
    metrics: path.join(dataDir, "state", "metrics.json"),
    settings: path.join(dataDir, "state", "settings.json"),
    browserstack: path.join(dataDir, "state", "browserstack.json"),
    browserstackApps: path.join(dataDir, "state", "browserstack-apps.json"),
    browserstackStatus: path.join(dataDir, "state", "browserstack-status.json"),
    machines: path.join(dataDir, "state", "machines.json"),
    machinesStatus: path.join(dataDir, "state", "machines-status.json"),
    runnerLock: path.join(dataDir, "state", "runner.lock"),
    logs: path.join(dataDir, "logs"),
    appiumLog: (serial: string) => path.join(dataDir, "logs", `appium-${serial}.log`),
  }
}
export type DataPaths = ReturnType<typeof dataPaths>

/**
 * Junta segmentos (vindos de URL) a uma base, garantindo que o resultado fica dentro da base.
 * Retorna null para qualquer tentativa de sair da pasta (.., caminho absoluto, byte nulo).
 */
export function safeJoin(base: string, segments: string[]): string | null {
  const decoded: string[] = []
  for (const raw of segments) {
    let seg: string
    try {
      seg = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (seg === "" || seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\") || seg.includes("\0")) {
      return null
    }
    decoded.push(seg)
  }
  const root = path.resolve(base)
  const full = path.resolve(root, ...decoded)
  if (full !== root && !full.startsWith(root + path.sep)) return null
  return full
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
}

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"
}
