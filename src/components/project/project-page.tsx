"use client"

import { Download, GitBranch, Loader2, RefreshCw } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { EmptyState, PageHeader } from "@/components/panel/page-header"
import { StatusBadge } from "@/components/panel/status-badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ProjectGitState } from "@/core/project-git"
import { usePoll } from "@/hooks/use-poll"
import { sendCommand } from "@/lib/client"
import { formatDateTime } from "@/lib/format"

import { CodeBrowser } from "./code-browser"

interface ProjectDto {
  state: ProjectGitState | null
  runnerAlive: boolean
}

const short = (h?: string) => (h ? h.slice(0, 7) : "—")

type GitCommand = { type: "project_fetch" } | { type: "project_update"; branch: string }
/** Operação pedida nesta tela e ainda não terminada (`sinceOpId` = a última que já existia antes do clique). */
interface Pending {
  kind: "fetch" | "update"
  branch?: string
  sinceOpId?: string
}

/** Página Projeto: branch/commit do projeto Robot no servidor, atualizar (pull) escolhendo a branch e ver o código. */
export function ProjectPage() {
  const [pending, setPending] = useState<Pending | null>(null)
  const [fast, setFast] = useState(false)
  const { data, reload } = usePoll<ProjectDto>("/api/project", fast ? 1000 : 10_000)
  const st = data?.state
  const op = st?.op
  const running = op?.status === "running"
  const busy = !!pending || running
  useEffect(() => setFast(busy), [busy])
  // a operação desta tela é a primeira DEPOIS do clique; ela terminando → um único aviso (sucesso ou erro)
  const current = pending && op && op.id !== pending.sinceOpId ? op : null
  useEffect(() => {
    if (!pending || !current || current.status === "running") return
    if (current.status === "ok")
      toast.success(
        current.kind === "update"
          ? `Projeto atualizado — ${current.message ?? ""}`
          : (current.message ?? "Concluído"),
      )
    else toast.error(current.message ?? "A operação falhou")
    setPending(null)
  }, [pending, current])

  async function start(cmd: GitCommand) {
    setPending({
      kind: cmd.type === "project_fetch" ? "fetch" : "update",
      branch: "branch" in cmd ? cmd.branch : undefined,
      sinceOpId: op?.id,
    })
    // o runner só confirma que começou: o aviso de sucesso vem quando terminar de verdade
    const r = await sendCommand(cmd, { quiet: true })
    if (!r?.ok) setPending(null)
    void reload()
  }

  return (
    <div>
      <PageHeader
        title="Projeto"
        description={
          <>
            Código do projeto Robot usado nos testes
            {st?.remoteUrl ? (
              <>
                {" "}
                · <span className="font-mono">{st.remoteUrl}</span>
              </>
            ) : null}
          </>
        }
      />
      {!data ? (
        <p className="text-muted-foreground text-sm">Carregando…</p>
      ) : !st ? (
        <EmptyState title="Ainda sem informações do projeto">
          O runner lê o git do projeto em alguns segundos.
        </EmptyState>
      ) : (
        <Tabs defaultValue="resumo">
          <TabsList>
            <TabsTrigger value="resumo">Resumo e atualização</TabsTrigger>
            <TabsTrigger value="codigo" data-testid="tab-code">
              Código
            </TabsTrigger>
          </TabsList>
          <TabsContent value="resumo" className="grid gap-4 pt-2">
            <Summary st={st} />
            <UpdateCard
              st={st}
              busy={busy}
              pending={pending}
              onStart={start}
              onChanged={() => void reload()}
            />
            {pending && !current ? <OpStarting pending={pending} /> : op && <OpLog op={op} />}
            <Commits title="Últimos commits no servidor" commits={st.commits ?? []} testid="commits" />
          </TabsContent>
          <TabsContent value="codigo" className="pt-2">
            <CodeBrowser version={st.head?.hash ?? ""} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

function Summary({ st }: { st: ProjectGitState }) {
  return (
    <Card className="gap-3 py-5" data-testid="project-summary">
      <CardHeader className="px-5">
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="size-5" />
          <span data-testid="project-branch">{st.branch ?? "(sem branch)"}</span>
          {!!st.behind && <StatusBadge label={`${st.behind} commit(s) atrás`} tone="warn" />}
          {!!st.ahead && <StatusBadge label={`${st.ahead} à frente`} tone="info" />}
          {!st.behind && !st.ahead && st.upstream && <StatusBadge label="em dia" tone="ok" />}
        </CardTitle>
        <CardDescription>
          {st.head ? (
            <>
              <span className="font-mono">{short(st.head.hash)}</span> · {st.head.subject} · {st.head.author}{" "}
              · {formatDateTime(st.head.date)}
            </>
          ) : (
            "sem commits"
          )}
          {st.fetchedAt && <> · última busca no servidor git: {formatDateTime(st.fetchedAt)}</>}
        </CardDescription>
      </CardHeader>
      {(!!st.dirty?.length || st.error) && (
        <CardContent className="grid gap-2 px-5 text-sm">
          {st.error && <p className="text-red-700 dark:text-red-400">{st.error}</p>}
          {!!st.dirty?.length && (
            <div
              className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
              data-testid="project-dirty"
            >
              <p className="mb-1 font-medium">
                {st.dirty.length} arquivo(s) alterado(s) no servidor, fora do git. A atualização é recusada
                enquanto houver alterações em arquivos do projeto (nada é descartado automaticamente).
              </p>
              <ul className="font-mono">
                {st.dirty.slice(0, 15).map((d) => (
                  <li key={d.path}>
                    {d.code} {d.path}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}

function UpdateCard({
  st,
  busy,
  pending,
  onStart,
  onChanged,
}: {
  st: ProjectGitState
  busy: boolean
  pending: Pending | null
  onStart: (cmd: GitCommand) => Promise<void>
  onChanged: () => void
}) {
  const running = (kind: Pending["kind"]) =>
    (pending?.kind ?? (st.op?.status === "running" ? st.op.kind : null)) === kind
  const [branch, setBranch] = useState<string>("")
  const [confirm, setConfirm] = useState(false)
  const selected = branch || st.branch || ""
  const incoming = st.incoming?.branch === selected ? st.incoming : null
  const branches = st.remoteBranches ?? []
  const trackedDirty = (st.dirty ?? []).some((d) => d.code !== "??")

  async function pick(b: string) {
    setBranch(b)
    await sendCommand({ type: "project_preview", branch: b }, { quiet: true })
    onChanged()
  }

  return (
    <Card className="gap-3 py-5" data-testid="project-update">
      <CardHeader className="px-5">
        <CardTitle>Atualizar o projeto (pull)</CardTitle>
        <CardDescription>
          Busca as novidades do servidor git, troca para a branch escolhida e avança só se não houver conflito
          (fast-forward). Filas em andamento continuam com o código de quando foram criadas; as novas usam o
          atualizado.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 px-5 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selected} onValueChange={(v) => void pick(v)} disabled={busy || !branches.length}>
            <SelectTrigger className="w-80" data-testid="branch-select">
              <SelectValue
                placeholder={
                  branches.length ? "Escolha a branch" : "Clique em Buscar para listar as branches"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {branches.map((b) => (
                <SelectItem key={b.name} value={b.name}>
                  {b.name}
                  {b.name === st.branch ? " (atual)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void onStart({ type: "project_fetch" })}
            data-testid="project-fetch"
          >
            <RefreshCw className={running("fetch") ? "animate-spin" : ""} />{" "}
            {running("fetch") ? "Buscando…" : "Buscar novidades"}
          </Button>
          <Button
            disabled={busy || !selected || trackedDirty}
            onClick={() => setConfirm(true)}
            data-testid="project-pull"
          >
            {running("update") ? <Loader2 className="animate-spin" /> : <Download />}{" "}
            {running("update") ? "Atualizando…" : "Atualizar"}
          </Button>
        </div>
        {incoming && (
          <div className="text-xs" data-testid="project-incoming">
            {incoming.commits.length ? (
              <>
                <p className="mb-1 font-medium">
                  {selected} traria {incoming.commits.length} commit(s) e {incoming.files.length} arquivo(s)
                  alterado(s):
                </p>
                <ul className="text-muted-foreground max-h-40 overflow-auto font-mono">
                  {incoming.commits.slice(0, 20).map((c) => (
                    <li key={c.hash}>
                      {short(c.hash)} {c.subject} — {c.author}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-muted-foreground">Nada novo em {selected} (desde a última busca).</p>
            )}
          </div>
        )}
      </CardContent>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Atualizar o projeto para {selected}?</AlertDialogTitle>
            <AlertDialogDescription>
              {selected !== st.branch ? `Troca de ${st.branch ?? "(sem branch)"} para ${selected} e a` : "A"}
              tualiza com o que está no servidor git. O catálogo de testes é refeito em seguida. Filas em
              andamento não mudam.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void onStart({ type: "project_update", branch: selected })}
              data-testid="project-pull-confirm"
            >
              Atualizar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

/** Logo depois do clique, até o runner registrar a operação: mostra que começou (sem esperar o próximo ciclo). */
function OpStarting({ pending }: { pending: Pending }) {
  return (
    <Card className="gap-2 py-4" data-testid="project-op" data-status="running">
      <CardHeader className="px-5">
        <CardTitle className="flex items-center gap-2 text-base">
          {pending.kind === "fetch" ? "Buscar novidades" : `Atualizar para ${pending.branch}`}{" "}
          <StatusBadge label="iniciando…" tone="info" />
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5">
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="size-3.5 animate-spin" /> Enviando para o servidor…
        </p>
      </CardContent>
    </Card>
  )
}

function OpLog({ op }: { op: NonNullable<ProjectGitState["op"]> }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [op.log.length])
  const tone = op.status === "ok" ? "ok" : op.status === "error" ? "fail" : "info"
  const label = op.status === "running" ? "em andamento" : op.status === "ok" ? "concluído" : "falhou"
  return (
    <Card className="gap-2 py-4" data-testid="project-op" data-status={op.status}>
      <CardHeader className="px-5">
        <CardTitle className="flex items-center gap-2 text-base">
          {op.kind === "fetch" ? "Buscar novidades" : `Atualizar para ${op.branch}`}{" "}
          {op.status === "running" && <Loader2 className="size-4 animate-spin text-sky-600" />}
          <StatusBadge label={label} tone={tone} />
          <span className="text-muted-foreground text-xs font-normal">{formatDateTime(op.startedAt)}</span>
        </CardTitle>
        {op.message && (
          <CardDescription
            className={op.status === "error" ? "text-red-700 dark:text-red-400" : ""}
            data-testid="project-op-message"
          >
            {op.message}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="px-5">
        <pre
          ref={ref}
          className="bg-muted max-h-56 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap"
        >
          {op.log.join("\n") || "…"}
        </pre>
      </CardContent>
    </Card>
  )
}

function Commits({
  title,
  commits,
  testid,
}: {
  title: string
  commits: NonNullable<ProjectGitState["commits"]>
  testid: string
}) {
  return (
    <Card className="gap-2 py-4" data-testid={testid}>
      <CardHeader className="px-5">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-5">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">Commit</TableHead>
              <TableHead>Mensagem</TableHead>
              <TableHead className="w-40">Autor</TableHead>
              <TableHead className="w-40">Data</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {commits.map((c) => (
              <TableRow key={c.hash}>
                <TableCell className="font-mono text-xs">{short(c.hash)}</TableCell>
                <TableCell className="text-xs">{c.subject}</TableCell>
                <TableCell className="text-xs">{c.author}</TableCell>
                <TableCell className="text-xs">{formatDateTime(c.date)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
