import { expect, test } from "@playwright/test"

import { command, login } from "./helpers"

const WORKER = { url: "http://127.0.0.1:3299", token: "e2e-worker-token-0123456789abcdef" }

test.beforeEach(async ({ page }) => {
  await login(page)
})

test.afterEach(async ({ page }) => {
  await command(page.request, { type: "remove_machine", id: "server02" }).catch(() => undefined)
})

test("cadastrar um worker: aparece online, com saúde e celulares na página Celulares; a API nunca expõe o token", async ({ page }) => {
  // Arrange
  await page.goto("/maquinas")
  await expect(page.getByTestId("master-public-key")).toContainText("ssh-ed25519")

  // Act
  const res = await command(page.request, {
    type: "add_machine",
    id: "server02",
    name: "server02",
    host: "127.0.0.1",
    sshUser: "server02",
    sshPort: 22,
    maxDevices: 6,
    directUrl: WORKER.url,
    token: WORKER.token,
  })

  // Assert
  expect(res.ok).toBe(true)
  const row = page.locator('[data-testid="machine-row"][data-machine="server02"]')
  await expect(row).toHaveAttribute("data-state", "online", { timeout: 20_000 })
  await expect(page.locator('[data-testid="machine-card"][data-machine="server02"]')).toContainText("Online", { timeout: 20_000 })
  const api = await (await page.request.get("/api/machines")).text()
  expect(api).not.toContain(WORKER.token)
  await page.goto("/celulares")
  const section = page.locator('[data-testid="machine-section"][data-machine="server02"]')
  await expect(section.locator('[data-testid="device-card"][data-state="ready"]')).toHaveCount(2, { timeout: 30_000 })
  await expect(section.getByTestId("device-card").first()).toHaveAttribute("data-serial", /^server02:emulator-/)
})

test("desativar o worker pelo menu de ações deixa a máquina desativada", async ({ page }) => {
  // Arrange
  await command(page.request, {
    type: "add_machine",
    id: "server02",
    name: "server02",
    host: "127.0.0.1",
    sshUser: "server02",
    sshPort: 22,
    maxDevices: 6,
    directUrl: WORKER.url,
    token: WORKER.token,
  })
  await page.goto("/maquinas")
  const row = page.locator('[data-testid="machine-row"][data-machine="server02"]')
  await expect(row).toHaveAttribute("data-state", "online", { timeout: 20_000 })

  // Act
  await row.getByTestId("machine-actions").click()
  await page.getByTestId("machine-toggle").click()

  // Assert
  await expect(row).toHaveAttribute("data-state", "disabled", { timeout: 20_000 })
})

test("adicionar máquina pela tela valida o ID e mostra o comando para autorizar a chave do mestre", async ({ page }) => {
  // Arrange
  await page.goto("/maquinas")

  // Act
  await page.getByTestId("add-machine").click()
  await page.getByTestId("machine-id").fill("Server 02")

  // Assert
  await expect(page.getByText("Minúsculas, números e hífen")).toBeVisible()
  await expect(page.getByTestId("authorize-command")).toContainText(">> ~/.ssh/authorized_keys")
  await expect(page.getByTestId("machine-save")).toBeDisabled()
})

test("ligar 'robot nesta máquina' no worker: a linha mostra 'aqui' e o BrowserStack pode rodar o robot nele", async ({ page }) => {
  // Arrange
  await command(page.request, {
    type: "add_machine",
    id: "server02",
    name: "server02",
    host: "127.0.0.1",
    sshUser: "server02",
    sshPort: 22,
    maxDevices: 6,
    directUrl: WORKER.url,
    token: WORKER.token,
  })
  await page.goto("/maquinas")
  const row = page.locator('[data-testid="machine-row"][data-machine="server02"]')
  await expect(row).toHaveAttribute("data-state", "online", { timeout: 20_000 })

  // Act
  await row.getByTestId("machine-run-robot").click()
  await page.getByTestId("bs-run-on-select").click()
  await page.getByRole("option", { name: "server02" }).click()

  // Assert
  await expect(row.getByTestId("machine-robot")).toContainText("aqui")
  await expect(page.getByTestId("bs-run-on-select")).toContainText("server02")
  const bs = await (await page.request.get("/api/browserstack")).json()
  expect(bs.runOn).toBe("server02")
  await command(page.request, { type: "bs_set_run_on", machineId: null })
})
