import { expect, request as pwRequest, test } from "@playwright/test"

import { PASSWORD } from "./helpers"

test("senha errada mostra erro e não entra", async ({ page }) => {
  // Arrange
  await page.goto("/filas")

  // Act
  await page.getByLabel("Senha").fill("senha-errada")
  await page.getByRole("button", { name: "Entrar" }).click()

  // Assert
  await expect(page.getByTestId("login-error")).toHaveText("Senha incorreta")
  await expect(page).toHaveURL(/\/login/)
})

test("senha certa entra e volta para a página pedida", async ({ page }) => {
  // Arrange
  await page.goto("/celulares")

  // Act
  await page.getByLabel("Senha").fill(PASSWORD)
  await page.getByRole("button", { name: "Entrar" }).click()

  // Assert
  await expect(page).toHaveURL(/\/celulares$/)
  await expect(page.getByRole("heading", { name: "Celulares" })).toBeVisible()
})

test("API sem login responde 401", async ({ baseURL }) => {
  // Arrange
  const anon = await pwRequest.newContext({ baseURL })

  // Act
  const responses = await Promise.all([anon.get("/api/queues"), anon.post("/api/upload?name=x.apk", { data: "PK" }), anon.get("/api/runs/x/y")])

  // Assert
  expect(responses.map((r) => r.status())).toEqual([401, 401, 401])
})
