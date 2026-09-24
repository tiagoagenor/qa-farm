import { expect, test } from "@playwright/test"

import { catalogIds, command, ensureApp, ensureDevices, login } from "./helpers"

async function finishedQueue(page: import("@playwright/test").Page, names: string[]) {
  const ids = await catalogIds(page.request, (n) => names.includes(n))
  const appId = await ensureApp(page.request)
  const res = await command(page.request, {
    type: "create_queue",
    input: { name: `massa ${Date.now()}`, appId, env: "hml", timeoutSec: 120, retries: 0, testIds: ids },
  })
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

test("a tabela mostra a conta usada e o detalhe mostra a massa com a senha escondida", async ({ page }) => {
  // Arrange
  const id = await finishedQueue(page, ["CT_LOGIN_01-Caso-PASS"])
  await page.goto(`/filas/${id}`)
  await expect(page.getByTestId("item-massa").first()).toHaveText("usuario_fake · fake@teste.com")

  // Act
  await page.getByTestId("item-row").first().click()

  // Assert
  const massa = page.getByTestId("massa")
  await expect(massa).toContainText("usuario_fake")
  await expect(massa).toContainText("fake@teste.com")
  await expect(massa).toContainText("12345678909")
  await expect(massa.getByTestId("massa-field").filter({ hasText: "password" })).toContainText("••••••")
})

test("os casos da fila aparecem nas pastas do projeto com a contagem de falhas", async ({ page }) => {
  // Arrange
  const id = await finishedQueue(page, ["CT_LOGIN_01-Caso-PASS", "CT_LOGIN_03-Caso-FAIL", "CT_PIX_03-Caso-SLOW-PASS"])

  // Act
  await page.goto(`/filas/${id}`)

  // Assert
  const login = page.getByTestId("queue-folder").filter({ hasText: "login" })
  await expect(login).toContainText("❌ 1")
  await expect(login).toHaveAttribute("data-failed", "1")
  await expect(page.getByTestId("queue-folder").filter({ hasText: "pix" })).toHaveAttribute("data-failed", "0")
  await expect(page.getByTestId("item-row")).toHaveCount(3)
})

test("fechar a pasta esconde os casos dela e a visão lista mostra tudo sem pastas", async ({ page }) => {
  // Arrange
  const id = await finishedQueue(page, ["CT_LOGIN_01-Caso-PASS", "CT_PIX_03-Caso-SLOW-PASS"])
  await page.goto(`/filas/${id}`)
  await expect(page.getByTestId("item-row")).toHaveCount(2)

  // Act
  await page.getByTestId("queue-folder").filter({ hasText: "login" }).click()

  // Assert
  await expect(page.getByTestId("item-row")).toHaveCount(1)
  await page.getByTestId("view-list").click()
  await expect(page.getByTestId("queue-folder")).toHaveCount(0)
  await expect(page.getByTestId("item-row")).toHaveCount(2)
})
