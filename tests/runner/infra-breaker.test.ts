import { afterEach, describe, expect, it } from "vitest"

import { type Harness, makeHarness, queueInput } from "./harness"

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
})

describe("disjuntor no runner", () => {
  it("celular com 3 erros de infraestrutura seguidos para de receber casos em vez de consumir a fila", async () => {
    // Arrange
    h = await makeHarness({ emulators: 1 })
    await h.tickUntil(async () => (await h!.readyCount()) >= 1 || undefined, 30_000)
    const ids = await h.catalogIds((n) => n.includes("INFRA"))
    const qid = (
      await h.command({ type: "create_queue", input: { ...queueInput(ids), allowSameAccount: true } })
    ).data!.queueId as string
    const attempts = () =>
      h!.runner
        .snapshotForTests()
        .queues.find((q) => q.id === qid)!
        .items.flatMap((i) => i.attempts)
    await h.tickUntil(() => h!.logs.some((l) => l.includes("pausado por 5 min")) || undefined, 30_000)

    // Act: o celular continua pronto, mas pausado (a nota aparece no próximo ciclo de leitura dos celulares)
    const dev = await h.tickUntil(() => {
      const d = h!.runner.snapshotForTests().devices.find((x) => x.serial === "emulator-5554")
      return d?.note?.startsWith("Pausado") ? d : undefined
    }, 30_000)
    for (let i = 0; i < 30; i++) await h.runner.tick()

    // Assert
    expect([
      attempts().filter((a) => a.status !== "running").length,
      attempts().some((a) => a.status === "running"),
      dev?.note?.startsWith("Pausado: erros de infraestrutura seguidos"),
    ]).toEqual([3, false, true])
  })
})
