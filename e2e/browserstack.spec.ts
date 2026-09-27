import { expect, test } from "@playwright/test"

import { catalogIds, command, ensureApp, login } from "./helpers"

test.beforeEach(async ({ page }) => {
  await login(page)
})

test.afterEach(async ({ page }) => {
  await command(page.request, { type: "bs_set_enabled", enabled: false })
  const bs = await (await page.request.get("/api/browserstack")).json()
  for (const s of bs.slots) await command(page.request, { type: "bs_remove_slot", id: s.id })
})

test("adicionar vaga do BrowserStack pela tela, ligar e ver a vaga pronta em Celulares; desligar tira dos testes", async ({
  page,
}) => {
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
  await expect(section.locator('[data-testid="device-card"][data-state="ready"]')).toHaveCount(1, {
    timeout: 30_000,
  })
  await expect(section).toContainText("Samsung Galaxy S22 · Android 12.0")
  await command(page.request, { type: "bs_set_enabled", enabled: false })
  await expect(section.locator('[data-testid="device-card"]').first()).toHaveAttribute(
    "data-state",
    "offline",
    { timeout: 20_000 },
  )
})

test("vaga do BrowserStack: Ver tela só com caso rodando; mostra o print da sessão e Atualizar pega outro", async ({
  page,
}) => {
  // Arrange
  await command(page.request, { type: "stop_all_devices" }) // o caso tem que ir para a vaga da nuvem
  await command(page.request, { type: "bs_add_slot", device: "Samsung Galaxy S22", osVersion: "12.0" })
  await command(page.request, { type: "bs_set_enabled", enabled: true })
  await page.goto("/celulares")
  const card = page
    .locator('[data-testid="machine-section"][data-machine="browserstack"] [data-testid="device-card"]')
    .first()
  await expect(card).toHaveAttribute("data-state", "ready", { timeout: 30_000 })
  await expect(card.getByTestId("device-screen-cloud")).toBeDisabled()
  const appId = await ensureApp(page.request)
  const ids = await catalogIds(page.request, (n) => n.includes("TIMEOUT"))
  const q = await command(page.request, {
    type: "create_queue",
    input: { name: "bs print", appId, env: "hml", timeoutSec: 120, retries: 0, testIds: ids.slice(0, 1) },
  })
  await expect(card).toHaveAttribute("data-state", "busy", { timeout: 30_000 })

  // Act
  await card.getByTestId("device-screen-cloud").click()
  await expect(page.getByTestId("device-screen")).toBeVisible({ timeout: 15_000 })
  const first = await page.getByRole("dialog").textContent()
  await page.waitForTimeout(3200) // cache de 3 s do print da nuvem
  await page.getByTestId("device-screen-refresh").click()

  // Assert
  await expect(page.getByRole("dialog")).toContainText("Print da sessão do BrowserStack")
  await expect.poll(async () => page.getByRole("dialog").textContent(), { timeout: 10_000 }).not.toBe(first)
  await expect(page.getByTestId("device-screen")).toBeVisible()
  await command(page.request, { type: "cancel_queue", queueId: q.data!.queueId })
})
