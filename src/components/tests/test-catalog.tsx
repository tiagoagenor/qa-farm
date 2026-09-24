"use client"

import { useVirtualizer } from "@tanstack/react-virtual"
import { AlertTriangle, ListPlus, RefreshCw, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import type { CatalogEntry } from "@/core/types"
import { minTheoreticalSec } from "@/core/queue-logic"
import { EmptyState, PageHeader } from "@/components/panel/page-header"
import { MultiSelect } from "@/components/panel/multi-select"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { usePoll } from "@/hooks/use-poll"
import { filterEntries, folderOptions, tagOptions, toggleRange } from "@/lib/catalog-filter"
import { sendCommand } from "@/lib/client"
import { formatDuration } from "@/lib/format"

import { CreateQueueDialog } from "./create-queue-dialog"

interface CatalogResponse {
  status: string
  error: string | null
  generatedAt: string | null
  total: number
  entries: CatalogEntry[]
}

const ROW_H = 44
const STORAGE_KEY = "qafarm:selected"

export function TestCatalog() {
  const { data, loading, reload } = usePoll<CatalogResponse>("/api/catalog", 15_000)
  const { data: overview } = usePoll<{ devices: { emulators: number; ready: number; busy: number } }>("/api/overview", 10_000)
  const entries = useMemo(() => data?.entries ?? [], [data])
  const [search, setSearch] = useState("")
  const [folders, setFolders] = useState<Set<string>>(new Set())
  const [tags, setTags] = useState<Set<string>>(new Set())
  const [onlySelected, setOnlySelected] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastIndex, setLastIndex] = useState<number | null>(null)
  const [dialog, setDialog] = useState(false)
  const [sheet, setSheet] = useState(false)
  const parentRef = useRef<HTMLDivElement>(null)

  // seleção sobrevive a recarregar a página (conveniência local)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) setSelected(new Set(JSON.parse(raw) as string[]))
    } catch {
      /* sem storage */
    }
  }, [])
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...selected]))
    } catch {
      /* sem storage */
    }
  }, [selected])

  // remove da seleção casos que não existem mais no catálogo
  const known = useMemo(() => new Set(entries.map((e) => e.id)), [entries])
  const selectedValid = useMemo(() => [...selected].filter((id) => known.has(id)), [selected, known])

  const visible = useMemo(
    () => filterEntries(entries, { search, folders, tags, onlySelected }, selected),
    [entries, search, folders, tags, onlySelected, selected],
  )
  const folderOpts = useMemo(() => folderOptions(entries), [entries])
  const tagOpts = useMemo(() => tagOptions(entries), [entries])
  const selectedEntries = useMemo(() => entries.filter((e) => selected.has(e.id)), [entries, selected])
  const devices = Math.max(1, (overview?.devices.ready ?? 0) + (overview?.devices.busy ?? 0) || overview?.devices.emulators || 1)
  const minSec = minTheoreticalSec(selectedEntries.map((e) => ({ accounts: e.accounts, status: "queued" })), devices, 120)
  const withoutAccount = selectedEntries.filter((e) => e.accounts.length === 0).length

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  })

  const allVisibleSelected = visible.length > 0 && visible.every((e) => selected.has(e.id))

  function selectVisible() {
    const next = new Set(selected)
    if (allVisibleSelected) for (const e of visible) next.delete(e.id)
    else for (const e of visible) next.add(e.id)
    setSelected(next)
  }

  async function refreshCatalog() {
    const r = await sendCommand({ type: "refresh_catalog" })
    if (r?.ok) setTimeout(() => void reload(), 3000)
  }

  return (
    <div>
      <PageHeader
        title="Testes"
        description={
          data
            ? `${data.total} casos no catálogo${data.generatedAt ? ` · atualizado ${new Date(data.generatedAt).toLocaleString("pt-BR")}` : ""}`
            : "Casos do projeto QA_Automacao_APP"
        }
        actions={
          <Button variant="outline" onClick={refreshCatalog}>
            <RefreshCw /> Atualizar catálogo
          </Button>
        }
      />

      {data && data.status !== "ready" && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="size-4 text-amber-600" />
          {data.status === "building" && "Gerando o catálogo a partir do projeto… isso leva alguns segundos."}
          {data.status === "missing" && "Catálogo ainda não foi gerado. Aguarde o runner ou clique em Atualizar catálogo."}
          {data.status === "error" && `Erro ao gerar o catálogo: ${data.error}`}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Buscar por nome, arquivo, tag ou conta…"
          className="w-full sm:w-80"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="catalog-search"
        />
        <MultiSelect label="Pastas" options={folderOpts} value={folders} onChange={setFolders} testId="filter-folders" />
        <MultiSelect label="Tags" options={tagOpts} value={tags} onChange={setTags} testId="filter-tags" />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={onlySelected} onCheckedChange={(v) => setOnlySelected(v === true)} />
          Só selecionados
        </label>
        {(search || folders.size || tags.size || onlySelected) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("")
              setFolders(new Set())
              setTags(new Set())
              setOnlySelected(false)
            }}
          >
            <X /> Limpar filtros
          </Button>
        )}
        <span className="text-muted-foreground ml-auto text-sm" data-testid="visible-count">
          {visible.length} de {entries.length} casos
        </span>
      </div>

      {loading && !data ? (
        <div className="grid gap-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState title="Nenhum caso no catálogo">Aguarde a geração ou clique em Atualizar catálogo.</EmptyState>
      ) : (
        <div className="rounded-md border">
          <div className="bg-muted/50 text-muted-foreground grid grid-cols-[40px_minmax(0,2.2fr)_minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,1fr)] items-center gap-2 border-b px-3 py-2 text-xs font-medium">
            <Checkbox
              checked={allVisibleSelected ? true : visible.some((e) => selected.has(e.id)) ? "indeterminate" : false}
              onCheckedChange={selectVisible}
              aria-label="Selecionar todos os filtrados"
              data-testid="select-visible"
            />
            <span>Caso</span>
            <span>Arquivo</span>
            <span>Tags</span>
            <span>Conta de teste</span>
          </div>
          <div ref={parentRef} className="h-[calc(100vh-330px)] min-h-[320px] overflow-auto" data-testid="catalog-rows">
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((row) => {
                const e = visible[row.index]
                const checked = selected.has(e.id)
                return (
                  <div
                    key={e.id}
                    className={`hover:bg-muted/40 absolute inset-x-0 grid cursor-pointer grid-cols-[40px_minmax(0,2.2fr)_minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,1fr)] items-center gap-2 border-b px-3 text-sm ${checked ? "bg-primary/5" : ""}`}
                    style={{ height: ROW_H, transform: `translateY(${row.start}px)` }}
                    onClick={(ev) => {
                      setSelected(toggleRange(selected, visible, lastIndex, row.index, ev.shiftKey))
                      setLastIndex(row.index)
                    }}
                    data-testid="catalog-row"
                  >
                    <Checkbox checked={checked} aria-label={`Selecionar ${e.name}`} tabIndex={-1} className="pointer-events-none" />
                    <span className="truncate font-medium" title={e.name}>
                      {e.name}
                    </span>
                    <span className="text-muted-foreground truncate text-xs" title={`${e.file}:${e.line}`}>
                      {e.file.replace(/^scenarios\//, "")}
                    </span>
                    <span className="flex gap-1 overflow-hidden">
                      {e.tags.slice(0, 2).map((t) => (
                        <Badge key={t} variant="secondary" className="max-w-[140px] truncate text-[11px]">
                          {t}
                        </Badge>
                      ))}
                      {e.tags.length > 2 && <span className="text-muted-foreground text-xs">+{e.tags.length - 2}</span>}
                    </span>
                    <span className="truncate text-xs">
                      {e.accounts.length ? (
                        e.accounts.join(", ")
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-amber-600">sem conta detectada</span>
                          </TooltipTrigger>
                          <TooltipContent>Roda sem trava de conta — pode conflitar com outro caso que use a mesma conta.</TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      <div className="bg-background/95 sticky bottom-0 z-20 -mx-4 mt-3 border-t backdrop-blur md:-mx-6">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 md:px-6">
          <span className="text-sm font-medium" data-testid="selected-count">
            {selectedValid.length} selecionado(s)
          </span>
          {selectedValid.length > 0 && (
            <span className="text-muted-foreground text-sm">
              tempo mínimo ~{formatDuration(minSec)} com {devices} celular(es)
              {withoutAccount > 0 && ` · ${withoutAccount} sem conta detectada`}
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" disabled={!selectedValid.length} onClick={() => setSheet(true)}>
              Ver selecionados
            </Button>
            <Button variant="ghost" disabled={!selectedValid.length} onClick={() => setSelected(new Set())}>
              Limpar
            </Button>
            <Button disabled={!selectedValid.length} onClick={() => setDialog(true)} data-testid="open-create-queue">
              <ListPlus /> Criar fila
            </Button>
          </div>
        </div>
      </div>

      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{selectedEntries.length} caso(s) selecionado(s)</SheetTitle>
            <SheetDescription>Remova o que não quiser antes de criar a fila.</SheetDescription>
          </SheetHeader>
          <div className="grid gap-1 overflow-auto px-4 pb-4">
            {selectedEntries.map((e) => (
              <div key={e.id} className="flex items-center gap-2 rounded border px-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate" title={e.name}>
                  {e.name}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remover ${e.name}`}
                  onClick={() => {
                    const next = new Set(selected)
                    next.delete(e.id)
                    setSelected(next)
                  }}
                >
                  <X />
                </Button>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      <CreateQueueDialog open={dialog} onOpenChange={setDialog} testIds={selectedValid} onCreated={() => setSelected(new Set())} />
    </div>
  )
}
