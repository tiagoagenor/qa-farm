import { expect, test } from "@playwright/test"

import { login } from "./helpers"

for (const scheme of ["light", "dark"] as const) {
  test(`todas as telas carregam sem erro de página (tema ${scheme})`, async ({ browser, baseURL }) => {
    // Arrange
    const ctx = await browser.newContext({ baseURL, colorScheme: scheme, viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]))
    page.on("console", (m) => m.type() === "error" && errors.push(m.text().split("\n")[0]))
    await login(page)

    // Act
    for (const path of ["/filas", "/testes", "/celulares", "/apps"]) {
      await page.goto(path)
      await expect(page.locator("main h1")).toBeVisible()
      await page.waitForTimeout(800)
    }

    // Assert
    expect(errors).toEqual([])
    await ctx.close()
  })
}
