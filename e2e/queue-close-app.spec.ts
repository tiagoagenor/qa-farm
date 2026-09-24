import { expect, test } from "@playwright/test"

import { ensureApp, ensureDevices, login } from "./helpers"

test.beforeEach(async ({ page }) => {
  await login(page)
  await ensureDevices(page.request, 1)
  await ensureApp(page.request)
})

test("fechar o app ao terminar o caso vem ligado e pode ser desligado na criação da fila", async ({ page }) => {
  // Arrange
  await page.goto("/testes")
  await page.getByTestId("catalog-search").fill("CT_LOGIN_01-Caso-PASS")
  await page.getByTestId("select-visible").click()
  await page.getByTestId("open-create-queue").click()
  const toggle = page.getByTestId("queue-close-app")
  await expect(toggle).toHaveAttribute("data-state", "checked")

  // Act
  await toggle.click()
  await page.getByTestId("create-queue-submit").click()

  // Assert
  await expect(page).toHaveURL(/\/filas\/queue_/, { timeout: 30_000 })
  await expect(page.getByText("app fica aberto ao fim do caso")).toBeVisible()
})
