import { devicesState, listQueues, readMetrics, runnerStatus } from "@/server/web/data"
import { json, noStore } from "@/server/web/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const [runner, devices, queues, metrics] = await Promise.all([runnerStatus(), devicesState(), listQueues(), readMetrics()])
  const levels = metrics.machines.map((m) => (m.ageMs !== null && m.ageMs > 15_000 ? "warn" : m.health.level))
  const emulators = devices.devices.filter((d) => d.kind === "emulator")
  return json(
    {
      runner: { alive: runner.alive, ageMs: runner.ageMs, fake: runner.state?.fake ?? false, catalogStatus: runner.state?.catalogStatus ?? "missing", catalogError: runner.state?.catalogError ?? null, farmJob: runner.state?.farmJob ?? null },
      devices: {
        total: devices.devices.length,
        emulators: emulators.length,
        ready: emulators.filter((d) => d.state === "ready").length,
        busy: emulators.filter((d) => d.state === "busy").length,
        desired: devices.desired,
      },
      activeQueues: queues.filter((q) => q.status === "running" || q.status === "paused").length,
      health: levels.includes("crit") ? "crit" : levels.includes("warn") ? "warn" : "ok",
    },
    noStore,
  )
}
