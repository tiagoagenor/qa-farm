import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { dataPaths } from "@/core/paths"
import type { Aapt2 } from "@/server/aapt2"
import { receiveApk } from "@/server/web/upload"

const BADGING = path.resolve(__dirname, "../fixtures/aapt2/badging.txt")
const ARM_ONLY = path.resolve(__dirname, "../fixtures/aapt2/arm-only.txt")

let dir: string
let p: ReturnType<typeof dataPaths>
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "qafarm-upload-"))
  p = dataPaths(dir)
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const stream = (bytes: string | Buffer) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes))
      c.close()
    },
  })

const aaptFrom = (file: string | null): Aapt2 => ({
  badging: async () => (file ? fs.readFile(file, "utf8") : null),
})

describe("receiveApk", () => {
  it("publica o APK válido com os dados do manifesto", async () => {
    // Arrange
    const body = stream("PK-conteudo-do-apk")

    // Act
    const r = await receiveApk(body, "app-hml-release-7.26.0.apk", { p, aapt2: aaptFrom(BADGING) })

    // Assert
    expect(r.ok && [r.app.package, r.app.versionCode, r.app.originalName, r.app.size]).toEqual([
      "com.exemplo.App.hml",
      5528,
      "app-hml-release-7.26.0.apk",
      18,
    ])
  })

  it("grava app.apk e meta.json e não deixa o arquivo temporário", async () => {
    // Arrange
    const body = stream("PK-conteudo")

    // Act
    const r = await receiveApk(body, "a.apk", { p, aapt2: aaptFrom(BADGING) })

    // Assert
    const id = r.ok ? r.app.id : ""
    const files = [await fs.readdir(p.app(id)), await fs.readdir(p.uploads)]
    expect(files).toEqual([["app.apk", "meta.json"], []])
  })

  it("recusa arquivo que não é APK", async () => {
    // Arrange
    const body = stream("não sou um apk")

    // Act
    const r = await receiveApk(body, "x.txt", { p, aapt2: aaptFrom(null) })

    // Assert
    expect(r).toMatchObject({ ok: false, status: 422, error: "Arquivo não é um APK válido" })
  })

  it("recusa APK sem código x86_64", async () => {
    // Arrange
    const body = stream("PK-arm")

    // Act
    const r = await receiveApk(body, "arm.apk", { p, aapt2: aaptFrom(ARM_ONLY) })

    // Assert
    expect(r.ok ? "" : r.error).toMatch(/x86_64/)
  })

  it("recusa o mesmo APK enviado duas vezes", async () => {
    // Arrange
    await receiveApk(stream("PK-igual"), "a.apk", { p, aapt2: aaptFrom(BADGING) })

    // Act
    const r = await receiveApk(stream("PK-igual"), "b.apk", { p, aapt2: aaptFrom(BADGING) })

    // Assert
    expect(r).toMatchObject({ ok: false, status: 409, error: "Este APK já foi enviado" })
  })

  it("recusa arquivo maior que o limite e apaga o parcial", async () => {
    // Arrange
    const body = stream(Buffer.alloc(2048, 1))

    // Act
    const r = await receiveApk(body, "grande.apk", { p, aapt2: aaptFrom(BADGING), maxBytes: 1024 })

    // Assert
    expect([r.ok ? 0 : r.status, await fs.readdir(p.uploads)]).toEqual([413, []])
  })

  it("remove caminhos do nome original", async () => {
    // Arrange
    const body = stream("PK-nome")

    // Act
    const r = await receiveApk(body, "../../etc/passwd.apk", { p, aapt2: aaptFrom(BADGING) })

    // Assert
    expect(r.ok && r.app.originalName).toBe("passwd.apk")
  })
})
