// Testes de aceitação do QA Farm no server01 (tudo real: emuladores, Appium, Robot, painel).
// Uso (no server01, dentro de /home/server01/www/qa-farm):
//   set -a; . ./.env; set +a; npx tsx scripts/ops/acceptance.ts <passo...>
// Passos: t1 t2 t31 t34 t35 t36 t37 t32 t38 t39 t41 t42 t43 t44 t6 t24  (ou "all")
// Evidências: ~/qa-farm-data/aceite/aceite.jsonl (uma linha por verificação).
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"

import { loadConfig } from "../../src/core/config"
import { accountOverlaps, deviceOverlaps, peakConcurrency } from "../../src/core/overlap"
import { dataPaths } from "../../src/core/paths"
import type { Device, Queue } from "../../src/core/types"
import { pickCases } from "./pick-cases"

const cfg = loadConfig()
const P = dataPaths(cfg.dataDir)
const BASE = `http://127.0.0.1:${process.env.PORT ?? "3000"}`
const APK = process.env.ACEITE_APK ?? path.join(cfg.robotProject, "app/app.apk")
const OUT = path.join(cfg.dataDir, "aceite")
const STATE_FILE = path.join(OUT, "state.json")
fs.mkdirSync(OUT, { recursive: true })

type State = Record<string, string | number | undefined>
const state: State = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
let failures = 0

function record(id: string, ok: boolean, detail: string, data?: unknown) {
  const line = { at: new Date().toISOString(), id, ok, detail, data }
  fs.appendFileSync(path.join(OUT, "aceite.jsonl"), JSON.stringify(line) + "\n")
  console.log(`${ok ? "✅" : "❌"} ${id} — ${detail}`)
  if (!ok) failures++
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Padrão para pgrep -f que não casa com o próprio bash que roda o pgrep ("abc" → "[a]bc"). */
const pg = (pattern: string) => `[${pattern[0]}]${pattern.slice(1)}`
const sh = (cmd: string) => {
  try {
    return execFileSync("bash", ["-c", cmd], { encoding: "utf8", timeout: 120_000 }).trim()
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? "").trim()
  }
}

// ------------------------------------------------------------------ API ---
let cookie = ""
async function api(pathname: string, init: RequestInit & { duplex?: string } = {}, auth = true) {
  const headers = new Headers(init.headers)
  if (auth && cookie) headers.set("cookie", cookie)
  const r = await fetch(BASE + pathname, { ...init, headers } as RequestInit)
  const set = r.headers.get("set-cookie")
  if (set) cookie = set.split(";")[0]
  return r
}
const json = async <T = unknown>(pathname: string): Promise<T> => (await api(pathname)).json() as Promise<T>

async function login() {
  if (cookie) return
  const r = await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: cfg.password }) }, false)
  if (!r.ok) throw new Error(`login falhou: ${r.status}`)
}

async function command(cmd: Record<string, unknown>) {
  const r = await api("/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cmd) })
  const { id } = (await r.json()) as { id: string }
  for (let i = 0; i < 240; i++) {
    const res = await json<{ status: string; result: { ok: boolean; message: string; data?: Record<string, unknown> } }>(`/api/commands/${id}`)
    if (res.status === "done") return res.result
    await sleep(500)
  }
  throw new Error(`comando sem resposta: ${JSON.stringify(cmd)}`)
}

const devices = async () => (await json<{ devices: Device[] }>("/api/devices")).devices
const queue = async (id: string) => (await json<{ queue: Queue; summary: { finished: number; total: number } }>(`/api/queues/${id}`)).queue
const catalog = async () => (await json<{ total: number; entries: Array<{ id: string; name: string; tags: string[]; accounts: string[]; folder: string; duplicate: boolean; file: string; fileLongName: string; suite: string; line: number }> }>("/api/catalog"))

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs: number, everyMs = 5000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`tempo esgotado esperando: ${what}`)
    await sleep(everyMs)
  }
}

const formatSec = (a: { startedAt: string; endedAt?: string }) => `${Math.round((Date.parse(a.endedAt ?? "") - Date.parse(a.startedAt)) / 1000)}s`
const TERMINAL = new Set(["passed", "failed", "timeout", "infra_error", "config_error", "canceled"])
async function waitQueueDone(id: string, timeoutMs: number) {
  let last = ""
  return waitFor(`fila ${id} terminar`, async () => {
    const q = await queue(id)
    const done = q.items.filter((i) => TERMINAL.has(i.status)).length
    const msg = `${done}/${q.items.length}`
    if (msg !== last) console.log(`   … ${id}: ${msg} concluídos`)
    last = msg
    return q.status === "done" || q.status === "canceled" ? q : undefined
  }, timeoutMs)
}

async function createQueue(name: string, testIds: string[], opts: { timeoutSec?: number; retries?: number } = {}) {
  const res = await command({ type: "create_queue", input: { name, appId: state.appId, env: "hml", timeoutSec: opts.timeoutSec ?? 900, retries: opts.retries ?? 0, testIds } })
  if (!res.ok) throw new Error(`criar fila falhou: ${res.message}`)
  return res.data!.queueId as string
}

async function idsByName(names: string[]) {
  const c = await catalog()
  return names.map((n) => {
    const e = c.entries.find((x) => x.name.startsWith(n))
    if (!e) throw new Error(`caso não encontrado no catálogo: ${n}`)
    return e.id
  })
}

// ---------------------------------------------------------------- passos ---
const steps: Record<string, () => Promise<void>> = {
  async t1() {
    const wrong = await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "errada" }) }, false)
    const anon = await fetch(BASE + "/api/queues")
    await login()
    const ok = await api("/api/queues")
    record("T1.1", wrong.status === 401 && anon.status === 401 && ok.status === 200, `senha errada=${wrong.status}, sem login=${anon.status}, com login=${ok.status}`)

    const size = fs.statSync(APK).size
    const t0 = Date.now()
    const up = await api(`/api/upload?name=${encodeURIComponent(path.basename(APK))}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Readable.toWeb(fs.createReadStream(APK)) as unknown as BodyInit,
      duplex: "half",
    })
    const body = (await up.json()) as { app?: { id: string; package: string; versionName: string; versionCode: number; abis: string[] }; existingId?: string; error?: string }
    state.appId = body.app?.id ?? body.existingId
    save()
    const meta = JSON.parse(fs.readFileSync(P.appMeta(String(state.appId)), "utf8"))
    record(
      "T1.2",
      (up.status === 201 || up.status === 409) && meta.versionCode === 5528 && meta.abis.includes("x86_64"),
      `upload ${Math.round(size / 1024 / 1024)} MB em ${((Date.now() - t0) / 1000).toFixed(1)}s → ${up.status}; ${meta.package} ${meta.versionName} (${meta.versionCode}) ${meta.abis.join(",")}`,
    )

    const bad = await api("/api/upload?name=nao-e-apk.apk", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "isto não é um apk" })
    const badBody = (await bad.json()) as { error?: string }
    const dup = await api(`/api/upload?name=dup.apk`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Readable.toWeb(fs.createReadStream(APK)) as unknown as BodyInit,
      duplex: "half",
    })
    const dupBody = (await dup.json()) as { error?: string }
    record("T1.3", bad.status === 422 && dup.status === 409, `não-APK → ${bad.status} "${badBody.error}"; mesmo APK → ${dup.status} "${dupBody.error}"`)

    const c = await catalog()
    const login_ = c.entries.filter((e) => e.tags.includes("regressivo_login_hml"))
    record("T1.4", c.total === 1251 && login_.length > 0 && login_.every((e) => e.file.includes("login")), `catálogo ${c.total} casos; tag regressivo_login_hml → ${login_.length} casos, todos em login/`)
  },

  async t2() {
    await login()
    const res = await command({ type: "start_devices", count: 15 })
    const t0 = Date.now()
    const meta = JSON.parse(fs.readFileSync(P.appMeta(String(state.appId)), "utf8"))
    const ready = await waitFor(
      "15 emuladores prontos com o app",
      async () => {
        const r = (await devices()).filter((d) => d.kind === "emulator" && d.state === "ready" && d.appVersionCode === meta.versionCode)
        console.log(`   … ${r.length}/15 prontos com versionCode ${meta.versionCode}`)
        return r.length >= 15 ? r : undefined
      },
      40 * 60_000,
      15_000,
    )
    const all = await devices()
    const phys = all.find((d) => d.kind === "physical")
    record("T2.0", !!phys && phys.state === "external", `aparelhos no adb: ${all.length} (${all.filter((d) => d.kind === "emulator").length} emuladores + físico ${phys?.serial} como "${phys?.state}")`)
    record("T2.1", res.ok && ready.length >= 15, `15 emuladores "ready" com versionCode ${meta.versionCode} em ${Math.round((Date.now() - t0) / 1000)}s`, ready.map((d) => d.serial))
    const shot = await api("/api/devices/emulator-5554/screen")
    const buf = Buffer.from(await shot.arrayBuffer())
    record("T2.2", shot.status === 200 && shot.headers.get("content-type") === "image/png" && buf.length > 5000, `print emulator-5554: ${shot.status} ${shot.headers.get("content-type")} ${Math.round(buf.length / 1024)} KB`)
  },

  async t24() {
    await login()
    const before = await devices()
    const target = before.find((d) => d.serial === "emulator-5562")!
    const others = before.filter((d) => d.kind === "emulator" && d.serial !== target.serial)
    const res = await command({ type: "restart_device", serial: target.serial })
    const t0 = Date.now()
    await waitFor("entrar em manutenção", async () => (await devices()).find((d) => d.serial === target.serial)?.state === "maintenance", 60_000, 2000)
    const back = await waitFor(
      "voltar a ready",
      async () => {
        const d = (await devices()).find((x) => x.serial === target.serial)
        return d?.state === "ready" ? d : undefined
      },
      10 * 60_000,
      5000,
    )
    const after = await devices()
    const othersSame = others.every((o) => after.find((a) => a.serial === o.serial)?.qemuPid === o.qemuPid)
    record(
      "T2.3",
      res.ok && back.qemuPid !== target.qemuPid && othersSame,
      `${target.serial}: qemu ${target.qemuPid} → ${back.qemuPid}, pronto em ${Math.round((Date.now() - t0) / 1000)}s; outros 14 com o mesmo PID: ${othersSame}`,
    )
  },

  async t31() {
    await login()
    let q: Queue | null = null
    for (let n = 1; n <= 3; n++) {
      const id = await createQueue(`T3.1 canário CT_LOGIN_09 #${n}`, await idsByName(["CT_LOGIN_09"]))
      q = await waitQueueDone(id, 15 * 60_000)
      state.t31 = id
      save()
      if (q.items[0].status === "passed") break
      console.log(`   tentativa ${n}: ${q.items[0].status} — ${q.items[0].attempts.at(-1)?.message}`)
    }
    const a = q!.items[0].attempts.at(-1)!
    const files = await Promise.all(
      ["log.html", "report.html", "console.log", ...(a.screenshots ?? []).slice(0, 1)].map(async (f) => {
        const r = await api(`/api/runs/${[...a.dir.split("/"), f].map(encodeURIComponent).join("/")}`)
        return `${f}=${r.status}`
      }),
    )
    record("T3.1", q!.items[0].status === "passed" && files.every((f) => f.endsWith("=200")), `CT_LOGIN_09 → ${q!.items[0].status} em ${a.serial}; ${files.join(" ")}`)
  },

  async t34() {
    await login()
    const id = await createQueue("T3.4 falha CT_LOGIN_01", await idsByName(["CT_LOGIN_01"]))
    state.t34 = id
    save()
    const q = await waitQueueDone(id, 15 * 60_000)
    const a = q.items[0].attempts.at(-1)!
    const xml = fs.readFileSync(path.join(P.runs, a.dir, "output.xml"), "utf8")
    const testBody = xml.slice(xml.lastIndexOf("<test "), xml.lastIndexOf("</test>"))
    const lastStatus = testBody.slice(testBody.lastIndexOf("<status "))
    const raw = lastStatus.slice(lastStatus.indexOf(">") + 1, lastStatus.lastIndexOf("</status>"))
    const decoded = raw.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    const expected = decoded.split("\n\nAlso teardown failed:")[0]
    record("T3.4", q.items[0].status === "failed" && a.message === expected && !!a.teardownMessage, `status ${q.items[0].status}; mensagem = output.xml (${a.message?.slice(0, 90)}…); teardown="${a.teardownMessage}"`)
  },

  async t35() {
    await login()
    const id = await createQueue("T3.5 timeout 20s", await idsByName(["CT_LOGIN_01"]), { timeoutSec: 20 })
    const pgid = await waitFor("caso rodando", async () => (await queue(id)).items[0].attempts[0]?.pgid, 5 * 60_000, 1000)
    const aliveBefore = Number(sh(`ps -o pid= -g ${pgid} | wc -l`))
    const q = await waitQueueDone(id, 5 * 60_000)
    const a = q.items[0].attempts.at(-1)!
    await sleep(12_000)
    const alive = Number(sh(`ps -o pid= -g ${pgid} | wc -l`))
    const dev = (await devices()).find((d) => d.serial === a.serial)
    record("T3.5", q.items[0].status === "timeout" && alive === 0 && dev?.state !== "busy", `status ${q.items[0].status} após ${formatSec(a)}; processos do grupo ${pgid}: ${aliveBefore} rodando → ${alive} depois; ${a.serial} agora "${dev?.state}"`)
  },

  async t36() {
    await login()
    const c = await catalog()
    const ids = pickCases(c.entries as never, { n: 20, distinctAccounts: true, spreadFolders: true }).map((e) => e.id)
    const id = await createQueue("T3.6 pausar/continuar/cancelar", ids)
    await waitFor("algum caso rodando", async () => (await queue(id)).items.some((i) => i.status === "running"), 5 * 60_000, 2000)
    const pause = await command({ type: "pause_queue", queueId: id })
    const started0 = (await queue(id)).items.filter((i) => i.attempts.length > 0).length
    await sleep(30_000)
    const started1 = (await queue(id)).items.filter((i) => i.attempts.length > 0).length
    const resume = await command({ type: "resume_queue", queueId: id })
    await waitFor("retomar", async () => (await queue(id)).items.filter((i) => i.attempts.length > 0).length > started1, 5 * 60_000, 3000)
    const cancel = await command({ type: "cancel_queue", queueId: id })
    const q = await waitQueueDone(id, 3 * 60_000)
    await sleep(12_000)
    const robots = Number(sh(`pgrep -fc "${pg(`outputdir ${P.runs}/${id}/`)}" || true`) || 0)
    record(
      "T3.6",
      pause.ok && started1 === started0 && resume.ok && cancel.ok && q.status === "canceled" && robots === 0,
      `pausada: iniciados ${started0}→${started1} em 30s; retomada ok; cancelada: status ${q.status}, ${q.items.filter((i) => i.status === "canceled").length} cancelados, robots da fila vivos=${robots}`,
    )
  },

  async t37() {
    await login()
    const src = String(state.t34)
    const res = await command({ type: "rerun_failed", queueId: src })
    const q = await queue(res.data!.queueId as string)
    const orig = await queue(src)
    const failed = orig.items.filter((i) => ["failed", "timeout", "infra_error"].includes(i.status)).map((i) => i.testId)
    record("T3.7", res.ok && JSON.stringify(q.items.map((i) => i.testId)) === JSON.stringify(failed), `re-rodar falhas de ${src} → nova fila ${q.id} com ${q.items.length} caso(s): ${q.items.map((i) => i.name).join(", ")}`)
    await command({ type: "cancel_queue", queueId: q.id })
  },

  async t32() {
    await login()
    const c = await catalog()
    const ids = pickCases(c.entries as never, { n: 30, distinctAccounts: true, spreadFolders: true }).map((e) => e.id)
    const id = await createQueue("T3.2 30 casos em 15 celulares", ids)
    state.t32 = id
    save()
    const q = await waitQueueDone(id, 60 * 60_000)
    const attempts = q.items.flatMap((i) => i.attempts)
    const sessionOk = attempts.filter((a) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(P.runs, a.dir, "session.json"), "utf8")).serial === a.serial
      } catch {
        return false
      }
    }).length
    const peak = peakConcurrency([q])
    record("T3.2", peak === 15 && sessionOk === attempts.filter((a) => a.status !== "infra_error" || fs.existsSync(path.join(P.runs, a.dir, "session.json"))).length, `pico de concorrência ${peak}; ${new Set(attempts.map((a) => a.serial)).size} seriais; session.json confere em ${sessionOk}/${attempts.length} tentativas`)
    const acc = accountOverlaps([q])
    record("T3.3", acc.length === 0 && deviceOverlaps([q]).length === 0, `sobreposição de conta: ${acc.length}; celular com 2 casos: ${deviceOverlaps([q]).length}`)
  },

  async t38() {
    await login()
    const c = await catalog()
    const ids = pickCases(c.entries as never, { n: 100, distinctAccounts: false, spreadFolders: true }).map((e) => e.id)
    const id = await createQueue("T3.8 100 casos", ids)
    state.t38 = id
    save()
    // T5: amostra recursos por 15 min em paralelo + latência do painel
    const csv = path.join(OUT, "recursos.csv")
    const sampler = sh(`nohup ${cfg.repoRoot}/scripts/ops/sample-resources.sh 900 ${csv} > ${OUT}/recursos.txt 2>&1 & echo $!`)
    await sleep(60_000)
    const lat: number[] = []
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now()
      await api(`/api/queues/${id}`)
      lat.push(performance.now() - t0)
      await sleep(1000)
    }
    lat.sort((a, b) => a - b)
    const p95 = lat[Math.floor(lat.length * 0.95)]
    record("T5.2", p95 < 1000, `latência /api/queues/:id com fila rodando: p50 ${lat[30].toFixed(0)} ms, p95 ${p95.toFixed(0)} ms (60 amostras)`)
    // T6.5: ambiente de um robot em execução
    const pid = sh(`pgrep -f "${pg(`outputdir ${P.runs}/${id}/`)}" | head -1`)
    const envv = pid ? sh(`tr '\\0' '\\n' < /proc/${pid}/environ | cut -d= -f1 | sort | tr '\\n' ' '`) : ""
    record("T6.5", !!pid && !/QAFARM_PASSWORD|QAFARM_SECRET/.test(envv), `variáveis do robot pid ${pid}: ${envv}`)
    const q = await waitQueueDone(id, 4 * 3600_000)
    const peak = peakConcurrency([q])
    const final = q.items.filter((i) => TERMINAL.has(i.status)).length
    record("T3.8", final === 100 && peak >= 12 && peak <= 15 && deviceOverlaps([q]).length === 0, `${final}/100 com status final; pico ${peak}; celular com 2 casos: ${deviceOverlaps([q]).length}; ${JSON.stringify(Object.fromEntries([...new Set(q.items.map((i) => i.status))].map((s) => [s, q.items.filter((i) => i.status === s).length])))}`)
    await waitFor("amostragem de recursos", async () => fs.existsSync(`${OUT}/recursos.txt`) && fs.readFileSync(`${OUT}/recursos.txt`, "utf8").includes("amostras="), 20 * 60_000, 10_000)
    const sum = fs.readFileSync(`${OUT}/recursos.txt`, "utf8").trim()
    const m = /mem_min_mb=(\d+) oom_kill=(\d+)/.exec(sum)
    record("T5.1", !!m && Number(m[1]) > 5000 && Number(m[2]) === 0, `15 min com 15 celulares + fila: ${sum} (CSV: ${csv}, sampler pid ${sampler})`)
  },

  async t39() {
    await login()
    const id = String(state.t31)
    const a = (await queue(id)).items[0].attempts.at(-1)!
    sh(`kill -9 $(cat ${cfg.dataDir}/run/web.pid) $(cat ${cfg.dataDir}/run/runner.pid) 2>/dev/null; pkill -9 -f "dist/runner.mjs" || true`)
    const t0 = Date.now()
    await waitFor("web e runner voltarem", async () => {
      try {
        const r = await fetch(BASE + "/login")
        const st = JSON.parse(fs.readFileSync(P.runnerState, "utf8"))
        return r.ok && Date.now() - Date.parse(st.heartbeatAt) < 5000
      } catch {
        return false
      }
    }, 3 * 60_000, 3000)
    cookie = ""
    await login()
    const files = await Promise.all(["log.html", "report.html", "console.log"].map(async (f) => (await api(`/api/runs/${[...a.dir.split("/"), f].map(encodeURIComponent).join("/")}`)).status))
    record("T3.9", files.every((s) => s === 200), `após kill -9 em web+runner voltaram em ${Math.round((Date.now() - t0) / 1000)}s; arquivos da fila antiga: ${files.join(",")}`)
  },

  async t41() {
    await login()
    const id = await createQueue("T4.1 celular cai no meio", await idsByName(["CT_LOGIN_01"]))
    const running = await waitFor("caso rodando", async () => (await queue(id)).items[0].attempts[0]?.status === "running" && (await queue(id)).items[0].attempts[0], 5 * 60_000, 1000)
    await sleep(10_000)
    const serialA = running.serial
    const idx = (Number(serialA.split("-")[1]) - 5554) / 2 + 1
    const pid = sh(`cat ${cfg.farmHome}/run/farm-${String(idx).padStart(2, "0")}.pid`)
    sh(`kill -9 ${pid}`)
    const t0 = Date.now()
    const q = await waitQueueDone(id, 20 * 60_000)
    const [a1, a2] = q.items[0].attempts
    const back = await waitFor("celular A voltar", async () => (await devices()).find((d) => d.serial === serialA)?.state === "ready", 15 * 60_000, 10_000)
    record(
      "T4.1",
      a1.status === "infra_error" && !!a2 && a2.serial !== serialA && ["passed", "failed"].includes(q.items[0].status) && back,
      `kill -9 qemu ${pid} (${serialA}) → tentativa 1 ${a1.status}; tentativa 2 em ${a2?.serial} → ${q.items[0].status}; ${serialA} voltou "ready" em ${Math.round((Date.now() - t0) / 1000)}s`,
    )
  },

  async t42() {
    await login()
    const c = await catalog()
    const ids = pickCases(c.entries as never, { n: 20, distinctAccounts: true, spreadFolders: true }).map((e) => e.id)
    const id = await createQueue("T4.2 runner morto no meio", ids)
    await waitFor("casos rodando", async () => (await queue(id)).items.filter((i) => i.status === "running").length >= 5, 5 * 60_000, 2000)
    sh(`kill -9 $(cat ${cfg.dataDir}/run/runner.pid) 2>/dev/null; pkill -9 -f "dist/runner.mjs" || true`)
    const t0 = Date.now()
    await waitFor("runner voltar", async () => {
      const st = JSON.parse(fs.readFileSync(P.runnerState, "utf8"))
      return Date.now() - Date.parse(st.heartbeatAt) < 5000 && Date.parse(st.startedAt) > t0
    }, 3 * 60_000, 3000)
    const back = Math.round((Date.now() - t0) / 1000)
    await sleep(120_000)
    const st = JSON.parse(fs.readFileSync(P.runnerState, "utf8"))
    const robotPids = sh(`pgrep -f "${pg("qafarm_listener")}" | xargs -r ps -o pgid= -p | sort -u | tr -d ' '`).split("\n").filter(Boolean).map(Number)
    const orphans = robotPids.filter((g) => !st.pgids.includes(g))
    const q = await waitQueueDone(id, 60 * 60_000)
    record("T4.2", back <= 90 && orphans.length === 0 && q.status === "done", `runner voltou em ${back}s; robots fora dos PGIDs do runner após 2 min: ${orphans.length}; fila terminou (${q.status})`)
  },

  async t43() {
    sh(`kill -9 $(cat ${cfg.dataDir}/run/web.pid) 2>/dev/null`)
    const t0 = Date.now()
    await waitFor("web voltar", async () => {
      try {
        return (await fetch(BASE + "/login")).ok
      } catch {
        return false
      }
    }, 3 * 60_000, 3000)
    const s = Math.round((Date.now() - t0) / 1000)
    record("T4.3", s <= 90, `web voltou em ${s}s após kill -9`)
  },

  async t44() {
    await login()
    await waitFor("sem filas ativas", async () => (await json<{ queues: Array<{ status: string }> }>("/api/queues")).queues.every((q) => q.status === "done" || q.status === "canceled"), 30 * 60_000, 10_000)
    await sleep(15_000)
    const robots = Number(sh(`pgrep -fc "${pg("qafarm_listener")}" || true`) || 0)
    const sessions: number[] = []
    for (let g = 1; g <= Math.ceil(15 / cfg.devicesPerAppium); g++) {
      const r = sh(`curl -s -m 3 127.0.0.1:${cfg.appiumBasePort + g}/wd/hub/appium/sessions`)
      try {
        sessions.push((JSON.parse(r).value as unknown[]).length)
      } catch {
        sessions.push(-1)
      }
    }
    record("T4.4", robots === 0 && sessions.every((n) => n === 0), `robots vivos: ${robots}; sessões abertas por servidor Appium (${sessions.length} servidores): ${sessions.join(",")}`)
  },

  async t6() {
    const gitStatus = sh(`git -C ${cfg.robotProject} status --porcelain`)
    record("T6.4", gitStatus === "", `git status do QA_Automacao_APP: ${gitStatus === "" ? "limpo" : gitStatus}`)
    const pkg = JSON.parse(fs.readFileSync(path.join(cfg.repoRoot, "package.json"), "utf8"))
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    const db = deps.filter((d) => /sql|mongo|prisma|redis|typeorm|sequelize|knex|drizzle|pg$/.test(d))
    record("T6.6", db.length === 0, `dependências de banco: ${db.length ? db.join(",") : "nenhuma"}; dados em ${cfg.dataDir}`)
    record("T6.7", fs.existsSync(path.join(cfg.repoRoot, "components.json")) && fs.existsSync(path.join(cfg.repoRoot, "src/components/ui/button.tsx")), "components.json e src/components/ui (shadcn) presentes")
  },

  async stop() {
    await login()
    const res = await command({ type: "stop_all_devices" })
    await waitFor("emuladores desligarem", async () => Number(sh("pgrep -c qemu-system || true") || 0) === 0, 5 * 60_000, 5000)
    record("T2.4", res.ok, `desligar todos → ${res.message}; processos qemu: ${sh("pgrep -c qemu-system || true") || 0}`)
  },
}

async function main() {
  const wanted = process.argv.slice(2)
  const order = ["t1", "t2", "t31", "t34", "t35", "t36", "t37", "t32", "t38", "t39", "t41", "t42", "t43", "t24", "t44", "t6"]
  const list = wanted.includes("all") ? order : wanted
  for (const s of list) {
    if (!steps[s]) throw new Error(`passo desconhecido: ${s}`)
    console.log(`\n=== ${s} ===`)
    try {
      await steps[s]()
    } catch (e) {
      record(s.toUpperCase(), false, `erro: ${(e as Error).message}`)
    }
  }
  console.log(`\n${failures === 0 ? "✅ tudo certo" : `❌ ${failures} verificação(ões) falharam`}`)
  process.exit(failures ? 1 : 0)
}

void main()
