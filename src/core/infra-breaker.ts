import type { AttemptStatus } from "./types"

// Disjuntor por celular: N erros de infraestrutura SEGUIDOS no mesmo celular (ou vaga do BrowserStack) =
// algo quebrado nele (sem rede, sessão que não abre…) → pausa por um tempo em vez de consumir a fila caso a caso
// em segundos. Um resultado de verdade (passou/falhou/timeout) zera a contagem.

export const INFRA_BREAKER_THRESHOLD = 3
export const INFRA_BREAKER_COOLDOWN_MS = 5 * 60_000

export class InfraBreaker {
  private streak = new Map<string, number>()
  private until = new Map<string, number>()

  constructor(
    private readonly threshold = INFRA_BREAKER_THRESHOLD,
    private readonly cooldownMs = INFRA_BREAKER_COOLDOWN_MS,
  ) {}

  /** Registra o fim de uma tentativa; `tripped` = acabou de pausar o celular até `until`. */
  record(
    device: string,
    status: AttemptStatus,
    now = Date.now(),
  ): { tripped: boolean; until?: number; streak: number } {
    if (status === "canceled" || status === "running")
      return { tripped: false, streak: this.streak.get(device) ?? 0 }
    if (status !== "infra_error") {
      this.streak.delete(device)
      return { tripped: false, streak: 0 }
    }
    const n = (this.streak.get(device) ?? 0) + 1
    if (n < this.threshold) {
      this.streak.set(device, n)
      return { tripped: false, streak: n }
    }
    this.streak.delete(device)
    const until = now + this.cooldownMs
    this.until.set(device, until)
    return { tripped: true, until, streak: n }
  }

  /** Até quando o celular está pausado (null = livre). */
  blockedUntil(device: string, now = Date.now()): number | null {
    const u = this.until.get(device)
    if (u === undefined) return null
    if (u <= now) {
      this.until.delete(device)
      return null
    }
    return u
  }

  clear(device: string): void {
    this.streak.delete(device)
    this.until.delete(device)
  }
}
