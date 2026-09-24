"use client"

import { Trash2, Upload } from "lucide-react"
import { useRef, useState } from "react"
import { toast } from "sonner"

import type { AppMeta } from "@/core/types"
import { EmptyState, PageHeader } from "@/components/panel/page-header"
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { usePoll } from "@/hooks/use-poll"
import { sendCommand } from "@/lib/client"
import { formatBytes, formatDateTime } from "@/lib/format"

type AppRow = AppMeta & { queues: number; activeQueues: number }

type UploadState =
  | { phase: "idle" }
  | { phase: "sending"; name: string; loaded: number; total: number }
  | { phase: "validating"; name: string }
  | { phase: "done"; app: AppMeta }
  | { phase: "error"; name: string; message: string }

/** Envia o arquivo cru (octet-stream) com XHR para ter progresso real. */
function uploadFile(file: File, onProgress: (loaded: number, total: number) => void): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", `/api/upload?name=${encodeURIComponent(file.name)}`)
    xhr.setRequestHeader("Content-Type", "application/octet-stream")
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total)
    xhr.onload = () => {
      let body: unknown = {}
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        /* resposta não-JSON */
      }
      resolve({ status: xhr.status, body })
    }
    xhr.onerror = () => reject(new Error("Falha de rede no upload"))
    xhr.send(file)
  })
}

export function AppManager() {
  const { data, loading, reload } = usePoll<{ apps: AppRow[] }>("/api/apps", 10_000)
  const [state, setState] = useState<UploadState>({ phase: "idle" })
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const apps = data?.apps ?? []

  async function send(file: File) {
    setState({ phase: "sending", name: file.name, loaded: 0, total: file.size })
    try {
      const r = await uploadFile(file, (loaded, total) => {
        setState(loaded >= total ? { phase: "validating", name: file.name } : { phase: "sending", name: file.name, loaded, total })
      })
      if (r.status === 201) {
        const app = (r.body as { app: AppMeta }).app
        setState({ phase: "done", app })
        toast.success(`APK ${app.versionName} (${app.versionCode}) enviado`)
        void reload()
      } else {
        setState({ phase: "error", name: file.name, message: (r.body as { error?: string }).error ?? `Erro ${r.status}` })
      }
    } catch (e) {
      setState({ phase: "error", name: file.name, message: (e as Error).message })
    }
  }

  function onFiles(files: FileList | null) {
    const f = files?.[0]
    if (f) void send(f)
  }

  const uploading = state.phase === "sending" || state.phase === "validating"

  return (
    <div>
      <PageHeader title="Apps" description="Envie o APK que será testado. Cada fila escolhe qual APK usar; ele é instalado em todos os celulares antes dos casos." />
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Enviar APK</CardTitle>
          <CardDescription>Aceita APK com código x86_64 (roda no emulador) e Android mínimo até 13. Limite de 400 MB.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div
            className={`grid place-items-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition ${drag ? "border-primary bg-primary/5" : ""}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDrag(true)
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDrag(false)
              if (!uploading) onFiles(e.dataTransfer.files)
            }}
          >
            <Upload className="text-muted-foreground size-8" />
            <p className="text-sm">Arraste o arquivo .apk aqui ou</p>
            <Button variant="outline" disabled={uploading} onClick={() => input.current?.click()} data-testid="choose-apk">
              Escolher arquivo
            </Button>
            <input
              ref={input}
              type="file"
              accept=".apk,application/vnd.android.package-archive"
              className="hidden"
              data-testid="apk-input"
              onChange={(e) => {
                onFiles(e.target.files)
                e.target.value = ""
              }}
            />
          </div>
          {state.phase === "sending" && (
            <div className="grid gap-1" data-testid="upload-progress">
              <div className="flex justify-between text-sm">
                <span className="truncate">{state.name}</span>
                <span className="tabular-nums">
                  {formatBytes(state.loaded)} / {formatBytes(state.total)} ({Math.round((state.loaded / Math.max(1, state.total)) * 100)}%)
                </span>
              </div>
              <Progress value={(state.loaded / Math.max(1, state.total)) * 100} />
            </div>
          )}
          {state.phase === "validating" && <p className="text-sm">Validando {state.name} (lendo o manifesto do APK)…</p>}
          {state.phase === "done" && (
            <Alert data-testid="upload-ok">
              <AlertTitle>APK aceito</AlertTitle>
              <AlertDescription>
                {state.app.package} · versão {state.app.versionName} ({state.app.versionCode}) · minSdk {state.app.minSdk} ·{" "}
                {state.app.abis.join(", ") || "sem código nativo"}
              </AlertDescription>
            </Alert>
          )}
          {state.phase === "error" && (
            <Alert variant="destructive" data-testid="upload-error">
              <AlertTitle>{state.name} recusado</AlertTitle>
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {loading && !data ? (
        <Skeleton className="h-32" />
      ) : apps.length === 0 ? (
        <EmptyState title="Nenhum APK enviado ainda" />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>APK</TableHead>
                <TableHead>Versão</TableHead>
                <TableHead>ABIs</TableHead>
                <TableHead className="text-right">Tamanho</TableHead>
                <TableHead>Enviado</TableHead>
                <TableHead className="text-right">Filas</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((a) => (
                <TableRow key={a.id} data-testid="app-row">
                  <TableCell>
                    <p className="font-medium">{a.originalName}</p>
                    <p className="text-muted-foreground font-mono text-xs">{a.package}</p>
                  </TableCell>
                  <TableCell>
                    {a.versionName} <span className="text-muted-foreground">({a.versionCode})</span>
                  </TableCell>
                  <TableCell className="flex flex-wrap gap-1">
                    {a.abis.map((x) => (
                      <Badge key={x} variant={x === "x86_64" ? "default" : "secondary"}>
                        {x}
                      </Badge>
                    ))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatBytes(a.size)}</TableCell>
                  <TableCell>{formatDateTime(a.uploadedAt)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {a.queues}
                    {a.activeQueues > 0 && <span className="text-muted-foreground"> ({a.activeQueues} ativa)</span>}
                  </TableCell>
                  <TableCell>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" disabled={a.activeQueues > 0} aria-label={`Apagar ${a.originalName}`}>
                          <Trash2 />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Apagar {a.originalName}?</AlertDialogTitle>
                          <AlertDialogDescription>O arquivo do APK é removido do servidor. O histórico das filas continua.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Voltar</AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            onClick={async () => {
                              await sendCommand({ type: "delete_app", appId: a.id })
                              void reload()
                            }}
                          >
                            Apagar
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
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
