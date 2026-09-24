"use client"

import { Trash2 } from "lucide-react"
import Link from "next/link"
import { useState } from "react"

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
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { usePoll } from "@/hooks/use-poll"
import { sendCommand } from "@/lib/client"
import { durationBetween, formatDateTime, formatDuration, QUEUE_STATUS } from "@/lib/format"

import type { QueueSummaryDto } from "./types"

export function ResultBar({ s }: { s: Pick<QueueSummaryDto, "total" | "counts"> }) {
  if (!s.total) return null
  const seg = (n: number, cls: string, title: string) =>
    n > 0 ? <div className={cls} style={{ width: `${(n / s.total) * 100}%` }} title={`${title}: ${n}`} /> : null
  return (
    <div className="bg-muted flex h-2 w-full overflow-hidden rounded-full">
      {seg(s.counts.passed, "bg-emerald-500", "Passou")}
      {seg(s.counts.failed + s.counts.config_error, "bg-red-500", "Falhou")}
      {seg(s.counts.timeout + s.counts.infra_error, "bg-amber-500", "Timeout/infra")}
      {seg(s.counts.running, "bg-violet-500 animate-pulse", "Rodando")}
      {seg(s.counts.canceled, "bg-zinc-400", "Cancelado")}
    </div>
  )
}

/** Modal de confirmação para apagar uma fila (logs e prints dela também são apagados). */
export function DeleteQueueButton({
  q,
  onDeleted,
  variant = "icon",
}: {
  q: Pick<QueueSummaryDto, "id" | "name" | "status" | "total">
  onDeleted?: () => void
  variant?: "icon" | "button"
}) {
  const [busy, setBusy] = useState(false)
  const active = q.status === "running" || q.status === "paused"
  const trigger =
    variant === "icon" ? (
      <Button variant="ghost" size="icon" disabled={active || busy} aria-label={`Apagar ${q.name}`} data-testid="delete-queue">
        <Trash2 />
      </Button>
    ) : (
      <Button variant="outline" disabled={active || busy} data-testid="delete-queue">
        <Trash2 /> Apagar fila
      </Button>
    )
  if (active) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{trigger}</span>
        </TooltipTrigger>
        <TooltipContent>Cancele a fila antes de apagar</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Apagar a fila “{q.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Os resultados dos {q.total} caso(s), os logs (log.html, report.html, console) e os prints desta fila serão apagados do
            servidor. Não dá para desfazer.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Voltar</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid="confirm-delete-queue"
            onClick={async () => {
              setBusy(true)
              const r = await sendCommand({ type: "delete_queue", queueId: q.id })
              setBusy(false)
              if (r?.ok) onDeleted?.()
            }}
          >
            Apagar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function QueueList() {
  const { data, loading, reload } = usePoll<{ queues: QueueSummaryDto[] }>("/api/queues", 5000)
  const queues = data?.queues ?? []
  const finished = queues.filter((q) => q.status === "done" || q.status === "canceled")
  const active = queues.length - finished.length
  return (
    <div>
      <PageHeader
        title="Filas"
        description="Cada fila distribui os casos entre os celulares livres. O histórico fica salvo aqui."
        actions={
          <>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={finished.length === 0} data-testid="clear-queues">
                  <Trash2 /> Limpar tudo
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Apagar todas as filas terminadas?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {finished.length} fila(s) concluída(s) ou cancelada(s) serão apagadas, com todos os resultados, logs e prints.
                    {active > 0 && ` As ${active} fila(s) em andamento serão mantidas.`} Não dá para desfazer.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Voltar</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    data-testid="confirm-clear-queues"
                    onClick={async () => {
                      await sendCommand({ type: "clear_queues" })
                      void reload()
                    }}
                  >
                    Apagar {finished.length} fila(s)
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button asChild>
              <Link href="/testes">Nova fila</Link>
            </Button>
          </>
        }
      />
      {loading && !data ? (
        <Skeleton className="h-40" />
      ) : queues.length === 0 ? (
        <EmptyState title="Nenhuma fila ainda">
          Vá em <Link href="/testes" className="underline">Testes</Link>, selecione os casos e clique em Criar fila.
        </EmptyState>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fila</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[260px]">Resultado</TableHead>
                <TableHead className="text-right">✅</TableHead>
                <TableHead className="text-right">❌</TableHead>
                <TableHead className="text-right">Duração</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {queues.map((q) => (
                <TableRow key={q.id} data-testid="queue-row">
                  <TableCell>
                    <Link href={`/filas/${q.id}`} className="font-medium hover:underline">
                      {q.name}
                    </Link>
                    <div className="text-muted-foreground text-xs">
                      {formatDateTime(q.createdAt)} · {q.total} caso(s) · {q.env}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge {...QUEUE_STATUS[q.status]} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <ResultBar s={q} />
                      <span className="text-muted-foreground w-12 text-right text-xs">{Math.round(q.progress * 100)}%</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{q.counts.passed}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {q.counts.failed + q.counts.timeout + q.counts.infra_error + q.counts.config_error}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(durationBetween(q.startedAt, q.finishedAt ?? (q.status === "running" ? undefined : q.lastEndedAt)))}
                  </TableCell>
                  <TableCell>
                    <DeleteQueueButton q={q} onDeleted={() => void reload()} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
