import fs from "node:fs"
import path from "node:path"

import { expect, test } from "@playwright/test"

import { login } from "./helpers"

const WORLD = path.join(__dirname, "..", "test-results", "e2e-data", "fake", "world.json")

/** Muda a saúde simulada da máquina (o runner fake lê o "mundo" a cada 2 s). */
function setWorld(patch: Record<string, number | undefined>) {
  const w = JSON.parse(fs.readFileSync(WORLD, "utf8"))
  fs.writeFileSync(WORLD, JSON.stringify({ ...w, ...patch }))
}

test.beforeEach(async ({ page }) => {
  await login(page)
})

test.afterEach(() => {
  setWorld({ tempC: undefined, cpuPct: undefined })
})

test("página Máquinas mostra memória, processador e temperatura do servidor ao vivo", async ({ page }) => {
  // Arrange
  setWorld({ tempC: 47, cpuPct: 33 })

  // Act
  await page.goto("/maquinas")

  // Assert
  const card = page.locator('[data-testid="machine-card"][data-machine="server01"]')
  await expect(card).toContainText("mestre")
  await expect(card.getByTestId("temp-package")).toHaveText("47 °C", { timeout: 15_000 })
  await expect(card.getByTestId("cpu-pct")).toHaveText("33%")
  await expect(card.getByTestId("mem-available")).toContainText("GB disponíveis")
  await expect(card).toHaveAttribute("data-level", "ok")
})

test("processador quente deixa o cartão crítico, mostra o freio e acende o alerta no menu", async ({ page }) => {
  // Arrange
  await page.goto("/maquinas")
  const card = page.locator('[data-testid="machine-card"][data-machine="server01"]')
  await expect(card).toBeVisible({ timeout: 15_000 })

  // Act
  setWorld({ tempC: 91 })

  // Assert
  await expect(card).toHaveAttribute("data-level", "crit", { timeout: 15_000 })
  await expect(card).toContainText("freio ativo: novos casos aguardam")
  await expect(card.getByTestId("machine-alerts")).toContainText("Processador a 91 °C")
  await expect(page.getByTestId("health-dot")).toHaveAttribute("data-level", "crit", { timeout: 15_000 })
  setWorld({ tempC: 45 })
  await expect(card).toHaveAttribute("data-level", "ok", { timeout: 15_000 })
})
