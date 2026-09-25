import { expect, test } from "@playwright/test"

import { catalogIds, command, ensureApp, ensureDevices, login } from "./helpers"

test.beforeEach(async ({ page }) => {
  await login(page)
  await ensureDevices(page.request, 2)
})

test("aumentar as tentativas extras numa fila terminada roda de novo o caso que falhou", async ({ page }) => {
  // Arrange
  const ids = await catalogIds(page.request, (n) => ["CT_LOGIN_01-Caso-PASS", "CT_LOGIN_03-Caso-FAIL"].includes(n))
  const appId = await ensureApp(page.request)
  const res = await command(page.request, {
    type: "create_queue",
    input: { name: `tentativas ${Date.now()}`, appId, env: "hml", timeoutSec: 120, retries: 0, testIds: ids },
  })
  const id = res.data!.queueId as string
  await expect.poll(async () => (await (await page.request.get(`/api/queues/${id}`)).json()).queue.status, { timeout: 60_000 }).toBe("done")
  await page.goto(`/filas/${id}`)

  // Act
  await page.getByTestId("queue-retries").click()
  await page.getByRole("option", { name: "2", exact: true }).click()

  // Assert
  await expect
    .poll(
      async () => {
        const q = (await (await page.request.get(`/api/queues/${id}`)).json()).queue
        return q.status === "done" ? q.items.find((i: { name: string }) => i.name.includes("FAIL")).attempts.length : -1
      },
      { timeout: 60_000 },
    )
    .toBe(3)
  await expect(page.getByTestId("queue-retries")).toHaveText("2")
})

test("esperas vêm ×2 na criação e podem ser alteradas na fila", async ({ page }) => {
  // Arrange
  await page.goto("/testes")
  await page.getByTestId("catalog-search").fill("CT_LOGIN_01-Caso-PASS")
  await page.getByTestId("select-visible").click()
  await page.getByTestId("open-create-queue").click()
  await expect(page.getByTestId("queue-wait-factor")).toHaveText("×2")

  // Act
  await page.getByTestId("create-queue-submit").click()
  await expect(page).toHaveURL(/\/filas\/queue_/, { timeout: 30_000 })
  await page.getByTestId("queue-wait").click()
  await page.getByRole("option", { name: "×3" }).click()

  // Assert
  await expect(page.getByTestId("queue-wait")).toHaveText("×3", { timeout: 15_000 })
  await expect(page.getByText(/esperas ×3/)).toBeVisible()
})

test("limite de casos ao mesmo tempo é salvo na página Máquinas", async ({ page }) => {
  // Arrange
  await page.goto("/maquinas")

  // Act
  await page.getByTestId("parallel-input").fill("7")
  await page.getByTestId("parallel-save").click()

  // Assert
  await expect(page.getByTestId("parallel-limit")).toContainText("Hoje: 7.", { timeout: 15_000 })
  await command(page.request, { type: "set_settings", maxParallel: 0 })
})
