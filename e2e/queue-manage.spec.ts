import { expect, test } from "@playwright/test"

import { catalogIds, command, ensureApp, ensureDevices, login } from "./helpers"

async function finishedQueue(page: import("@playwright/test").Page, name: string, testNames: string[]) {
  const ids = await catalogIds(page.request, (n) => testNames.includes(n))
  const appId = await ensureApp(page.request)
  const res = await command(page.request, { type: "create_queue", input: { name, appId, env: "hml", timeoutSec: 120, retries: 0, testIds: ids } })
  const id = res.data!.queueId as string
  await expect
    .poll(async () => (await (await page.request.get(`/api/queues/${id}`)).json()).queue.status, { timeout: 60_000 })
    .toBe("done")
  return id
}

test.beforeEach(async ({ page }) => {
  await login(page)
  await ensureDevices(page.request, 2)
})

test("apagar fila pede confirmação e remove a fila da lista", async ({ page }) => {
  // Arrange
  const name = `apagar ${Date.now()}`
  await finishedQueue(page, name, ["CT_LOGIN_01-Caso-PASS"])
  await page.goto("/filas")
  const row = page.getByTestId("queue-row").filter({ hasText: name })

  // Act
  await row.getByTestId("delete-queue").click()
  await expect(page.getByRole("alertdialog")).toContainText("Não dá para desfazer")
  await page.getByTestId("confirm-delete-queue").click()

  // Assert
  await expect(row).toHaveCount(0, { timeout: 15_000 })
})

test("voltar no modal não apaga a fila", async ({ page }) => {
  // Arrange
  const name = `manter ${Date.now()}`
  const id = await finishedQueue(page, name, ["CT_LOGIN_01-Caso-PASS"])
  await page.goto("/filas")

  // Act
  await page.getByTestId("queue-row").filter({ hasText: name }).getByTestId("delete-queue").click()
  await page.getByRole("button", { name: "Voltar" }).click()

  // Assert
  expect((await page.request.get(`/api/queues/${id}`)).status()).toBe(200)
})

test("limpar tudo pede confirmação e apaga as filas terminadas", async ({ page }) => {
  // Arrange
  await finishedQueue(page, `limpar ${Date.now()}`, ["CT_LOGIN_01-Caso-PASS"])
  await page.goto("/filas")
  await expect(page.getByTestId("clear-queues")).toBeEnabled()

  // Act
  await page.getByTestId("clear-queues").click()
  await expect(page.getByRole("alertdialog")).toContainText("serão apagadas")
  await page.getByTestId("confirm-clear-queues").click()

  // Assert
  await expect(page.getByText("Nenhuma fila ainda")).toBeVisible({ timeout: 15_000 })
})

test("caso que falhou pode ser rodado de novo sozinho", async ({ page }) => {
  // Arrange
  const id = await finishedQueue(page, `retry ${Date.now()}`, ["CT_LOGIN_01-Caso-PASS", "CT_LOGIN_03-Caso-FAIL"])
  await page.goto(`/filas/${id}`)
  const failedRow = page.locator('[data-testid="item-row"][data-status="failed"]')
  await expect(failedRow).toHaveCount(1)

  // Act
  await failedRow.getByTestId("retry-item").click()

  // Assert
  await expect
    .poll(async () => {
      const q = (await (await page.request.get(`/api/queues/${id}`)).json()).queue
      return [q.status, q.items.map((i: { attempts: unknown[] }) => i.attempts.length)]
    }, { timeout: 60_000 })
    .toEqual(["done", [1, 2]])
  await expect(page.getByTestId("retry-item")).toHaveCount(1)
})
