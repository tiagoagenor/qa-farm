import { randomBytes } from "node:crypto"

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0")
}

/** Id ordenável por tempo: <prefixo>_YYYYMMDD-HHMMSS_<aleatório>. */
export function newId(prefix: string, now: Date = new Date()): string {
  const ts =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `${prefix}_${ts}_${randomBytes(3).toString("hex")}`
}

/** Aceita apenas ids gerados por newId (evita caminhos arbitrários vindos da URL). */
export function isSafeId(id: string): boolean {
  return /^[a-z]+_\d{8}-\d{6}_[0-9a-f]{6}$/.test(id)
}
