import http from "node:http"

import { expect, test } from "@playwright/test"

import { login } from "./helpers"

/** POST com o corpo enviado em pedaços, com pausa — como um navegador pela rede. */
function slowPost(baseURL: string, path: string, body: string, cookie: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseURL)
    const buf = Buffer.from(body)
    const req = http.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": buf.length, Cookie: cookie } },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on("error", reject)
    const step = 16 * 1024
    let off = 0
    const next = () => {
      if (off >= buf.length) return req.end()
      req.write(buf.subarray(off, off + step))
      off += step
      setTimeout(next, 30)
    }
    next()
  })
}

const bigQueue = (n: number) =>
  JSON.stringify({
    type: "create_queue",
    input: {
      name: "grande",
      appId: "nao-existe",
      env: "hml",
      timeoutSec: 60,
      retries: 0,
      testIds: Array.from({ length: n }, (_, i) => `scenarios/investimentos/pasta/arquivo.robot::CT_CASO_${i}-Nome-longo-do-caso-SMOKE`),
    },
  })

test("fila grande enviada em pedaços pela rede é aceita (sem erro 500)", async ({ page, baseURL }) => {
  // Arrange
  await login(page)
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ")
  const body = bigQueue(1500)

  // Act
  const status = await slowPost(baseURL!, "/api/commands", body, cookie)

  // Assert
  expect(status).toBe(202)
})

test("comando sem login continua recusado", async ({ baseURL }) => {
  // Arrange
  const body = bigQueue(10)

  // Act
  const status = await slowPost(baseURL!, "/api/commands", body, "")

  // Assert
  expect(status).toBe(401)
})
