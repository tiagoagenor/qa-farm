import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { fixCaseLinks } from "@/server/snapshot"

// no macOS o sistema de arquivos padrão ignora maiúsculas: o link não é necessário (nem possível)
const probe = fsSync.mkdtempSync(path.join(os.tmpdir(), "qafarm-case-"))
fsSync.writeFileSync(path.join(probe, "a"), "")
const caseSensitive = !fsSync.existsSync(path.join(probe, "A"))
fsSync.rmSync(probe, { recursive: true, force: true })

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "qafarm-snap-"))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function write(rel: string, content = "") {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), content)
}

describe("fixCaseLinks", () => {
  it.skipIf(!caseSensitive)("cria links para pastas importadas com letras trocadas", async () => {
    // Arrange
    await write("elements/investimentos/bolsaFacil/favoritos.py", "X = 1")
    await write(
      "pageObject/investimentos/bolsa.robot",
      "*** Settings ***\nVariables    ../../elements/Investimentos/BolsaFacil/favoritos.py\n",
    )

    // Act
    const links = await fixCaseLinks(root)

    // Assert
    const readable = await fs.readFile(path.join(root, "elements/Investimentos/BolsaFacil/favoritos.py"), "utf8")
    expect([links.sort(), readable]).toEqual([["elements/Investimentos", "elements/Investimentos/BolsaFacil"], "X = 1"])
  })

  it("não mexe em imports que já funcionam", async () => {
    // Arrange
    await write("resources/resource.robot", "")
    await write("scenarios/a.robot", "*** Settings ***\nResource    ../resources/resource.robot\n")

    // Act
    const links = await fixCaseLinks(root)

    // Assert
    expect(links).toEqual([])
  })

  it("ignora imports com variável e bibliotecas por nome", async () => {
    // Arrange
    await write("scenarios/a.robot", "*** Settings ***\nLibrary    AppiumLibrary\nResource    ${CURDIR}/x.robot\n")

    // Act
    const links = await fixCaseLinks(root)

    // Assert
    expect(links).toEqual([])
  })
})
