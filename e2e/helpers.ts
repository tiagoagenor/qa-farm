import fs from "node:fs"
import path from "node:path"

import { type APIRequestContext, expect, type Page } from "@playwright/test"

export const PASSWORD = "e2e-senha"

export async function login(page: Page) {
  const r = await page.request.post("/api/auth/login", { data: { password: PASSWORD } })
  expect(r.ok()).toBeTruthy()
}

export async function command(request: APIRequestContext, cmd: Record<string, unknown>) {
  const { id } = await (await request.post("/api/commands", { data: cmd })).json()
  for (let i = 0; i < 60; i++) {
    const r = await (await request.get(`/api/commands/${id}`)).json()
    if (r.status === "done") return r.result as { ok: boolean; message: string; data?: Record<string, unknown> }
    await new Promise((res) => setTimeout(res, 500))
  }
  throw new Error("runner não respondeu ao comando")
}

/** Garante N emuladores prontos (idempotente). */
export async function ensureDevices(request: APIRequestContext, n: number) {
  await command(request, { type: "start_devices", count: n })
  await expect
    .poll(async () => {
      const d = await (await request.get("/api/devices")).json()
      return d.devices.filter((x: { kind: string; state: string }) => x.kind === "emulator" && (x.state === "ready" || x.state === "busy")).length
    }, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(n)
}

/** Garante um APK enviado e devolve o id (idempotente pelo conteúdo). */
export async function ensureApp(request: APIRequestContext): Promise<string> {
  const r = await request.post("/api/upload?name=app-e2e.apk", {
    headers: { "Content-Type": "application/octet-stream" },
    data: Buffer.from("PK\u0003\u0004 apk-e2e-fixo"),
  })
  const body = await r.json()
  if (r.status() === 201) return body.app.id
  if (r.status() === 409) return body.existingId
  throw new Error(`upload falhou: ${r.status()} ${JSON.stringify(body)}`)
}

export async function catalogIds(request: APIRequestContext, pred: (name: string) => boolean): Promise<string[]> {
  await expect.poll(async () => (await (await request.get("/api/catalog")).json()).total, { timeout: 30_000 }).toBeGreaterThan(0)
  const c = await (await request.get("/api/catalog")).json()
  return c.entries.filter((e: { name: string }) => pred(e.name)).map((e: { id: string }) => e.id)
}

export function tmpFile(name: string, content: string | Buffer): string {
  const dir = path.join(__dirname, "..", "test-results", "e2e-files")
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}
