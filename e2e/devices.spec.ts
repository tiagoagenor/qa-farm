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
