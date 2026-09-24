import { createHash } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

import { newId } from "@/core/ids"
import { apkProblems, parseBadging } from "@/core/parsers/aapt2"
import type { DataPaths } from "@/core/paths"
import { readJson, writeJsonAtomic } from "@/core/store"
import { type AppMeta, AppMetaSchema } from "@/core/types"
import type { Aapt2 } from "@/server/aapt2"

export const MAX_APK_BYTES = 400 * 1024 * 1024

export type UploadResult = { ok: true; app: AppMeta } | { ok: false; status: number; error: string; existingId?: string }

class TooLarge extends Error {}

function sanitizeName(name: string): string {
  const base = path.basename(name || "app.apk").replace(/[^\w.\-() ]+/g, "_")
  return base.slice(0, 200) || "app.apk"
}

/** Recebe o APK em streaming (sem carregar na memória), valida e publica em apps/<id>/. */
export async function receiveApk(
  body: ReadableStream<Uint8Array>,
  originalName: string,
  deps: { p: DataPaths; aapt2: Aapt2; maxBytes?: number; now?: Date },
): Promise<UploadResult> {
  const { p, aapt2 } = deps
  const max = deps.maxBytes ?? MAX_APK_BYTES
  const id = newId("app", deps.now)
  await fsp.mkdir(p.uploads, { recursive: true })
  const part = path.join(p.uploads, `${id}.part`)
  const md5 = createHash("md5")
  let size = 0
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length
      if (size > max) return cb(new TooLarge())
      md5.update(chunk)
      cb(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(body as import("node:stream/web").ReadableStream), meter, fs.createWriteStream(part))
  } catch (e) {
    await fsp.rm(part, { force: true })
    if (e instanceof TooLarge) return { ok: false, status: 413, error: `Arquivo maior que ${Math.round(max / 1024 / 1024)} MB` }
    return { ok: false, status: 400, error: "Upload interrompido" }
  }
  try {
    if (size === 0) return { ok: false, status: 400, error: "Arquivo vazio" }
    const digest = md5.digest("hex")
    const existing = await findByMd5(p, digest)
    if (existing) return { ok: false, status: 409, error: "Este APK já foi enviado", existingId: existing.id }
    const badging = await aapt2.badging(part)
    const info = badging ? parseBadging(badging) : null
    if (!info) return { ok: false, status: 422, error: "Arquivo não é um APK válido" }
    const problems = apkProblems(info)
    if (problems.length) return { ok: false, status: 422, error: problems.join("; ") }
    const meta: AppMeta = {
      id,
      originalName: sanitizeName(originalName),
      package: info.package,
      versionName: info.versionName,
      versionCode: info.versionCode,
      minSdk: info.minSdk,
      abis: info.abis,
      launchableActivity: info.launchableActivity,
      md5: digest,
      size,
      uploadedAt: (deps.now ?? new Date()).toISOString(),
    }
    await fsp.mkdir(p.app(id), { recursive: true })
    await fsp.rename(part, p.appApk(id))
    await writeJsonAtomic(p.appMeta(id), meta) // por último: só então o app "existe"
    return { ok: true, app: meta }
  } finally {
    await fsp.rm(part, { force: true })
  }
}

async function findByMd5(p: DataPaths, md5: string): Promise<AppMeta | null> {
  const dirs = await fsp.readdir(p.apps).catch(() => [] as string[])
  for (const d of dirs) {
    const m = await readJson(p.appMeta(d), AppMetaSchema.nullable(), null)
    if (m?.md5 === md5) return m
  }
  return null
}
