import { expect, test } from "@playwright/test"

import { ensureDevices, login } from "./helpers"

test.beforeEach(async ({ page }) => {
  await login(page)
})

test("ligar celulares mostra os emuladores prontos e o físico como externo", async ({ page }) => {
  // Arrange
  await page.goto("/celulares")

  // Act
  await page.getByTestId("start-count").fill("4")
  await page.getByTestId("start-devices").click()

  // Assert
  await expect(page.locator('[data-testid="device-card"][data-state="ready"]')).toHaveCount(4, { timeout: 30_000 })
  await expect(page.locator('[data-testid="device-card"][data-serial="FAKE-PHYSICAL-01"]')).toHaveAttribute("data-state", "external")
})

test("ver tela mostra o print do celular", async ({ page }) => {
  // Arrange
  await ensureDevices(page.request, 1)
  await page.goto("/celulares")

  // Act
  await page.locator('[data-serial="emulator-5554"]').getByRole("button", { name: "Ver tela" }).click()

  // Assert
  const img = page.getByTestId("device-screen")
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
})

test("ativar o aparelho físico coloca ele no conjunto de testes e desativar tira", async ({ page }) => {
  // Arrange
  await page.goto("/celulares")
  const card = page.locator('[data-testid="device-card"][data-serial="FAKE-PHYSICAL-01"]')
  await expect(card).toHaveAttribute("data-state", "external")

  // Act
  await card.getByTestId("physical-switch").click()
  await expect(card).toHaveAttribute("data-state", "ready", { timeout: 30_000 })
  await card.getByTestId("physical-switch").click()

  // Assert
  await expect(card).toHaveAttribute("data-state", "external", { timeout: 30_000 })
  await expect(card.getByTestId("physical-switch")).not.toBeChecked()
})

test("emulador tem a chave usar nos testes: desligar tira do conjunto e ligar devolve", async ({ page }) => {
  // Arrange
  await ensureDevices(page.request, 2)
  await page.goto("/celulares")
  const card = page.locator('[data-testid="device-card"][data-serial="emulator-5556"]')
  const toggle = card.getByTestId("emulator-switch")
  await expect(toggle).toHaveAttribute("data-state", "checked")

  // Act
  await toggle.click()

  // Assert
  await expect(card).toContainText("Desativado — não recebe casos", { timeout: 15_000 })
  await expect(toggle).toHaveAttribute("data-state", "unchecked")
  await toggle.click()
  await expect(card).toContainText("Recebe casos das filas", { timeout: 15_000 })
})
