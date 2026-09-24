"use client"

import Link from "next/link"

import { EmptyState, PageHeader } from "@/components/panel/page-header"
import { StatusBadge } from "@/components/panel/status-badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { usePoll } from "@/hooks/use-poll"
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

export function QueueList() {
  const { data, loading } = usePoll<{ queues: QueueSummaryDto[] }>("/api/queues", 5000)
  const queues = data?.queues ?? []
  return (
    <div>
      <PageHeader
        title="Filas"
        description="Cada fila distribui os casos entre os celulares livres. O histórico fica salvo aqui."
        actions={
          <Button asChild>
            <Link href="/testes">Nova fila</Link>
          </Button>
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
