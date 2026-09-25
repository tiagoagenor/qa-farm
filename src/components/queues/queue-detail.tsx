"use client"

import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns3,
  ExternalLink,
  FileCode2,
  Folder,
  FolderOpen,
  FolderTree,
  List,
  Pause,
  Play,
  RotateCcw,
  Square,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Fragment, useMemo, useState } from "react"

import type { Item, ItemStatus, Queue } from "@/core/types"
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { ResizableHead } from "@/components/panel/resizable-head"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLiveNow } from "@/hooks/use-live-now"
import { useColumnPrefs } from "@/hooks/use-column-prefs"
import { usePoll } from "@/hooks/use-poll"
import { sendCommand } from "@/lib/client"
import {
  durationBetween,
  formatDateTime,
  formatDuration,
  formatFactor,
  ITEM_STATUS,
  QUEUE_STATUS,
  RETRY_OPTIONS,
  runFileUrl,
  WAIT_FACTORS,
} from "@/lib/format"
import { massaLabel } from "@/core/massa"
import { queueElapsedSec, RETRYABLE_ITEM_STATUSES } from "@/core/queue-logic"
import { allGroupKeys, buildTreeRows, type TreeRow } from "@/lib/catalog-tree"
import { type ColumnDef, visibleColumns } from "@/lib/table-columns"
import { type GroupStats, groupStats, type QueueTreeEntry, queueTreeEntries } from "@/lib/queue-tree"

import { ItemSheet } from "./item-sheet"
import { DeleteQueueButton, elapsedRange, ResultBar } from "./queue-list"
import type { QueueDetailDto } from "./types"

const TABS: Array<{ value: string; label: string; match: (s: ItemStatus) => boolean }> = [
  { value: "all", label: "Todos", match: () => true },
  {
    value: "fail",
    label: "Falhas",
    match: (s) => ["failed", "timeout", "infra_error", "config_error"].includes(s),
  },
  { value: "running", label: "Rodando", match: (s) => s === "running" },
  { value: "queued", label: "Na fila", match: (s) => s === "queued" },
  { value: "passed", label: "Passou", match: (s) => s === "passed" },
]

function Stat({
  label,
  value,
  tone,
  testId,
}: {
  label: string
  value: React.ReactNode
  tone?: string
  testId?: string
}) {
  return (
    <Card className="py-3">
      <CardContent className="px-4">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className={`text-2xl font-semibold tabular-nums ${tone ?? ""}`} data-testid={testId}>
          {value}
        </p>
      </CardContent>
    </Card>
  )
}

type ItemColumnKey =
  "num" | "status" | "caso" | "celular" | "massa" | "duracao" | "tent" | "erro" | "print" | "logs" | "acoes"

const ITEM_COLUMNS: ColumnDef<ItemColumnKey>[] = [
  { key: "num", label: "#", width: 56 },
  { key: "status", label: "Status", width: 150 },
  { key: "caso", label: "Caso", width: 340, hideable: false },
  { key: "celular", label: "Celular", width: 140 },
  { key: "massa", label: "Massa", width: 230 },
  { key: "duracao", label: "Duração", width: 100, align: "right" },
  { key: "tent", label: "Tent.", width: 70, align: "center" },
  { key: "erro", label: "Erro", width: 320 },
  { key: "print", label: "Print", width: 70 },
  { key: "logs", label: "Logs", width: 110 },
  { key: "acoes", label: "", width: 52, hideable: false, resizable: false },
]

function GroupRow({
  row,
  open,
  stats,
  colSpan,
  onToggle,
}: {
  colSpan: number
  row: Extract<TreeRow<QueueTreeEntry>, { kind: "folder" | "file" }>
  open: boolean
  stats: GroupStats
  onToggle: () => void
}) {
  const Icon = row.kind === "file" ? FileCode2 : open ? FolderOpen : Folder
  return (
    <TableRow
      className={`bg-muted/40 hover:bg-muted/60 cursor-pointer ${stats.failed ? "bg-red-500/5" : ""}`}
      onClick={onToggle}
      data-testid={row.kind === "folder" ? "queue-folder" : "queue-file"}
      data-failed={stats.failed}
    >
      <TableCell colSpan={colSpan}>
        <div className="flex items-center gap-2 text-sm" style={{ paddingLeft: row.depth * 20 }}>
          {open ? (
            <ChevronDown className="size-4 shrink-0 opacity-60" />
          ) : (
            <ChevronRight className="size-4 shrink-0 opacity-60" />
          )}
          <Icon className="text-muted-foreground size-4 shrink-0" />
          <span className="font-medium">{row.name}</span>
          <span className="text-muted-foreground text-xs">{row.ids.length} caso(s)</span>
          <span className="ml-2 flex flex-wrap items-center gap-1.5 text-xs tabular-nums">
            {stats.passed > 0 && <StatusBadge label={`✅ ${stats.passed}`} tone="ok" />}
            {stats.failed > 0 && <StatusBadge label={`❌ ${stats.failed}`} tone="fail" />}
            {stats.running > 0 && <StatusBadge label={`rodando ${stats.running}`} tone="run" />}
            {stats.queued > 0 && <StatusBadge label={`na fila ${stats.queued}`} tone="muted" />}
          </span>
        </div>
      </TableCell>
    </TableRow>
  )
}

function ItemRow({
  it,
  now,
  busy,
  cols,
  indent = 0,
  onOpen,
  onRetry,
}: {
  it: Item
  now: number
  busy: boolean
  cols: ItemColumnKey[]
  indent?: number
  onOpen: (id: string) => void
  onRetry: (id: string) => void
}) {
  const a = it.attempts[it.attempts.length - 1]
  const shot = a?.screenshots?.[a.screenshots.length - 1]
  const label = massaLabel(a?.massa)
  const cells: Record<ItemColumnKey, React.ReactNode> = {
    num: <TableCell className="text-muted-foreground tabular-nums">{Number(it.id.slice(1))}</TableCell>,
    status: (
      <TableCell>
        <StatusBadge {...ITEM_STATUS[it.status]} />
      </TableCell>
    ),
    caso: (
      <TableCell>
        <p className="truncate font-medium" title={it.name} style={{ paddingLeft: indent }}>
          {it.name}
        </p>
        {!indent && (
          <p className="text-muted-foreground truncate text-xs">{it.file.replace(/^scenarios\//, "")}</p>
        )}
      </TableCell>
    ),
    celular: <TableCell className="font-mono text-xs">
          {a ? (a.machineId ? `${a.machineId} · ${a.serial.slice(a.machineId.length + 1)}` : a.serial) : "—"}
        </TableCell>,
    massa: (
      <TableCell data-testid="item-massa">
        {label ? (
          <p className="truncate font-mono text-xs" title={label}>
            {label}
          </p>
        ) : (
          <span className="text-muted-foreground truncate text-xs">{it.accounts.join(", ") || "—"}</span>
        )}
      </TableCell>
    ),
    duracao: (
      <TableCell className="text-right text-xs tabular-nums">
        {a ? formatDuration(durationBetween(a.startedAt, a.endedAt, now), !a.endedAt) : "—"}
      </TableCell>
    ),
    tent: <TableCell className="text-center tabular-nums">{it.attempts.length}</TableCell>,
    erro: (
      <TableCell>
        {a?.message && it.status !== "passed" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <p
                className="truncate font-mono text-xs text-red-700 dark:text-red-400"
                data-testid="item-error"
              >
                {a.message}
              </p>
            </TooltipTrigger>
            <TooltipContent className="max-w-lg font-mono text-xs break-words whitespace-pre-wrap">
              {a.message}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
    ),
    print: (
      <TableCell onClick={(e) => e.stopPropagation()}>
        {shot ? (
          <a href={runFileUrl(a.dir, shot)} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={runFileUrl(a.dir, shot)}
              alt="print"
              className="h-10 w-6 rounded border object-cover"
              loading="lazy"
            />
          </a>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
    ),
    logs: (
      <TableCell onClick={(e) => e.stopPropagation()}>
        {a && a.status !== "running" ? (
          <a
            href={runFileUrl(a.dir, "log.html")}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs underline"
            data-testid="log-link"
          >
            log.html <ExternalLink className="size-3" />
          </a>
        ) : a ? (
          <span className="text-muted-foreground text-xs">ao vivo →</span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
    ),
    acoes: (
      <TableCell onClick={(e) => e.stopPropagation()}>
        {RETRYABLE_ITEM_STATUSES.has(it.status) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={busy}
                aria-label={`Rodar ${it.name} de novo`}
                data-testid="retry-item"
                onClick={() => onRetry(it.id)}
              >
                <RotateCcw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Rodar este caso de novo</TooltipContent>
          </Tooltip>
        )}
      </TableCell>
    ),
  }
  return (
    <TableRow
      className="cursor-pointer"
      onClick={() => onOpen(it.id)}
      data-testid="item-row"
      data-status={it.status}
    >
      {cols.map((k) => (
        <Fragment key={k}>{cells[k]}</Fragment>
      ))}
    </TableRow>
  )
}

/** Opções que podem mudar a qualquer momento, inclusive com a fila rodando. */
function QueueOptionsBar({ q, busy, run }: { q: Queue; busy: boolean; run: (cmd: Parameters<typeof sendCommand>[0]) => Promise<void> }) {
  return (
    <div className="bg-muted/30 mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border px-4 py-2 text-sm" data-testid="queue-options">
      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">Tentativas extras</span>
        <Select value={String(q.options.retries)} onValueChange={(v) => run({ type: "set_queue_retries", queueId: q.id, retries: Number(v) })} disabled={busy}>
          <SelectTrigger className="h-8 w-20" data-testid="queue-retries">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RETRY_OPTIONS.map((r) => (
              <SelectItem key={r} value={String(r)}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">Esperas</span>
        <Select
          value={String(q.options.waitFactor ?? 1)}
          onValueChange={(v) => run({ type: "set_queue_wait_factor", queueId: q.id, waitFactor: Number(v) })}
          disabled={busy}
        >
          <SelectTrigger className="h-8 w-20" data-testid="queue-wait">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WAIT_FACTORS.map((f) => (
              <SelectItem key={f} value={String(f)}>
                {formatFactor(f)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <span className="text-muted-foreground text-xs">
        Aumentar as tentativas recoloca na fila os casos que falharam (até o novo limite). Vale na hora, mesmo com a fila rodando.
      </span>
    </div>
  )
}

export function QueueDetail({ id }: { id: string }) {
  const router = useRouter()
  const { data, error, loading, reload } = usePoll<QueueDetailDto>(`/api/queues/${id}`, 2000)
  const [tab, setTab] = useState("all")
  const [view, setView] = useState<"tree" | "list">("tree")
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [openItem, setOpenItem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const columns = useColumnPrefs("qafarm.queue-detail.columns", ITEM_COLUMNS)
  const cols = visibleColumns(ITEM_COLUMNS, columns.prefs)
  const colKeys = cols.map((c) => c.key)
  const tableWidth = cols.reduce((sum, c) => sum + c.px, 0)

  const items = useMemo(() => data?.queue.items ?? [], [data])
  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const t of TABS) out[t.value] = items.filter((i) => t.match(i.status)).length
    return out
  }, [items])
  const visible = useMemo(
    () => items.filter((i) => TABS.find((t) => t.value === tab)!.match(i.status)),
    [items, tab],
  )
  const selectedItem: Item | null = items.find((i) => i.id === openItem) ?? null
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  // pastas → arquivo → casos, igual à página Testes; tudo aberto, exceto o que o usuário fechou
  const treeRows = useMemo(() => {
    const entries = queueTreeEntries(visible)
    const open = new Set(allGroupKeys(entries).filter((k) => !collapsed.has(k)))
    return buildTreeRows(entries, open)
  }, [visible, collapsed])
  const toggleCollapsed = (key: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const live =
    data?.queue.status === "running" ||
    data?.queue.status === "paused" ||
    items.some((i) => i.status === "running")
  const now = useLiveNow(data?.serverNow, live)

  if (loading && !data) return <Skeleton className="h-64" />
  if (error && !data) return <EmptyState title="Fila não encontrada">{error}</EmptyState>
  if (!data) return null
  const { summary: s, queue: q } = data
  const active = q.status === "running" || q.status === "paused"
  const failures = s.counts.failed + s.counts.timeout + s.counts.infra_error

  async function run(cmd: Parameters<typeof sendCommand>[0]) {
    setBusy(true)
    const r = await sendCommand(cmd)
    setBusy(false)
    if (cmd.type === "rerun_failed" && r?.ok && typeof r.data?.queueId === "string")
      router.push(`/filas/${r.data.queueId}`)
    else void reload()
  }
  const rowProps = {
    now,
    busy,
    onOpen: setOpenItem,
    onRetry: (itemId: string) => run({ type: "retry_item", queueId: q.id, itemId }),
    cols: colKeys,
  }

  return (
    <div>
      <Button variant="ghost" size="sm" asChild className="mb-2 -ml-2">
        <Link href="/filas">
          <ArrowLeft /> Filas
        </Link>
      </Button>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {q.name} <StatusBadge {...QUEUE_STATUS[q.status]} />
          </span>
        }
        description={`Criada ${formatDateTime(q.createdAt)} · ambiente ${q.env} · timeout ${formatDuration(q.options.timeoutSec)} · ${q.options.retries} tentativa(s) extra(s) · esperas ${formatFactor(q.options.waitFactor)} · ${q.options.closeAppAfter === false ? "app fica aberto ao fim do caso" : "fecha o app ao fim de cada caso"} · ${q.options.allowSameAccount ? "mesma conta em vários celulares" : "uma conta por vez"}`}
        actions={
          <>
            {q.status === "running" && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => run({ type: "pause_queue", queueId: q.id })}
              >
                <Pause /> Pausar
              </Button>
            )}
            {q.status === "paused" && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => run({ type: "resume_queue", queueId: q.id })}
              >
                <Play /> Continuar
              </Button>
            )}
            {active && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" disabled={busy}>
                    <Square /> Cancelar
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Cancelar a fila?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Os {s.counts.running} caso(s) em execução serão interrompidos e os {s.counts.queued} na
                      fila não vão rodar. Os resultados já obtidos ficam salvos.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Voltar</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => run({ type: "cancel_queue", queueId: q.id })}
                    >
                      Cancelar fila
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {failures > 0 && !active && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => run({ type: "rerun_failed", queueId: q.id })}
                data-testid="rerun-failed"
              >
                <RotateCcw /> Re-rodar {failures} falha(s)
              </Button>
            )}
            {!active && (
              <DeleteQueueButton
                q={{ ...s, id: q.id, name: q.name }}
                variant="button"
                onDeleted={() => router.push("/filas")}
              />
            )}
          </>
        }
      />

      <QueueOptionsBar q={q} busy={busy} run={run} />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Passou" value={s.counts.passed} tone="text-emerald-600" />
        <Stat label="Falhou" value={s.counts.failed + s.counts.config_error} tone="text-red-600" />
        <Stat label="Timeout / infra" value={s.counts.timeout + s.counts.infra_error} tone="text-amber-600" />
        <Stat label="Rodando" value={s.counts.running} tone="text-violet-600" />
        <Stat label="Na fila" value={s.counts.queued} />
        <Stat label="Total" value={s.total} />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Tempo total"
          value={formatDuration(
            queueElapsedSec(elapsedRange({ ...s, finishedAt: q.finishedAt ?? null }), now),
            true,
          )}
          testId="time-total"
        />
        <Stat label="Tempo médio por caso" value={formatDuration(s.avgDurationSec, true)} testId="time-avg" />
        <Stat label="Caso mais rápido" value={formatDuration(s.minDurationSec, true)} testId="time-min" />
        <Stat label="Caso mais lento" value={formatDuration(s.maxDurationSec, true)} testId="time-max" />
      </div>

      <Card className="mb-4 py-4">
        <CardContent className="grid gap-2 px-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium" data-testid="queue-progress">
              {s.finished} de {s.total} concluído(s) · {Math.round(s.progress * 100)}%
            </span>
            <span className="text-muted-foreground">
              {active && s.minTheoreticalSec > 0 && `restante mínimo ~${formatDuration(s.minTheoreticalSec)}`}
            </span>
          </div>
          <ResultBar s={s} />
        </CardContent>
      </Card>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} data-testid={`tab-${t.value}`}>
                {t.label} ({counts[t.value]})
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          {view === "tree" && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCollapsed(new Set())}
                data-testid="expand-all"
              >
                <ChevronsUpDown /> Abrir tudo
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCollapsed(new Set(allGroupKeys(queueTreeEntries(visible))))}
                data-testid="collapse-all"
              >
                <ChevronsDownUp /> Fechar tudo
              </Button>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" data-testid="columns-menu">
                <Columns3 /> Colunas
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Colunas visíveis</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {ITEM_COLUMNS.filter((c) => c.hideable !== false).map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.key}
                  checked={!columns.prefs.hidden.includes(c.key)}
                  onCheckedChange={() => columns.toggle(c.key)}
                  onSelect={(e) => e.preventDefault()}
                  data-testid={`column-toggle-${c.key}`}
                >
                  {c.label}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={columns.reset} data-testid="columns-reset">
                <RotateCcw /> Restaurar padrão
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tabs value={view} onValueChange={(v) => setView(v as "tree" | "list")}>
            <TabsList>
              <TabsTrigger value="tree" data-testid="view-tree">
                <FolderTree /> Pastas
              </TabsTrigger>
              <TabsTrigger value="list" data-testid="view-list">
                <List /> Lista
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState title="Nenhum caso nesta aba" />
      ) : (
        <div className="rounded-md border">
          <Table
            className="table-fixed [&_td]:overflow-hidden"
            style={{ width: tableWidth, minWidth: "100%" }}
            data-testid="items-table"
          >
            <colgroup>
              {cols.map((c) => (
                <col key={c.key} style={{ width: c.px }} />
              ))}
            </colgroup>
            <TableHeader>
              <TableRow>
                {cols.map((c) => (
                  <ResizableHead
                    key={c.key}
                    col={c}
                    onPreview={(w) => columns.preview(c.key, w)}
                    onCommit={columns.commit}
                    onReset={() => columns.resize(c.key, null)}
                  />
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {view === "list"
                ? visible.map((it) => <ItemRow key={it.id} it={it} {...rowProps} />)
                : treeRows.map((r) =>
                    r.kind === "test" ? (
                      <ItemRow key={r.key} it={r.entry.item} indent={r.depth * 20} {...rowProps} />
                    ) : (
                      <GroupRow
                        key={r.key}
                        row={r}
                        open={!collapsed.has(r.key)}
                        stats={groupStats(r.ids, byId)}
                        colSpan={colKeys.length}
                        onToggle={() => toggleCollapsed(r.key)}
                      />
                    ),
                  )}
            </TableBody>
          </Table>
        </div>
      )}
      <ItemSheet
        queueId={q.id}
        item={selectedItem}
        onOpenChange={(o) => !o && setOpenItem(null)}
        onRetry={(itemId) => run({ type: "retry_item", queueId: q.id, itemId })}
      />
    </div>
  )
}
