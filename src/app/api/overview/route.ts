import { devicesState, listQueues, runnerStatus } from "@/server/web/data"
import { json, noStore } from "@/server/web/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const [runner, devices, queues] = await Promise.all([runnerStatus(), devicesState(), listQueues()])
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
    },
    noStore,
  )
}
