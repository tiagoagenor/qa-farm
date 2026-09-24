import { expect, test } from "@playwright/test"

import { catalogIds, command, ensureApp, ensureDevices, login } from "./helpers"

async function finishedQueue(page: import("@playwright/test").Page) {
  const ids = await catalogIds(page.request, (n) => n === "CT_LOGIN_01-Caso-PASS")
  const appId = await ensureApp(page.request)
  const res = await command(page.request, {
    type: "create_queue",
    input: { name: `colunas ${Date.now()}`, appId, env: "hml", timeoutSec: 120, retries: 0, testIds: ids },
  })
  const id = res.data!.queueId as string
  await expect
    .poll(async () => (await (await page.request.get(`/api/queues/${id}`)).json()).queue.status, { timeout: 60_000 })
    .toBe("done")
  return id
}

test.beforeEach(async ({ page }) => {
  await login(page)
  await ensureDevices(page.request, 1)
})

test("esconder uma coluna pelo seletor tira a coluna da tabela e fica lembrado ao recarregar", async ({ page }) => {
  // Arrange
  const id = await finishedQueue(page)
  await page.goto(`/filas/${id}`)
  await expect(page.getByTestId("item-massa").first()).toBeVisible()

  // Act
  await page.getByTestId("columns-menu").click()
  await page.getByTestId("column-toggle-massa").click()
  await page.keyboard.press("Escape")

  // Assert
  await expect(page.getByTestId("item-massa")).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId("item-row").first()).toBeVisible()
  await expect(page.getByTestId("item-massa")).toHaveCount(0)
  await page.getByTestId("columns-menu").click()
  await page.getByTestId("columns-reset").click()
  await expect(page.getByTestId("item-massa").first()).toBeVisible()
})

test("arrastar a borda do cabeçalho aumenta a largura da coluna sem alargar a página", async ({ page }) => {
  // Arrange
  const id = await finishedQueue(page)
  await page.goto(`/filas/${id}`)
  const head = page.locator('th[data-col="massa"]')
  await page.getByTestId("resize-massa").scrollIntoViewIfNeeded()
  const before = (await head.boundingBox())!.width
  const handle = (await page.getByTestId("resize-massa").boundingBox())!

  // Act
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + 150, handle.y + handle.height / 2, { steps: 5 })
  await page.mouse.up()

  // Assert
  await expect.poll(async () => (await head.boundingBox())!.width).toBeGreaterThan(before + 100)
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(pageOverflow).toBeLessThanOrEqual(0)
  await page.getByTestId("resize-massa").dblclick()
  await expect.poll(async () => Math.round((await head.boundingBox())!.width)).toBe(Math.round(before))
})
