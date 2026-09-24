import { expect, test } from "@playwright/test"

import { ensureApp, login } from "./helpers"

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

test("fila de uma pasta recebe o nome versão-build + pasta", async ({ page }) => {
  // Arrange
  await ensureApp(page.request)
  await page.goto("/testes")
  await page.evaluate(() => localStorage.removeItem("qafarm:selected"))
  await page.reload()
  await page.locator('[data-testid="tree-folder"][data-key="scenarios/pix"]').getByTestId("group-check").click()

  // Act
  await page.getByTestId("open-create-queue").click()

  // Assert
  await expect(page.getByTestId("queue-name")).toHaveValue("7.26.0-5528 pix")
})

test("fila de várias pastas recebe o nome versão-build + Fila + data de hoje", async ({ page }) => {
  // Arrange
  await ensureApp(page.request)
  await page.goto("/testes")
  await page.evaluate(() => localStorage.removeItem("qafarm:selected"))
  await page.reload()
  await page.locator('[data-testid="tree-folder"][data-key="scenarios/pix"]').getByTestId("group-check").click()
  await page.locator('[data-testid="tree-folder"][data-key="scenarios/login"]').getByTestId("group-check").click()
  const d = new Date()
  const hoje = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`

  // Act
  await page.getByTestId("open-create-queue").click()

  // Assert
  await expect(page.getByTestId("queue-name")).toHaveValue(`7.26.0-5528 Fila ${hoje}`)
})

test("nome digitado pelo usuário não é sobrescrito", async ({ page }) => {
  // Arrange
  await ensureApp(page.request)
  await page.goto("/testes")
  await page.locator('[data-testid="tree-folder"][data-key="scenarios/ted"]').getByTestId("group-check").click()
  await page.getByTestId("open-create-queue").click()
  await expect(page.getByTestId("queue-name")).toHaveValue(/ted$/)

  // Act
  await page.getByTestId("queue-name").fill("Minha fila")
  await page.waitForTimeout(1500)

  // Assert
  await expect(page.getByTestId("queue-name")).toHaveValue("Minha fila")
})
