import { newId } from "@/core/ids"
import { type GitOp, maskSecrets, type ProjectGitState } from "@/core/project-git"
import { writeJsonAtomic } from "@/core/store"
import type { ProjectGit } from "@/server/project-git"

/**
 * Git de UM projeto de testes (Robot ou GI-App-Test) para a página Projeto: estado local (sem rede), buscar
 * (fetch) e atualizar (troca de branch + fast-forward), uma operação por vez, com o log mascarado gravado em
 * `file` a cada segundo.
 */
export class ProjectGitManager {
  private op?: GitOp
  private preview?: string
  private state: Omit<ProjectGitState, "updatedAt" | "op"> = {}
  private lastStatus = 0
  private busy = false

  constructor(
    private readonly o: {
      label: string
      git: () => ProjectGit
      file: string
      secrets: () => Promise<string[]>
      /** serializa com o que mais lê a pasta do projeto (ex.: cópia para snapshot) */
      serialize: <T>(fn: () => Promise<T>) => Promise<T>
      log: (m: string) => void
      /** depois de atualizar com sucesso (catálogo novo etc.) */
      onUpdated: () => void
      /** motivo para recusar atualizar agora (ex.: casos rodando direto da pasta) */
      blockUpdate?: () => string | null
    },
  ) {}

  /** A cada minuto relê o estado local (branch, commits, alterações). */
  tick(): void {
    if (Date.now() - this.lastStatus > 60_000) void this.refresh()
  }

  async refresh(): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.lastStatus = Date.now()
    try {
      const git = this.o.git()
      const snap = await this.o.serialize(() => git.snapshot(this.preview))
      this.state = { ...this.state, ...snap, remoteUrl: await git.remoteUrl().catch(() => undefined), error: undefined }
    } catch (e) {
      this.state = { ...this.state, error: (e as Error).message }
    } finally {
      this.busy = false
    }
    await this.write()
  }

  async write(): Promise<void> {
    const secrets = await this.o.secrets().catch(() => [] as string[])
    const mask = (t: string) => maskSecrets(t, secrets).text
    const state: ProjectGitState = {
      ...this.state,
      updatedAt: new Date().toISOString(),
      op: this.op && { ...this.op, message: this.op.message && mask(this.op.message), log: this.op.log.map(mask) },
    }
    await writeJsonAtomic(this.o.file, state)
  }

  async showPreview(branch: string): Promise<{ ok: boolean; message: string }> {
    this.preview = branch
    await this.refresh()
    return { ok: true, message: `Mostrando o que a branch ${branch} traria` }
  }

  /** Busca (fetch) ou atualiza (troca de branch + fast-forward) em segundo plano; uma por vez. */
  start(kind: GitOp["kind"], branch?: string): { ok: boolean; message: string } {
    if (this.op?.status === "running") return { ok: false, message: "Operação git em andamento; aguarde terminar" }
    if (kind === "update") {
      const blocked = this.o.blockUpdate?.()
      if (blocked) return { ok: false, message: blocked }
    }
    const op: GitOp = { id: newId("git"), kind, branch, status: "running", startedAt: new Date().toISOString(), log: [] }
    this.op = op
    const log = (l: string) => {
      op.log.push(l)
      if (op.log.length > 300) op.log.splice(0, op.log.length - 300)
    }
    const timer = setInterval(() => void this.write(), 1000)
    this.o.log(`${this.o.label}: ${kind === "fetch" ? "buscando atualizações (fetch)" : `atualizando para ${branch}`}`)
    void (async () => {
      let ok = false
      try {
        const git = this.o.git()
        if (kind === "fetch") {
          await this.o.serialize(() => git.fetch(log))
          ok = true
          op.message = "Branches e commits do servidor git atualizados"
        } else {
          const r = await this.o.serialize(() => git.update(branch!, log))
          ok = r.ok
          op.message = r.message
        }
        if (ok) this.state = { ...this.state, fetchedAt: new Date().toISOString() }
      } catch (e) {
        op.message = (e as Error).message
        log(`✖ ${op.message}`)
      }
      clearInterval(timer)
      op.status = ok ? "ok" : "error"
      op.endedAt = new Date().toISOString()
      if (kind === "update" && ok) this.preview = undefined
      this.o.log(`${this.o.label}: ${op.status === "ok" ? "ok" : "falhou"} — ${op.message ?? ""}`)
      await this.refresh()
      if (kind === "update" && ok) this.o.onUpdated()
    })()
    return {
      ok: true,
      message: kind === "fetch" ? "Buscando atualizações do servidor git…" : `Atualizando o projeto para ${branch}…`,
    }
  }
}
