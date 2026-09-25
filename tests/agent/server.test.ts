import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { startAgent } from "@/agent/server"
import { AGENT_PROTOCOL, PROTOCOL_HEADER } from "@/core/agent-protocol"
import { loadConfig } from "@/core/config"
import { createAdapters } from "@/server/adapters"
import { agentClient, fileMd5 } from "@/server/remote/agent-client"

const REPO = path.resolve(__dirname, "../..")
const TOKEN = "t".repeat(32)

let stop: (() => Promise<void>) | null = null
afterEach(async () => {
  await stop?.()
  stop = null
})

async function agent(emulators = 2) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qafarm-agent-"))
  const scenario = path.join(dir, "scenario.json")
  await fs.writeFile(scenario, JSON.stringify({ emulators, bootDelayMs: 0, installDelayMs: 0 }))
  const cfg = loadConfig({
    HOME: dir,
    QAFARM_FAKE: "1",
    QAFARM_DATA_DIR: path.join(dir, "data"),
    QAFARM_REPO_ROOT: REPO,
    QAFARM_FAKE_SCENARIO: scenario,
    QAFARM_METRICS_INTERVAL_MS: "500",
  } as unknown as NodeJS.ProcessEnv)
  const a = await startAgent({ cfg, ad: createAdapters(cfg), token: TOKEN, port: 0, version: "t", commit: "abc", apkDir: path.join(dir, "apks"), log: () => undefined })
  stop = a.close
  return { url: a.url, dir, client: agentClient(a.url, TOKEN) }
}

describe("agente do worker", () => {
  it("sem token responde 401", async () => {
    // Arrange
    const { url } = await agent()

    // Act
    const r = await fetch(`${url}/v1/health`, { headers: { [PROTOCOL_HEADER]: String(AGENT_PROTOCOL) } })

    // Assert
    expect(r.status).toBe(401)
  })

  it("protocolo diferente responde 409", async () => {
    // Arrange
    const { url } = await agent()

    // Act
    const r = await fetch(`${url}/v1/health`, { headers: { Authorization: `Bearer ${TOKEN}`, [PROTOCOL_HEADER]: "99" } })

    // Assert
    expect(r.status).toBe(409)
  })

  it("health e state trazem protocolo, celulares do worker e métricas", async () => {
    // Arrange
    const { client } = await agent(2)

    // Act
    const [h, s] = [await client.health(), await client.state()]

    // Assert
    expect([h.protocol, h.commit, s.adbRaw.match(/emulator-\d+/g), s.metrics?.memTotalMb]).toEqual([
      AGENT_PROTOCOL,
      "abc",
      ["emulator-5554", "emulator-5556"],
      64_000,
    ])
  })

  it("celular que não existe no worker responde 404", async () => {
    // Arrange
    const { client } = await agent(1)

    // Act
    const err = await client.bootCompleted("emulator-5600").catch((e) => e)

    // Assert
    expect(err.status).toBe(404)
  })

  it("ação fora da lista branca é recusada com 400", async () => {
    // Arrange
    const { url } = await agent(1)

    // Act
    const r = await fetch(`${url}/v1/devices/emulator-5554/actions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, [PROTOCOL_HEADER]: String(AGENT_PROTOCOL), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "shell", cmd: "rm -rf /" }),
    })

    // Assert
    expect(r.status).toBe(400)
  })

  it("operação da fazenda é idempotente pelo opId", async () => {
    // Arrange
    const { client } = await agent(0)

    // Act
    await client.farmOp("op-1", { kind: "start", count: 2 })
    await client.farmOp("op-1", { kind: "start", count: 2 })
    let st = await client.farmOpStatus("op-1")
    for (let i = 0; i < 50 && st.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50))
      st = await client.farmOpStatus("op-1")
    }

    // Assert
    const s = await client.state()
    expect([st.state, s.adbRaw.match(/emulator-\d+/g)?.length]).toEqual(["ok", 2])
  })

  it("APK com md5 errado é recusado; envio certo acontece uma vez e a instalação usa o cache", async () => {
    // Arrange
    const { client, url, dir } = await agent(1)
    const apk = path.join(dir, "app.apk")
    await fs.writeFile(apk, "PK-conteudo-do-apk")
    const md5 = await fileMd5(apk)
    const bad = await fetch(`${url}/v1/apks/${"0".repeat(32)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, [PROTOCOL_HEADER]: String(AGENT_PROTOCOL) },
      body: "outra coisa",
    })

    // Act
    const [a, b] = await Promise.all([client.ensureApk(apk), client.ensureApk(apk)])
    const out = await client.install("emulator-5554", md5, "com.exemplo.App.hml", 5528, true)

    // Assert
    const s = await client.state()
    expect([bad.status, a, b, out.ok, s.apks, await client.versionCode("emulator-5554", "com.exemplo.App.hml")]).toEqual([
      400,
      md5,
      md5,
      true,
      [md5],
      5528,
    ])
  })

  it("histórico de métricas filtra pelo 'since'", async () => {
    // Arrange
    const { client } = await agent(1)
    await new Promise((r) => setTimeout(r, 3200))

    // Act
    const all = await client.metrics()
    const none = await client.metrics(new Date(Date.now() + 60_000).toISOString())

    // Assert
    expect([all.length > 0, none.length]).toEqual([true, 0])
  })
})
