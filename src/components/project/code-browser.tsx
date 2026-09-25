"use client"

import { ChevronDown, ChevronRight, File, Folder, ShieldAlert } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import { Card, CardContent } from "@/components/ui/card"
import { getJson } from "@/lib/client"
import { formatBytes } from "@/lib/format"

interface Entry {
  name: string
  path: string
  type: "dir" | "file"
  size?: number
}
interface FileDto {
  path: string
  size: number
  binary: boolean
  truncated: boolean
  masked: boolean
  content: string
}

/** Visualizador SOMENTE LEITURA do código do projeto no servidor (segredos aparecem como ••••). */
export function CodeBrowser({ version }: { version: string }) {
  const [children, setChildren] = useState<Record<string, Entry[]>>({})
  const [open, setOpen] = useState<Set<string>>(new Set([""]))
  const [file, setFile] = useState<FileDto | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (dir: string) => {
    try {
      const r = await getJson<{ entries: Entry[] }>(`/api/project/tree?path=${encodeURIComponent(dir)}`)
      setChildren((c) => ({ ...c, [dir]: r.entries }))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  // commit novo (pull): recarrega a árvore aberta e o arquivo mostrado
  useEffect(() => {
    setChildren({})
    void load("")
    for (const d of open) if (d) void load(d)
    if (file) void openFile(file.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  async function openFile(p: string) {
    try {
      setFile(await getJson<FileDto>(`/api/project/file?path=${encodeURIComponent(p)}`))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function toggle(dir: string) {
    const next = new Set(open)
    if (next.has(dir)) next.delete(dir)
    else {
      next.add(dir)
      if (!children[dir]) void load(dir)
    }
    setOpen(next)
  }

  const renderDir = (dir: string, depth: number): React.ReactNode =>
    (children[dir] ?? []).map((e) => (
      <div key={e.path}>
        <button
          type="button"
          className={`hover:bg-muted flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs ${file?.path === e.path ? "bg-muted font-medium" : ""}`}
          style={{ paddingLeft: depth * 12 + 4 }}
          onClick={() => (e.type === "dir" ? toggle(e.path) : void openFile(e.path))}
          data-testid="code-entry"
          data-path={e.path}
        >
          {e.type === "dir" ? (
            <>
              {open.has(e.path) ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              <Folder className="size-3.5 text-sky-600" />
            </>
          ) : (
            <File className="text-muted-foreground ml-4 size-3.5" />
          )}
          <span className="truncate">{e.name}</span>
        </button>
        {e.type === "dir" && open.has(e.path) && renderDir(e.path, depth + 1)}
      </div>
    ))

  return (
    <div className="grid gap-3 lg:grid-cols-[300px_minmax(0,1fr)]" data-testid="code-browser">
      <Card className="py-2">
        <CardContent className="max-h-[70vh] overflow-auto px-2">{renderDir("", 0)}</CardContent>
      </Card>
      <Card className="min-w-0 py-2">
        <CardContent className="px-3">
          {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}
          {!file ? (
            <p className="text-muted-foreground p-6 text-sm">
              Escolha um arquivo à esquerda para ver o conteúdo (somente leitura).
            </p>
          ) : (
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono font-medium" data-testid="code-path">
                  {file.path}
                </span>
                <span className="text-muted-foreground">{formatBytes(file.size)}</span>
                {file.masked && (
                  <span
                    className="flex items-center gap-1 text-amber-700 dark:text-amber-400"
                    data-testid="code-masked"
                  >
                    <ShieldAlert className="size-3.5" /> segredos ocultados (••••)
                  </span>
                )}
                {file.truncated && (
                  <span className="text-muted-foreground">mostrando só o início (arquivo grande)</span>
                )}
              </div>
              {file.binary ? (
                <p className="text-muted-foreground text-sm">Arquivo binário — sem visualização.</p>
              ) : (
                <pre
                  className="bg-muted max-h-[70vh] overflow-auto rounded-md p-3 font-mono text-xs leading-5"
                  data-testid="code-content"
                >
                  {file.content.split("\n").map((l, i) => (
                    <div key={i} className="flex">
                      <span className="text-muted-foreground w-12 shrink-0 pr-3 text-right select-none">
                        {i + 1}
                      </span>
                      <span className="whitespace-pre">{l}</span>
                    </div>
                  ))}
                </pre>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
