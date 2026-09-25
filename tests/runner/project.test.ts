import { afterEach, describe, expect, it } from "vitest"

import { newId } from "@/core/ids"
import { ProjectGitStateSchema } from "@/core/project-git"
import { readJson, writeJsonAtomic } from "@/core/store"
import { type Command, CommandResultSchema } from "@/core/types"

import { type Harness, makeHarness } from "./harness"

// Página Projeto: o runner é quem roda o git (uma operação por vez) e grava state/project-git.json.

let h: Harness | null = null
afterEach(async () => {
  delete process.env.QAFARM_FAKE_GIT
  await h?.cleanup()
  h = null
})

const state = () => readJson(h!.p.projectGit, ProjectGitStateSchema.nullable(), null)
const opDone = async () => {
  const s = await state()
  return s?.op && s.op.status !== "running" ? s : undefined
}

describe("projeto (git) pelo runner", () => {
  it("ao iniciar grava branch, commits e branches do servidor", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0 })

    // Act
    const s = await h.tickUntil(async () => ((await state())?.branch ? state() : undefined))

    // Assert
    expect([s?.branch, s?.behind, s?.remoteBranches?.map((b) => b.name).sort(), s?.remoteUrl]).toEqual([
      "main",
      2,
      ["develop", "feature/exemplo", "main"],
      "git@git.example.invalid:qa/projeto-robot",
    ])
  })

  it("atualizar para outra branch: troca, registra o log e o estado passa a mostrar a branch nova", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0 })

    // Act
    const res = await h.command({ type: "project_update", branch: "develop" })
    const s = await h.tickUntil(async () => {
      const x = await opDone()
      return x && x.branch === "develop" ? x : undefined
    })

    // Assert
    expect([
      res.ok,
      s.op?.status,
      s.op?.log.some((l) => l.includes("git switch develop")),
      s.behind,
      s.head?.subject,
    ]).toEqual([true, "ok", true, 0, "develop: ajuste 8"])
  })

  it("uma operação por vez: a segunda é recusada enquanto a primeira roda", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0, fakeSpeed: 5 })
    const cmds: Command[] = [{ type: "project_fetch" }, { type: "project_update", branch: "develop" }]
    const ids = cmds.map(() => newId("cmd"))
    for (const [i, c] of cmds.entries())
      await writeJsonAtomic(h.p.command(ids[i]), {
        id: ids[i],
        createdAt: new Date().toISOString(),
        command: c,
      })

    // Act
    const results = await h.tickUntil(async () => {
      const r = await Promise.all(
        ids.map((id) => readJson(h!.p.commandDone(id), CommandResultSchema.nullable(), null)),
      )
      return r.every(Boolean) ? r : undefined
    })

    // Assert
    expect([results.filter((r) => r!.ok).length, results.find((r) => !r!.ok)?.message]).toEqual([
      1,
      "Operação git em andamento; aguarde terminar",
    ])
  })

  it("alteração local no servidor: atualização recusada, com a explicação no estado", async () => {
    // Arrange
    process.env.QAFARM_FAKE_GIT = "dirty"
    h = await makeHarness({ emulators: 0 })

    // Act
    await h.command({ type: "project_update", branch: "develop" })
    const s = await h.tickUntil(opDone)

    // Assert
    expect([s.op?.status, s.op?.message?.includes("alterações locais"), s.branch, s.dirty?.length]).toEqual([
      "error",
      true,
      "main",
      1,
    ])
  })

  it("escolher uma branch mostra o que ela traria antes de atualizar", async () => {
    // Arrange
    h = await makeHarness({ emulators: 0 })

    // Act
    await h.command({ type: "project_preview", branch: "feature/exemplo" })
    const s = await state()

    // Assert
    expect([s?.incoming?.branch, s?.incoming?.commits.length, s?.branch]).toEqual([
      "feature/exemplo",
      3,
      "main",
    ])
  })
})
