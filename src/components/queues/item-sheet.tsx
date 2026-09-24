"use client"

import { ExternalLink, RotateCcw } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { RETRYABLE_ITEM_STATUSES } from "@/core/queue-logic"
import type { Item } from "@/core/types"
import { StatusBadge } from "@/components/panel/status-badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { getJson } from "@/lib/client"
import { durationBetween, formatDateTime, formatDuration, ITEM_STATUS, runFileUrl } from "@/lib/format"

const MAX_CONSOLE = 400_000

function ConsoleView({ queueId, itemId, n, live }: { queueId: string; itemId: string; n: number; live: boolean }) {
  const [text, setText] = useState("")
  const offset = useRef(0)
  const box = useRef<HTMLPreElement>(null)

  useEffect(() => {
    offset.current = 0
    setText("")
    let stop = false
    async function pull() {
      const r = await getJson<{ text: string; offset: number }>(
        `/api/console?queue=${queueId}&item=${itemId}&attempt=${n}&offset=${offset.current}`,
      ).catch(() => null)
      if (!r || stop) return
      offset.current = r.offset
      if (r.text) {
        setText((t) => (t + r.text).slice(-MAX_CONSOLE))
        requestAnimationFrame(() => box.current?.scrollIntoView({ block: "end" }))
      }
    }
    void pull()
    const t = live ? setInterval(pull, 2000) : undefined
    return () => {
      stop = true
      if (t) clearInterval(t)
    }
  }, [queueId, itemId, n, live])

  return (
    <ScrollArea className="bg-muted/40 h-[45vh] rounded-md border">
      <pre ref={box} className="p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap" data-testid="console-text">
        {text || "(sem saída ainda)"}
      </pre>
    </ScrollArea>
  )
}

export function ItemSheet({
  queueId,
  item,
  onOpenChange,
  onRetry,
}: {
  queueId: string
  item: Item | null
  onOpenChange: (o: boolean) => void
  onRetry?: (itemId: string) => void
}) {
  const [n, setN] = useState<number | null>(null)
  const attempts = item?.attempts ?? []
  const current = attempts.find((a) => a.n === n) ?? attempts[attempts.length - 1]

  useEffect(() => {
    setN(null)
  }, [item?.id])

  return (
    <Sheet open={!!item} onOpenChange={onOpenChange}>
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        {item && (
          <>
            <SheetHeader>
              <SheetTitle className="pr-6 break-all">{item.name}</SheetTitle>
              <SheetDescription>
                {item.file} · {item.accounts.length ? `conta: ${item.accounts.join(", ")}` : "sem conta detectada"}
              </SheetDescription>
            </SheetHeader>
            <div className="grid gap-4 overflow-auto px-4 pb-6">
              <div className="flex items-center gap-2">
                <StatusBadge {...ITEM_STATUS[item.status]} />
                <span className="text-muted-foreground text-sm">{attempts.length} tentativa(s)</span>
                {onRetry && RETRYABLE_ITEM_STATUSES.has(item.status) && (
                  <Button size="sm" variant="outline" className="ml-auto" onClick={() => onRetry(item.id)} data-testid="retry-item-sheet">
                    <RotateCcw /> Rodar de novo
                  </Button>
                )}
              </div>
              {attempts.length === 0 ? (
                <p className="text-muted-foreground text-sm">Ainda não começou.</p>
              ) : (
                <>
                  {attempts.length > 1 && (
                    <Tabs value={String(current?.n)} onValueChange={(v) => setN(Number(v))}>
                      <TabsList>
                        {attempts.map((a) => (
                          <TabsTrigger key={a.n} value={String(a.n)}>
                            Tentativa {a.n}
                          </TabsTrigger>
                        ))}
                      </TabsList>
                    </Tabs>
                  )}
                  {current && (
                    <div className="grid gap-3">
                      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                        <div>
                          <p className="text-muted-foreground text-xs">Status</p>
                          <StatusBadge {...ITEM_STATUS[current.status]} />
                        </div>
                        <div>
                          <p className="text-muted-foreground text-xs">Celular</p>
                          <p className="font-mono text-xs">{current.serial}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground text-xs">Início</p>
                          <p className="text-xs">{formatDateTime(current.startedAt)}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground text-xs">Duração</p>
                          <p className="text-xs">{formatDuration(durationBetween(current.startedAt, current.endedAt))}</p>
                        </div>
                      </div>
                      {current.message && (
                        <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3">
                          <p className="mb-1 text-xs font-medium">Erro</p>
                          <p className="font-mono text-xs break-words whitespace-pre-wrap" data-testid="attempt-message">
                            {current.message}
                          </p>
                          {current.teardownMessage && (
                            <p className="text-muted-foreground mt-2 text-xs">Teardown: {current.teardownMessage}</p>
                          )}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {["log.html", "report.html", "console.log", "output.xml"].map((f) => (
                          <Button key={f} variant="outline" size="sm" asChild>
                            <a href={runFileUrl(current.dir, f)} target="_blank" rel="noreferrer">
                              {f} <ExternalLink />
                            </a>
                          </Button>
                        ))}
                      </div>
                      {!!current.screenshots?.length && (
                        <div className="flex flex-wrap gap-2">
                          {current.screenshots.map((s) => (
                            <a key={s} href={runFileUrl(current.dir, s)} target="_blank" rel="noreferrer" title={s}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={runFileUrl(current.dir, s)} alt={s} className="h-40 rounded border object-contain" />
                            </a>
                          ))}
                        </div>
                      )}
                      <div>
                        <p className="mb-1 text-xs font-medium">Console {current.status === "running" && "(ao vivo)"}</p>
                        <ConsoleView queueId={queueId} itemId={item.id} n={current.n} live={current.status === "running"} />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
