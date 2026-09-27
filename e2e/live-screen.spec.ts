import { expect, test } from "@playwright/test"

import { catalogIds, command, ensureApp, ensureDevices, login } from "./helpers"

test.beforeEach(async ({ page }) => {
  await login(page)
  await ensureDevices(page.request, 2)
})

test.afterEach(async ({ page }) => {
  await command(page.request, { type: "set_settings", maxScreenSessions: 3 })
})

test("Ao vivo: abre a tela do celular, mostra o uso do limite e só manda comandos com Controlar ligado", async ({
  page,
}) => {
  // Arrange
  await page.goto("/celulares")
  const card = page.locator('[data-testid="device-card"][data-serial="emulator-5554"]')

  // Act
  await card.getByTestId("device-live").click()

  // Assert
  await expect(page.getByTestId("live-fake")).toContainText("fake:emulator-5554:", { timeout: 15_000 })
  await expect(page.getByTestId("live-usage")).toContainText("1/3 celular(es) ao vivo")
  await expect(page.getByTestId("live-home")).toBeDisabled()
  await page.getByTestId("live-control").click()
  await expect(page.getByTestId("live-home")).toBeEnabled()
})

test("limite 1: um segundo celular ao mesmo tempo é recusado com a explicação", async ({ page, browser }) => {
  // Arrange
  await command(page.request, { type: "set_settings", maxScreenSessions: 1 })
  await page.goto("/celulares")
  await page
    .locator('[data-testid="device-card"][data-serial="emulator-5554"]')
    .getByTestId("device-live")
    .click()
  await expect(page.getByTestId("live-fake")).toBeVisible({ timeout: 15_000 })
  const other = await browser.newContext()
  const p2 = await other.newPage()
  await login(p2)

  // Act
  await p2.goto("/celulares")
  await p2
    .locator('[data-testid="device-card"][data-serial="emulator-5556"]')
    .getByTestId("device-live")
    .click()

  // Assert
  await expect(p2.getByTestId("live-closed")).toContainText("Limite de 1 celular(es) ao vivo", {
    timeout: 15_000,
  })
  await other.close()
})

test("fila: caso rodando tem o ícone Ao vivo no celular; clicar abre a tela daquele celular", async ({
  page,
}) => {
  // Arrange
  const appId = await ensureApp(page.request)
  const ids = await catalogIds(page.request, (n) => n.includes("TIMEOUT"))
  const res = await command(page.request, {
    type: "create_queue",
    input: {
      name: "ao vivo na fila",
      appId,
      env: "hml",
      timeoutSec: 120,
      retries: 0,
      testIds: ids.slice(0, 1),
    },
  })
  const qid = res.data!.queueId as string
  await page.goto(`/filas/${qid}`)
  const icon = page.getByTestId("item-live").first()
  await expect(icon).toBeVisible({ timeout: 30_000 })

  // Act
  await icon.click()

  // Assert
  await expect(page.getByTestId("live-fake")).toContainText("fake:emulator-", { timeout: 15_000 })
  await command(page.request, { type: "cancel_queue", queueId: qid })
})
