import { describe, expect, it } from "vitest"

import { localPorts } from "@/core/machines"
import {
  ClientMessageSchema,
  decodeVideoPacket,
  encodeVideoPacket,
  ScreenSessions,
} from "@/core/screen-protocol"
import { Tunnel } from "@/server/remote/tunnel"

describe("pacotes de vídeo", () => {
  it("ida e volta preserva tipo, quadro-chave, pts e dados", () => {
    // Arrange
    const pkts = [
      { type: "configuration" as const, data: new Uint8Array([1, 2, 3]) },
      { type: "data" as const, keyframe: true, pts: BigInt(123456789), data: new Uint8Array([9]) },
      { type: "data" as const, keyframe: false, pts: BigInt(5), data: new Uint8Array([]) },
    ]

    // Act
    const out = pkts.map((p) => decodeVideoPacket(encodeVideoPacket(p)))

    // Assert
    expect(out.map((p) => [p?.type, p?.keyframe, p?.pts, [...(p?.data ?? [])]])).toEqual([
      ["configuration", undefined, undefined, [1, 2, 3]],
      ["data", true, BigInt(123456789), [9]],
      ["data", false, BigInt(5), []],
    ])
  })

  it("pacote curto ou de tipo desconhecido é ignorado", () => {
    // Arrange
    const bad = [new Uint8Array([0, 1]), new Uint8Array(12).fill(7)]

    // Act
    const out = bad.map(decodeVideoPacket)

    // Assert
    expect(out).toEqual([null, null])
  })
})

describe("mensagens do navegador", () => {
  it.each([
    [{ t: "touch", action: "down", x: 0.5, y: 0.2 }, true],
    [{ t: "key", key: "home" }, true],
    [{ t: "touch", action: "down", x: 2, y: 0 }, false],
    [{ t: "key", key: "power" }, false],
    [{ t: "shell", cmd: "rm -rf /" }, false],
  ])("%o válida = %s", (msg, ok) => {
    // Arrange
    const input = msg

    // Act
    const r = ClientMessageSchema.safeParse(input)

    // Assert
    expect(r.success).toBe(ok)
  })
})

describe("limite de celulares ao vivo", () => {
  it("o 4º celular é recusado com limite 3; outro espectador do mesmo celular não conta", () => {
    // Arrange
    const s = new ScreenSessions(() => 3)
    for (const d of ["a", "b", "c"]) s.join(d, `v-${d}`)

    // Act
    const out = [s.canJoin("d").ok, s.canJoin("a").ok, s.join("a", "v-a2"), s.used]

    // Assert
    expect(out).toEqual([false, true, false, 3])
  })

  it("sair o último espectador libera a vaga; 0 desliga", () => {
    // Arrange
    let max = 1
    const s = new ScreenSessions(() => max)
    s.join("a", "v1")
    s.join("a", "v2")

    // Act
    const first = s.leave("a", "v1")
    const last = s.leave("a", "v2")
    const freed = s.canJoin("b").ok
    max = 0
    const off = s.canJoin("b")

    // Assert
    expect([first, last, freed, off.ok, !off.ok && off.reason.includes("desligada")]).toEqual([
      false,
      true,
      true,
      false,
      true,
    ])
  })

  it("um controlador por celular: quem pede tira de quem tinha; sair devolve", () => {
    // Arrange
    const s = new ScreenSessions(() => 3)
    s.join("a", "v1")
    s.join("a", "v2")

    // Act
    const c1 = s.setControl("a", "v1", true)
    const c2 = s.setControl("a", "v2", true)
    s.leave("a", "v2")

    // Assert
    expect([c1, c2, s.controller("a")]).toEqual(["v1", "v2", null])
  })
})

describe("túnel do worker leva o adb server (tela ao vivo)", () => {
  it("porta do adb não colide com agente nem Appiums e entra no ssh -L", () => {
    // Arrange
    const t = new Tunnel(
      {
        host: "h",
        user: "u",
        port: 22,
        slot: 1,
        groups: 4,
        appiumBasePort: 4800,
        keyFile: "k",
        knownHosts: "kh",
      },
      () => undefined,
    )
    const p = localPorts(1)

    // Act
    const args = t.args().join(" ")

    // Assert
    expect([
      p.adb,
      [p.agent, ...[1, 2, 3, 4].map(p.appium)].includes(p.adb),
      args.includes(`-L 127.0.0.1:${p.adb}:127.0.0.1:5037`),
    ]).toEqual([20190, false, true])
  })
})
