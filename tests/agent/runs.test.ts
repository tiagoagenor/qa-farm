import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { RunManager } from "@/agent/runs"
import { startAgent } from "@/agent/server"
import { RUN_OUT, RUN_REPO } from "@/core/agent-protocol"
import { loadConfig } from "@/core/config"
import { createAdapters } from "@/server/adapters"
import { agentClient } from "@/server/remote/agent-client"

const REPO = path.resolve(__dirname, "../..")
const PROJECT = path.join(REPO, "tests/fixtures/fake-project")
const TOKEN = "t".repeat(32)
const WS = "abc12345def"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function env(speed = "0.1") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qafarm-runs-"))
  const cfg = loadConfig({
    HOME: dir,
    QAFARM_FAKE: "1",
    QAFARM_FAKE_SPEED: speed,
    QAFARM_DATA_DIR: path.join(dir, "data"),
    QAFARM_REPO_ROOT: REPO,
    QAFARM_METRICS_INTERVAL_MS: "500",
  } as unknown as NodeJS.ProcessEnv)
  return { dir, cfg, ad: createAdapters(cfg) }
}

async function agent(speed?: string) {
  const e = await env(speed)
  const a = await startAgent({
    cfg: e.cfg,
    ad: e.ad,
    token: TOKEN,
    port: 0,
    version: "t",
    commit: "abc",
    apkDir: path.join(e.dir, "apks"),
    log: () => undefined,
  })
  cleanups.push(a.close)
  return { ...e, client: agentClient(a.url, TOKEN) }
}

const request = (runId: string, test: string) => ({
  runId,
  workspace: WS,
  args: [
    "--test",
    test,
    "--outputdir",
    RUN_OUT,
    "--listener",
    `${RUN_REPO}/scripts/robot/qafarm_listener.py`,
    "suite.robot",
  ],
  env: { QAFARM_SERIAL: "emulator-5554", AMBIENTE: "hml", LD_PRELOAD: "/tmp/x.so" },
  appiumIndex: 1,
})

async function waitExited(client: ReturnType<typeof agentClient>, runId: string) {
  for (let i = 0; i < 200; i++) {
    const st = await client.runStatus(runId)
    if (st?.state === "exited") return st
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error("robot não terminou")
}

describe("robot no worker (agente)", () => {
  it("recebe o projeto, roda o caso e expõe console e artefatos; apagar limpa tudo", async () => {
    // Arrange
    const { client, cfg, ad } = await agent()
    await client.ensureWorkspace(WS, PROJECT)

    // Act
    await client.runStart(request("q1__i1__1", "Suite.CT_LOGIN_01-Caso-PASS"))
    const st = await waitExited(client, "q1__i1__1")
    const files = (await client.runFiles("q1__i1__1")).map((f) => f.name).sort()
    const consoleText = (await client.runFile("q1__i1__1", "console.log")).toString()
    const session = JSON.parse((await client.runFile("q1__i1__1", "session.json")).toString())
    await client.runDelete("q1__i1__1")

    // Assert
    expect([
      st.code,
      ["console.log", "log.html", "output.xml", "session.json"].every((f) => files.includes(f)),
      consoleText.includes("passo 3/3"),
      session.url,
      await client.runStatus("q1__i1__1"),
      await fs.readdir(path.join(cfg.dataDir, "runs")),
    ]).toEqual([0, true, true, ad.appium.url(1), null, []])
  })

  it("console ao vivo por offset devolve só o que falta", async () => {
    // Arrange
    const { client } = await agent()
    await client.ensureWorkspace(WS, PROJECT)
    await client.runStart(request("q1__i2__1", "Suite.CT_LOGIN_01-Caso-PASS"))
    await waitExited(client, "q1__i2__1")
    const full = await client.runFile("q1__i2__1", "console.log")

    // Act
    const tail = await client.runFile("q1__i2__1", "console.log", full.length - 10)
    const none = await client.runFile("q1__i2__1", "console.log", full.length)

    // Assert
    expect([tail.toString(), none.length]).toEqual([full.subarray(full.length - 10).toString(), 0])
  })

  it("sem o projeto no worker, recusa iniciar", async () => {
    // Arrange
    const { client } = await agent()

    // Act
    const err = await client
      .runStart(request("q1__i3__1", "Suite.CT_LOGIN_01-Caso-PASS"))
      .catch((e: Error) => e.message)

    // Assert
    expect(err).toContain("snapshot do projeto não está neste worker")
  })

  it("arquivo fora da pasta da execução não é servido", async () => {
    // Arrange
    const { client } = await agent()
    await client.ensureWorkspace(WS, PROJECT)
    await client.runStart(request("q1__i4__1", "Suite.CT_LOGIN_01-Caso-PASS"))
    await waitExited(client, "q1__i4__1")

    // Act
    const out = await Promise.all(
      ["../../.env", "/etc/passwd", ".meta.json"].map((n) =>
        client.runFile("q1__i4__1", n).then(
          () => "servido",
          (e: Error) => e.message,
        ),
      ),
    )

    // Assert
    expect(out).toEqual(["arquivo inválido", "arquivo inválido", "arquivo inválido"])
  })

  it("lease: robot sem notícia do mestre é encerrado", async () => {
    // Arrange
    const { cfg, ad } = await env("1")
    const m = new RunManager({ cfg, ad, log: () => undefined, leaseMs: 1000 })
    await m.init()
    cleanups.push(() => m.close())
    const tgz = path.join(cfg.dataDir, "p.tgz")
    const { run } = await import("@/server/exec")
    await run("tar", ["-C", PROJECT, "-czf", tgz, "."])
    await m.receiveWorkspace(WS, (await import("node:fs")).createReadStream(tgz))
    await m.start(request("q1__i5__1", "Suite.CT_PIX_09-Caso-SLOW-PASS"))

    // Act
    await m.sweep(Date.now() + 5000)
    await new Promise((r) => setTimeout(r, 500))

    // Assert
    expect(m.status("q1__i5__1")?.state).toBe("exited")
  })
})
