import { expect, test } from "@playwright/test"

import { command, ensureApp, ensureDevices, login } from "./helpers"

test.beforeEach(async ({ page }) => {
  await login(page)
})

test("Testes começa perguntando o projeto e cada um abre o seu catálogo", async ({ page }) => {
  // Arrange
  await page.goto("/testes")
  await expect(page.getByTestId("choose-giat")).toContainText("5 caso(s)", { timeout: 20_000 })

  // Act
  await page.getByTestId("choose-giat").click()

  // Assert
  await expect(page).toHaveURL(/projeto=giat/)
  await expect(page.getByRole("heading", { name: /GI-App-Test/ })).toBeVisible()
  await expect(page.getByTestId("tree-folder")).toHaveText([/flows/, /login/, /smoke/])
  await page.getByTestId("switch-project").click()
  await page.getByTestId("choose-robot").click()
  await expect(page.getByTestId("tree-folder")).toHaveText([/cartoes/, /investimentos/, /login/, /pix/, /ted/])
})

test("fila do GI-App-Test: seleciona as pastas, escolhe o ambiente e roda como o Robot", async ({ page }) => {
  // Arrange
  await ensureDevices(page.request, 4)
  await ensureApp(page.request)
  await page.goto("/testes?projeto=giat")
  await expect(page.getByTestId("tree-folder")).toHaveCount(3, { timeout: 20_000 })

  // Act
  await page.getByTestId("select-visible").click()
  await page.getByTestId("open-create-queue").click()
  await page.getByRole("dialog").getByText("Ambiente").locator("..").getByRole("combobox").click()
  await page.getByRole("option", { name: "PROD" }).click()
  await page.getByTestId("create-queue-submit").click()

  // Assert
  await expect(page).toHaveURL(/\/filas\/queue_/, { timeout: 30_000 })
  await expect(page.getByText(/GI-App-Test · Criada .* ambiente PROD/)).toBeVisible()
  await expect(page.getByTestId("queue-progress")).toContainText("5 de 5 concluído(s)", { timeout: 90_000 })
  await expect(page.getByRole("tab", { name: "Passou (3)" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Falhas (2)" })).toBeVisible()
  const id = page.url().split("/filas/")[1]
  const q = (await (await page.request.get(`/api/queues/${id}`)).json()) as { queue?: { items: Array<{ attempts: Array<{ dir: string }> }> }; items?: Array<{ attempts: Array<{ dir: string }> }> }
  const dir = (q.queue?.items ?? q.items ?? [])[0].attempts[0].dir
  const consoleText = await (await page.request.get(`/api/runs/${dir.split("/").map(encodeURIComponent).join("/")}/console.log`)).text()
  expect(consoleText).toContain("GI-App-Test (simulado)")
  expect(consoleText).toContain("· PROD ·")
})

test("Projeto: alterna para o GI-App-Test e atualiza o código dele", async ({ page }) => {
  // Arrange
  await page.goto("/projeto")
  await page.getByTestId("project-switch-giat").click()
  await expect(page).toHaveURL(/projeto=giat/)
  await expect(page.getByTestId("project-branch")).toHaveText("main", { timeout: 20_000 })

  // Act
  await page.getByTestId("branch-select").click()
  await page.getByRole("option", { name: "develop" }).click()
  await page.getByTestId("project-pull").click()
  await page.getByTestId("project-pull-confirm").click()

  // Assert
  await expect(page.getByTestId("project-branch")).toHaveText("develop", { timeout: 20_000 })
  await page.getByTestId("project-switch-robot").click()
  await expect(page.getByTestId("project-branch")).toHaveText("main", { timeout: 20_000 }) // o Robot não mudou
  await command(page.request, { type: "project_update", branch: "main", project: "giat" })
})
