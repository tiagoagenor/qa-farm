import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { z } from "zod"

/** Grava JSON de forma atômica: escreve em arquivo temporário na mesma pasta e renomeia. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8")
  await fs.rename(tmp, file)
}

/**
 * Lê e valida JSON. Arquivo ausente, JSON inválido ou fora do schema → retorna `fallback`
 * (nunca lança), para que um arquivo corrompido não derrube o painel ou o runner.
 */
export async function readJson<T>(file: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch {
    return fallback
  }
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

/** Lista arquivos .json de uma pasta (sem recursão), ignorando temporários. */
export async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir)
    return names
      .filter((n) => n.endsWith(".json"))
      .sort()
      .map((n) => path.join(dir, n))
  } catch {
    return []
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
