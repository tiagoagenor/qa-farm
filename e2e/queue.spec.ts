import { expect, test } from "@playwright/test"

import { catalogIds, command, ensureApp, ensureDevices, login } from "./helpers"

test.beforeEach(async ({ page }) => {
  await login(page)
  await ensureDevices(page.request, 4)
  await ensureApp(page.request)
})

test("selecionar casos pelo filtro e criar fila mostra passou/falhou por caso", async ({ page }) => {
  // Arrange
  await page.goto("/testes")
  await page.getByTestId("catalog-search").fill("CT_LOGIN_0")
  await expect(page.getByTestId("visible-count")).toHaveText(/^9 de \d+ casos$/)

  // Act
  await page.getByTestId("select-visible").click()
  await page.getByTestId("open-create-queue").click()
  await page.getByTestId("create-queue-submit").click()

  // Assert
  await expect(page).toHaveURL(/\/filas\/queue_/, { timeout: 30_000 })
  await expect(page.getByTestId("queue-progress")).toContainText("9 de 9 concluído(s)", { timeout: 90_000 })
  await expect(page.locator('[data-testid="item-row"][data-status="passed"]')).toHaveCount(7)
  await expect(page.locator('[data-testid="item-row"][data-status="failed"]')).toHaveCount(1)
  await expect(page.locator('[data-testid="item-row"][data-status="infra_error"]')).toHaveCount(1)
  await expect(page.getByTestId("item-error").first()).toContainText("did not match any elements")
})

test("log.html de um caso abre com o conteúdo do Robot", async ({ page }) => {
  // Arrange
  const ids = await catalogIds(page.request, (n) => n === "CT_PIX_77-Caso (ç+$) PASS")
  const appId = await ensureApp(page.request)
  const res = await command(page.request, { type: "create_queue", input: { name: "log e2e", appId, env: "hml", timeoutSec: 120, retries: 0, testIds: ids } })
  await page.goto(`/filas/${res.data!.queueId}`)
  await expect(page.getByTestId("queue-progress")).toContainText("1 de 1", { timeout: 60_000 })

  // Act
  const href = await page.getByTestId("log-link").getAttribute("href")
  const log = await page.request.get(href!)

  // Assert
  expect([log.status(), log.headers()["content-type"]]).toEqual([200, "text/html; charset=utf-8"])
  expect(await log.text()).toContain("CT_PIX_77-Caso (ç+$) PASS")
})

test("detalhe do caso mostra tentativas, erro e console", async ({ page }) => {
  // Arrange
  const ids = await catalogIds(page.request, (n) => n === "CT_PIX_01-Caso-FAIL")
  const appId = await ensureApp(page.request)
  const res = await command(page.request, { type: "create_queue", input: { name: "detalhe e2e", appId, env: "hml", timeoutSec: 120, retries: 1, testIds: ids } })
  await page.goto(`/filas/${res.data!.queueId}`)
  await expect(page.getByTestId("queue-progress")).toContainText("1 de 1", { timeout: 60_000 })

  // Act
  await page.getByTestId("item-row").first().click()

  // Assert
  await expect(page.getByRole("tab", { name: "Tentativa 2" })).toBeVisible()
  await expect(page.getByTestId("attempt-message")).toContainText("did not match any elements")
  await expect(page.getByTestId("console-text")).toContainText("passo 3/3")
})

test("re-rodar falhas cria uma fila só com os casos que falharam", async ({ page }) => {
  // Arrange
  const ids = await catalogIds(page.request, (n) => ["CT_TED_02-Caso-PASS", "CT_TED_07-Caso-FAIL"].includes(n))
  const appId = await ensureApp(page.request)
  const res = await command(page.request, { type: "create_queue", input: { name: "rerun e2e", appId, env: "hml", timeoutSec: 120, retries: 0, testIds: ids } })
  await page.goto(`/filas/${res.data!.queueId}`)
  await expect(page.getByTestId("queue-progress")).toContainText("2 de 2", { timeout: 60_000 })

  // Act
  await page.getByTestId("rerun-failed").click()

  // Assert
  await expect(page).toHaveURL(/\/filas\/queue_/)
  await expect.poll(async () => page.url()).not.toContain(res.data!.queueId as string)
  await expect(page.getByTestId("item-row")).toHaveCount(1)
  await expect(page.getByTestId("item-row").first()).toContainText("CT_TED_07-Caso-FAIL")
})
