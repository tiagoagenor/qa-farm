import { expect, test } from "@playwright/test"

import { login, tmpFile } from "./helpers"

test.beforeEach(async ({ page }) => {
  await login(page)
})

test("upload de APK pela tela mostra os dados do manifesto", async ({ page }) => {
  // Arrange
  const apk = tmpFile(`app-${Date.now()}.apk`, `PK\u0003\u0004 apk de teste ${Date.now()}`)
  await page.goto("/apps")

  // Act
  await page.getByTestId("apk-input").setInputFiles(apk)

  // Assert
  await expect(page.getByTestId("upload-ok")).toContainText("versão 7.26.0 (5528)")
  await expect(page.getByTestId("upload-ok")).toContainText("x86_64")
  await expect(page.getByTestId("app-row").first()).toBeVisible()
})

test("arquivo que não é APK é recusado com mensagem clara", async ({ page }) => {
  // Arrange
  const txt = tmpFile("nao-e-apk.apk", "isto é texto, não um apk")
  await page.goto("/apps")

  // Act
  await page.getByTestId("apk-input").setInputFiles(txt)

  // Assert
  await expect(page.getByTestId("upload-error")).toContainText("Arquivo não é um APK válido")
})

test("o mesmo APK enviado duas vezes é recusado como duplicado", async ({ page }) => {
  // Arrange
  const apk = tmpFile("duplicado.apk", "PK\u0003\u0004 sempre o mesmo conteudo")
  await page.goto("/apps")
  await page.getByTestId("apk-input").setInputFiles(apk)
  await expect(page.getByTestId("upload-ok").or(page.getByTestId("upload-error"))).toBeVisible()

  // Act
  await page.getByTestId("apk-input").setInputFiles(apk)

  // Assert
  await expect(page.getByTestId("upload-error")).toContainText("já foi enviado")
})
