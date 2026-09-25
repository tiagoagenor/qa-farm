import { z } from "zod"

// Projeto Robot (git): estado para a página Projeto, validação de branch, parsers da saída do git e
// regras do visualizador de código (o que esconder e como mascarar segredos). Funções puras.

/** Nome de branch seguro para argv do git (sem opção disfarçada, sem sintaxe de revisão). */
export const BranchNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)[A-Za-z0-9._/-]+$/, "nome de branch inválido")
  .refine(
    (b) => !b.endsWith(".lock") && !b.endsWith("/") && !b.endsWith(".") && !b.startsWith("/") && b !== "HEAD",
    "nome de branch inválido",
  )

export const CommitSchema = z.object({
  hash: z.string(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
})
export type Commit = z.infer<typeof CommitSchema>

export const RemoteBranchSchema = z.object({
  name: z.string(),
  hash: z.string(),
  date: z.string(),
  subject: z.string(),
})
export type RemoteBranch = z.infer<typeof RemoteBranchSchema>

export const GitOpSchema = z.object({
  id: z.string(),
  kind: z.enum(["fetch", "update"]),
  branch: z.string().optional(),
  status: z.enum(["running", "ok", "error"]),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  message: z.string().optional(),
  log: z.array(z.string()),
})
export type GitOp = z.infer<typeof GitOpSchema>

/** Leitura local do repositório (sem rede). */
export const GitSnapshotSchema = z.object({
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number(),
  behind: z.number(),
  head: CommitSchema.nullable(),
  dirty: z.array(z.object({ code: z.string(), path: z.string() })),
  commits: z.array(CommitSchema),
  remoteBranches: z.array(RemoteBranchSchema),
  /** o que a branch selecionada/atual traria (commits e arquivos) */
  incoming: z
    .object({
      branch: z.string(),
      commits: z.array(CommitSchema),
      files: z.array(z.object({ status: z.string(), path: z.string() })),
    })
    .nullable(),
})
export type GitSnapshot = z.infer<typeof GitSnapshotSchema>

/** state/project-git.json — gravado só pelo runner. */
export const ProjectGitStateSchema = GitSnapshotSchema.partial().extend({
  updatedAt: z.string(),
  fetchedAt: z.string().optional(),
  remoteUrl: z.string().optional(),
  op: GitOpSchema.optional(),
  error: z.string().optional(),
})
export type ProjectGitState = z.infer<typeof ProjectGitStateSchema>

// ------------------------------------------------------------------ parsers ---
export const LOG_FORMAT = "%H%x1f%s%x1f%an%x1f%aI%x1e"
export const REF_FORMAT =
  "%(refname:short)%1f%(objectname)%1f%(committerdate:iso-strict)%1f%(contents:subject)%1e"

export function parseLog(out: string): Commit[] {
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, subject, author, date] = r.split("\x1f")
      return { hash, subject: subject ?? "", author: author ?? "", date: date ?? "" }
    })
}

/** `for-each-ref refs/remotes/origin` → branches remotas sem o prefixo "origin/" (ignora origin/HEAD). */
export function parseRefs(out: string, remote = "origin"): RemoteBranch[] {
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [ref, hash, date, subject] = r.split("\x1f")
      return {
        name: ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref,
        hash,
        date: date ?? "",
        subject: subject ?? "",
      }
    })
    .filter((b) => b.name !== "HEAD" && b.name !== remote)
    .sort((a, b) => b.date.localeCompare(a.date))
}

/** `status --porcelain=v1 -b` → branch, upstream, ahead/behind e arquivos alterados. */
export function parseStatus(out: string): {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  dirty: Array<{ code: string; path: string }>
} {
  const lines = out.split("\n").filter((l) => l.length > 0)
  let branch: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const head = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : ""
  if (head && !head.startsWith("HEAD (no branch)")) {
    // "main...origin/main [ahead 1, behind 2]" | "main" | "No commits yet on main"
    const [refs, counts = ""] = head.replace(/^No commits yet on /, "").split(" [")
    const [b, up] = refs.split("...")
    branch = b || null
    upstream = up || null
    ahead = Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0)
    behind = Number(/behind (\d+)/.exec(counts)?.[1] ?? 0)
  }
  return {
    branch,
    upstream,
    ahead,
    behind,
    dirty: lines.map((l) => ({ code: l.slice(0, 2).trim() || "?", path: l.slice(3) })),
  }
}

/** `diff --name-status` → [{status, path}] */
export function parseNameStatus(out: string): Array<{ status: string; path: string }> {
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split("\t")
      return { status: status.slice(0, 1), path: rest.at(-1) ?? "" }
    })
}

// ------------------------------------------------------- visualizador de código ---
const BLOCKED_SEGMENT = /^(\.git|\.venv|venv|__pycache__|node_modules|results|logs)$/i
const BLOCKED_FILE = /(\.(apk|pem|p12|jks|keystore|key)$)|(^id_(rsa|ed25519|ecdsa|dsa))/i

/** Caminho que o visualizador nunca mostra (nem lista). */
export function isBlockedPath(rel: string): boolean {
  return rel
    .split("/")
    .filter(Boolean)
    .some((seg) => BLOCKED_SEGMENT.test(seg) || BLOCKED_FILE.test(seg))
}

/** Arquivo de ambiente do projeto (valores são segredos: senhas, e-mails de contas). */
export function isEnvFile(name: string): boolean {
  return /^\.env/i.test(name)
}

/** Valores de um arquivo KEY=VALOR (ignora comentários e valores curtos demais para mascarar com segurança). */
export function envValues(text: string): string[] {
  const out: string[] = []
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const v = m[1].trim().replace(/^(['"])(.*)\1$/, "$2")
    if (v.length >= 6) out.push(v)
  }
  return out
}

export const MASK = "••••"
const SECRET_NAME = String.raw`(?:password|passwd|senha|token|secret|api[_-]?key|access[_-]?key|accesskey)`
// nome sensível + separador (=, :, ou 2+ espaços do Robot) + valor literal (referências ${var} ficam visíveis)
const SECRET_ASSIGN = new RegExp(
  String.raw`(${SECRET_NAME}[A-Za-z0-9_]*\}?["']?\s*(?:=|:|\s{2,})\s*["']?)(?![$@&%]\{)([^\s"',}]{3,})`,
  "gi",
)

/** Mascara segredos conhecidos (valores exatos) e atribuições com nome sensível. */
export function maskSecrets(text: string, secrets: string[]): { text: string; masked: boolean } {
  let out = text
  for (const s of [...new Set(secrets)].filter((x) => x.length >= 6).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join(MASK)
  }
  out = out.replace(SECRET_ASSIGN, (_m, pre: string, val: string) =>
    val === MASK ? `${pre}${val}` : `${pre}${MASK}`,
  )
  return { text: out, masked: out !== text }
}
