import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import WebSocket from "ws"

import { createSessionToken, SESSION_COOKIE } from "@/core/auth"
import { loadConfig } from "@/core/config"
import { ScreenStateSchema } from "@/core/screen-protocol"
import { readJson } from "@/core/store"
import { startScreenServer } from "@/screen/server"
import { fakeScreenSource } from "@/screen/source"

// Serviço de tela ao vivo com a fonte simulada: login, origem, celular válido, limite e controle.

const SECRET = "segredo-de-teste"
const PANEL = 3000
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function setup(max = 3) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qafarm-screen-"))
  const state = path.join(dir, "state")
  await fs.mkdir(state, { recursive: true })
  const dev = (serial: string, kind = "emulator", st = "ready") => ({
    serial,
    kind,
    adbState: "device",
    state: st,
    updatedAt: new Date().toISOString(),
  })
  await fs.writeFile(
    path.join(state, "devices.json"),
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      adbRaw: "",
      appiumReady: {},
      devices: [
        dev("emulator-5554"),
        dev("emulator-5556", "emulator", "busy"),
        dev("emulator-5558"),
        dev("browserstack:1", "cloud"),
      ],
    }),
  )
  await fs.writeFile(
    path.join(state, "settings.json"),
    JSON.stringify({ maxParallel: 0, maxScreenSessions: max }),
  )
  const cfg = loadConfig({
    HOME: dir,
    QAFARM_FAKE: "1",
    QAFARM_DATA_DIR: dir,
    QAFARM_SECRET: SECRET,
  } as unknown as NodeJS.ProcessEnv)
  const source = fakeScreenSource()
  const srv = await startScreenServer({
    cfg,
    source,
    port: 0,
    host: "127.0.0.1",
    panelPort: PANEL,
    log: () => undefined,
  })
  cleanups.push(async () => {
    await srv.close()
    await wait(100) // última gravação do estado
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  const token = await createSessionToken(SECRET)
  return { srv, source, dir, token }
}

type Opened = { ws: WebSocket; messages: string[]; binary: number }
function connect(
  port: number,
  device: string,
  opts: { token?: string; origin?: string } = {},
): Promise<Opened | { rejected: number } | { closed: number; reason: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?device=${encodeURIComponent(device)}`, {
      headers: {
        ...(opts.token ? { Cookie: `${SESSION_COOKIE}=${opts.token}` } : {}),
        Origin: opts.origin ?? `http://127.0.0.1:${PANEL}`,
      },
    })
    const o: Opened = { ws, messages: [], binary: 0 }
    ws.on("unexpected-response", (_req, res) => resolve({ rejected: res.statusCode ?? 0 }))
    ws.on("message", (d, isBinary) => {
      if (isBinary) o.binary++
      else {
        o.messages.push(d.toString())
        if (o.messages.length === 1) resolve(o)
      }
    })
    ws.on("close", (code, reason) => resolve({ closed: code, reason: reason.toString() }))
    ws.on("error", () => undefined)
  })
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("serviço de tela ao vivo", () => {
  it("sem login é recusado (401); origem de outro site ou outra porta, 403", async () => {
    // Arrange
    const { srv, token } = await setup()

    // Act
    const r = await Promise.all([
      connect(srv.port, "emulator-5554"),
      connect(srv.port, "emulator-5554", { token, origin: "http://site-malicioso.example" }),
      connect(srv.port, "emulator-5554", { token, origin: "http://127.0.0.1:8080" }),
    ])

    // Assert
    expect(r).toEqual([{ rejected: 401 }, { rejected: 403 }, { rejected: 403 }])
  })

  it("celular desconhecido ou da nuvem é recusado", async () => {
    // Arrange
    const { srv, token } = await setup()

    // Act
    const r = await Promise.all([
      connect(srv.port, "emulator-9999", { token }),
      connect(srv.port, "browserstack:1", { token }),
    ])

    // Assert
    expect(r.map((x) => ("closed" in x ? x.closed : x))).toEqual([4404, 4404])
  })

  it("logado: recebe o hello e a transmissão (vídeo simulado)", async () => {
    // Arrange
    const { srv, token } = await setup()

    // Act
    const o = (await connect(srv.port, "emulator-5556", { token })) as Opened
    await wait(700)

    // Assert
    const hello = JSON.parse(o.messages[0])
    expect([hello.t, hello.busy, hello.fake, o.binary > 0]).toEqual(["hello", true, true, true])
    o.ws.close()
  })

  it("limite 2: o 3º celular é recusado; outro espectador do mesmo celular entra; fechar libera a vaga", async () => {
    // Arrange
    const { srv, token, dir } = await setup(2)
    const a = (await connect(srv.port, "emulator-5554", { token })) as Opened
    const b = (await connect(srv.port, "emulator-5556", { token })) as Opened

    // Act
    const third = await connect(srv.port, "emulator-5558", { token })
    const sameA = (await connect(srv.port, "emulator-5554", { token })) as Opened
    await wait(150) // o estado é gravado logo depois de cada entrada
    const state = await readJson(path.join(dir, "state", "screen.json"), ScreenStateSchema.nullable(), null)
    b.ws.close()
    await wait(200)
    const afterFree = await connect(srv.port, "emulator-5558", { token })

    // Assert
    expect([
      "closed" in third ? third.closed : third,
      JSON.parse(sameA.messages[0]).t,
      state?.sessions.map((s) => [s.device, s.viewers]).sort(),
      "ws" in afterFree,
    ]).toEqual([
      4429,
      "hello",
      [
        ["emulator-5554", 2],
        ["emulator-5556", 1],
      ],
      true,
    ])
    for (const x of [a, sameA, afterFree]) if ("ws" in x) x.ws.close()
  })

  it("só quem liga 'Controlar' mexe no celular; os outros só assistem", async () => {
    // Arrange
    const { srv, token, source } = await setup()
    const v1 = (await connect(srv.port, "emulator-5554", { token })) as Opened
    const v2 = (await connect(srv.port, "emulator-5554", { token })) as Opened
    await wait(300)

    // Act
    v2.ws.send(JSON.stringify({ t: "key", key: "home" })) // sem controle: ignorado
    v1.ws.send(JSON.stringify({ t: "control", on: true }))
    await wait(100)
    v1.ws.send(JSON.stringify({ t: "key", key: "back" }))
    v1.ws.send(JSON.stringify({ t: "touch", action: "down", x: 0.5, y: 0.25 }))
    v1.ws.send(JSON.stringify({ t: "shell", cmd: "reboot" })) // fora do protocolo: ignorado
    await wait(200)

    // Assert
    expect(source.inputs).toEqual(["emulator-5554 key back", "emulator-5554 touch down 0.50,0.25"])
    v1.ws.close()
    v2.ws.close()
  })

  it("fechar a última tela apaga de novo o emulador parado; o que está em teste fica aceso", async () => {
    // Arrange
    const { srv, token, source } = await setup()
    const idle = (await connect(srv.port, "emulator-5554", { token })) as Opened
    const busy = (await connect(srv.port, "emulator-5556", { token })) as Opened
    await wait(200)

    // Act
    idle.ws.close()
    busy.ws.close()
    await wait(300)

    // Assert
    expect(source.inputs.filter((i) => i.endsWith("sleep"))).toEqual(["emulator-5554 sleep"])
  })
})
