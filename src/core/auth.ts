// Sessão por cookie assinado com HMAC-SHA256. Usa apenas Web Crypto (funciona no Node e no middleware).

export const SESSION_COOKIE = "qafarm_session"
export const SESSION_TTL_SEC = 7 * 24 * 3600

const enc = new TextEncoder()

function toB64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ""
  for (const b of arr) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  return toB64Url(await crypto.subtle.sign("HMAC", key, enc.encode(data)))
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Token: "<expiraEmSegundos>.<assinatura>". */
export async function createSessionToken(secret: string, nowSec: number = Math.floor(Date.now() / 1000)): Promise<string> {
  const exp = String(nowSec + SESSION_TTL_SEC)
  return `${exp}.${await hmac(secret, `qafarm:${exp}`)}`
}

export async function verifySessionToken(
  secret: string,
  token: string | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!secret || !token) return false
  const [exp, sig] = token.split(".")
  if (!exp || !sig || !/^\d+$/.test(exp)) return false
  if (Number(exp) < nowSec) return false
  return timingSafeEqual(sig, await hmac(secret, `qafarm:${exp}`))
}

/** Compara senhas sem vazar tempo (via HMAC dos dois lados). */
export async function passwordMatches(secret: string, expected: string, given: string): Promise<boolean> {
  if (!expected) return false
  const [a, b] = await Promise.all([hmac(secret || "pw", expected), hmac(secret || "pw", given)])
  return timingSafeEqual(a, b)
}
