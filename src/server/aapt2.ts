import fsp from "node:fs/promises"
import path from "node:path"

import type { Config } from "@/core/config"

import { run } from "./exec"

export interface Aapt2 {
  /** Saída de `aapt2 dump badging`, ou null se não conseguiu ler o arquivo como APK. */
  badging(apk: string): Promise<string | null>
}

export function realAapt2(cfg: Config): Aapt2 {
  return {
    async badging(apk) {
      const r = await run(cfg.aapt2, ["dump", "badging", apk], { timeoutMs: 120_000 })
      return r.code === 0 && r.stdout.startsWith("package:") ? r.stdout : null
    },
  }
}

/** Fake: qualquer arquivo que comece com "PK" (zip) é tratado como o APK de exemplo. */
export function fakeAapt2(cfg: Config): Aapt2 {
  return {
    async badging(apk) {
      const fh = await fsp.open(apk, "r")
      const buf = Buffer.alloc(2)
      await fh.read(buf, 0, 2, 0)
      await fh.close()
      if (buf.toString("latin1") !== "PK") return null
      return fsp.readFile(path.join(cfg.repoRoot, "tests/fixtures/aapt2/badging.txt"), "utf8")
    },
  }
}
