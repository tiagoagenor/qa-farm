import { expect, test } from "@playwright/test"

import { catalogIds, command, ensureApp, ensureDevices, login } from "./helpers"

/** Fila ativa (pausada logo após criar, para não terminar durante o teste). */
async function activeQueue(page: import("@playwright/test").Page, name: string) {
  const ids = await catalogIds(page.request, (n) => n === "CT_PIX_03-Caso-SLOW-PASS")
  const appId = await ensureApp(page.request)
  const res = await command(page.request, { type: "create_queue", input: { name, appId, env: "hml", timeoutSec: 120, retries: 0, testIds: ids } })
  const id = res.data!.queueId as string
  await command(page.request, { type: "pause_queue", queueId: id })
  return id
}

test.beforeEach(async ({ page }) => {
  await login(page)
  await ensureDevices(page.request, 1)
})

test("na lista de filas a duração conta sozinha, sem recarregar a página", async ({ page }) => {
  // Arrange
  const name = `contador ${Date.now()}`
  const id = await activeQueue(page, name)
  await page.goto("/filas")
  const duration = page.getByTestId("queue-row").filter({ hasText: name }).getByTestId("queue-duration")
  await expect(duration).toHaveText(/\d+s$/)
  const first = await duration.textContent()

  // Act
  await page.waitForTimeout(2200)

  // Assert
  await expect(duration).not.toHaveText(first!)
  await command(page.request, { type: "cancel_queue", queueId: id })
})

test("no detalhe da fila o tempo total conta ao vivo e há média, maior e menor", async ({ page }) => {
  // Arrange
  const id = await activeQueue(page, `detalhe ${Date.now()}`)
  await page.goto(`/filas/${id}`)
  const total = page.getByTestId("time-total")
  await expect(total).toHaveText(/\d+s$/)
  const first = await total.textContent()

  // Act
  await page.waitForTimeout(2200)

  // Assert
  await expect(total).not.toHaveText(first!)
  for (const t of ["time-avg", "time-min", "time-max"]) await expect(page.getByTestId(t)).toBeVisible()
  await command(page.request, { type: "cancel_queue", queueId: id })
})
