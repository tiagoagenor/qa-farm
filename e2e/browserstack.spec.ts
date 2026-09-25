import { expect, test } from "@playwright/test"

import { command, login } from "./helpers"

test.beforeEach(async ({ page }) => {
  await login(page)
})

test.afterEach(async ({ page }) => {
  await command(page.request, { type: "bs_set_enabled", enabled: false })
  const bs = await (await page.request.get("/api/browserstack")).json()
  for (const s of bs.slots) await command(page.request, { type: "bs_remove_slot", id: s.id })
})

test("adicionar vaga do BrowserStack pela tela, ligar e ver a vaga pronta em Celulares; desligar tira dos testes", async ({ page }) => {
  // Arrange
  await page.goto("/maquinas")
  const card = page.getByTestId("browserstack-card")
  await expect(card.getByTestId("bs-plan")).toContainText("Sessões em uso", { timeout: 20_000 })

  // Act
  await card.getByTestId("bs-device-select").click()
  await page.getByRole("option", { name: "Samsung Galaxy S22 · Android 12.0" }).click()
  await card.getByTestId("bs-add-slot").click()
  await expect(card.getByTestId("bs-slot")).toHaveCount(1, { timeout: 15_000 })
  await card.getByTestId("bs-enabled").click()

  // Assert
  await expect(card).toContainText("Ligado", { timeout: 15_000 })
  await page.goto("/celulares")
  const section = page.locator('[data-testid="machine-section"][data-machine="browserstack"]')
  await expect(section.locator('[data-testid="device-card"][data-state="ready"]')).toHaveCount(1, { timeout: 30_000 })
  await expect(section).toContainText("Samsung Galaxy S22 · Android 12.0")
  await command(page.request, { type: "bs_set_enabled", enabled: false })
  await expect(section.locator('[data-testid="device-card"]').first()).toHaveAttribute("data-state", "offline", { timeout: 20_000 })
})
