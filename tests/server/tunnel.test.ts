import { describe, expect, it } from "vitest"

import { Tunnel } from "@/server/remote/tunnel"

const spec = {
  host: "h",
  user: "u",
  port: 22,
  slot: 1,
  groups: 2,
  appiumBasePort: 4800,
  keyFile: "k",
  knownHosts: "kh",
}

describe("túneis SSH do worker", () => {
  it("proxy de saída é um processo à parte só com o SOCKS reverso (não leva agente nem Appium)", () => {
    // Arrange
    const main = new Tunnel({ ...spec, mode: "forward" }, () => undefined)
    const proxy = new Tunnel({ ...spec, mode: "proxy" }, () => undefined)

    // Act
    const [a, b] = [main.args().join(" "), proxy.args().join(" ")]

    // Assert
    expect([
      a.includes("-R"),
      a.includes("-L 127.0.0.1:20100:127.0.0.1:7100"),
      b.includes("-R 127.0.0.1:7180"),
      b.includes("-L"),
    ]).toEqual([false, true, true, false])
  })
})
