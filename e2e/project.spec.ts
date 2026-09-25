import { expect, test } from "@playwright/test"

import { command, login } from "./helpers"

test.beforeEach(async ({ page }) => {
  await login(page)
})

test.afterEach(async ({ page }) => {
  // volta o projeto simulado para main (o estado do runner é compartilhado entre os testes)
  await command(page.request, { type: "project_update", branch: "main" })
})

test("menu Projeto: escolher a branch mostra o que viria; atualizar troca a branch e mostra o log", async ({
  page,
}) => {
  // Arrange
  await page.goto("/projeto")
  await expect(page.getByTestId("project-branch")).toHaveText("main", { timeout: 20_000 })
  await page.getByTestId("branch-select").click()
  await page.getByRole("option", { name: "develop" }).click()
  await expect(page.getByTestId("project-incoming")).toContainText("develop traria 8 commit(s)")

  // Act
  await page.getByTestId("project-pull").click()
  await page.getByTestId("project-pull-confirm").click()

  // Assert
  await expect(page.getByTestId("project-op")).toBeVisible() // aparece na hora, sem esperar o próximo ciclo
  await expect(page.getByText(/Projeto atualizado — Projeto em develop/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText("Atualizando o projeto para develop…")).toHaveCount(0) // sem aviso de "sucesso" antes de terminar
  await expect(page.getByTestId("project-op")).toHaveAttribute("data-status", "ok")
  await expect(page.getByTestId("project-op")).toContainText("git switch develop")
  await expect(page.getByTestId("project-branch")).toHaveText("develop", { timeout: 20_000 })
})

test("código: navega pelas pastas e mostra o arquivo com os segredos ocultados", async ({ page }) => {
  // Arrange
  await page.goto("/projeto")
  await page.getByTestId("tab-code").click()

  // Act
  await page.locator('[data-testid="code-entry"][data-path="resources"]').click()
  await page.locator('[data-testid="code-entry"][data-path="resources/resource.robot"]').click()

  // Assert
  await expect(page.getByTestId("code-path")).toHaveText("resources/resource.robot")
  await expect(page.getByTestId("code-content")).toContainText("${ACCESS_KEY}       ••••")
  await expect(page.getByTestId("code-content")).not.toContainText("FAKE_BS_KEY_123456")
  await expect(page.getByTestId("code-masked")).toBeVisible()
  const api = await page.request.get(`/api/project/file?path=${encodeURIComponent("../../../.env")}`)
  expect(api.status()).toBe(404)
})
