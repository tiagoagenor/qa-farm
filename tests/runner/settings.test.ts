import { afterEach, describe, expect, it } from "vitest"

import { readJson } from "@/core/store"
import { SettingsSchema } from "@/core/types"

import { type Harness, makeHarness } from "./harness"

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
})

describe("configurações do pool", () => {
  it("mudar só o limite de telas ao vivo mantém o limite de casos (e vice-versa)", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0 })
    await h.command({ type: "set_settings", maxParallel: 7 })

    // Act
    const res = await h.command({ type: "set_settings", maxScreenSessions: 2 })
    const saved = await readJson(h.p.settings, SettingsSchema, { maxParallel: 0, maxScreenSessions: 3 })

    // Assert
    expect([res.message, saved]).toEqual([
      "Até 2 celular(es) com tela ao vivo ao mesmo tempo",
      { maxParallel: 7, maxScreenSessions: 2 },
    ])
  })
})
