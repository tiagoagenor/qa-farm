import { expect, test } from "@playwright/test"

import { login } from "./helpers"

test.beforeEach(async ({ page }) => {
  await login(page)
})

test("testes aparecem agrupados pelas pastas do projeto", async ({ page }) => {
  // Arrange
  await page.goto("/testes")

  // Act
  const folders = page.getByTestId("tree-folder")

  // Assert
  await expect(folders).toHaveText([/cartoes/, /investimentos/, /login/, /pix/, /ted/])
  await expect(page.getByTestId("catalog-row")).toHaveCount(0)
})

test("abrir a pasta e o arquivo mostra os casos daquele grupo", async ({ page }) => {
  // Arrange
  await page.goto("/testes")

  // Act
  await page.locator('[data-testid="tree-folder"][data-key="scenarios/pix"]').click()
  await page.locator('[data-testid="tree-file"][data-key="scenarios/pix/pix.robot"]').click()

  // Assert
  await expect(page.getByTestId("catalog-row")).toHaveCount(11)
  await expect(page.getByTestId("catalog-row").first()).toContainText("CT_PIX_01")
})

test("marcar a pasta seleciona todos os casos dela", async ({ page }) => {
  // Arrange
  await page.goto("/testes")
  await page.evaluate(() => localStorage.removeItem("qafarm:selected"))
  await page.reload()

  // Act
  await page.locator('[data-testid="tree-folder"][data-key="scenarios/login"]').getByTestId("group-check").click()

  // Assert
  await expect(page.getByTestId("selected-count")).toHaveText("12 selecionado(s)")
  await expect(page.locator('[data-testid="tree-folder"][data-key="scenarios/login"]')).toContainText("12 selecionados")
})
