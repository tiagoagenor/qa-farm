import { describe, expect, it } from "vitest"

import { commonFolder, defaultQueueName } from "@/lib/queue-name"

const APP = { versionName: "7.26.0", versionCode: 5528 }
const NOW = new Date(2026, 8, 24, 10, 30) // 24/09/2026 (hora local)

describe("defaultQueueName", () => {
  it("casos de uma pasta usam versão-build + nome da pasta", () => {
    // Arrange
    const entries = [{ folder: "scenarios/pix" }, { folder: "scenarios/pix" }]

    // Act
    const name = defaultQueueName(APP, entries, NOW)

    // Assert
    expect(name).toBe("7.26.0-5528 pix")
  })

  it("pasta com subpastas selecionada inteira usa a pasta de cima", () => {
    // Arrange
    const entries = [{ folder: "scenarios/investimentos/bolsaFacil" }, { folder: "scenarios/investimentos/tesouro" }]

    // Act
    const name = defaultQueueName(APP, entries, NOW)

    // Assert
    expect(name).toBe("7.26.0-5528 investimentos")
  })

  it("subpasta mostra o caminho dela", () => {
    // Arrange
    const entries = [{ folder: "scenarios/investimentos/bolsaFacil" }]

    // Act
    const name = defaultQueueName(APP, entries, NOW)

    // Assert
    expect(name).toBe("7.26.0-5528 investimentos/bolsaFacil")
  })

  it("várias pastas usam versão-build + Fila + data de hoje", () => {
    // Arrange
    const entries = [{ folder: "scenarios/pix" }, { folder: "scenarios/login" }]

    // Act
    const name = defaultQueueName(APP, entries, NOW)

    // Assert
    expect(name).toBe("7.26.0-5528 Fila 24/09/2026")
  })

  it("sem app escolhido usa só a parte da pasta", () => {
    // Arrange
    const entries = [{ folder: "scenarios/login" }]

    // Act
    const name = defaultQueueName(null, entries, NOW)

    // Assert
    expect(name).toBe("login")
  })
})

describe("commonFolder", () => {
  it("sem casos não há pasta comum", () => {
    // Arrange
    const entries: { folder: string }[] = []

    // Act
    const folder = commonFolder(entries)

    // Assert
    expect(folder).toBeNull()
  })
})
