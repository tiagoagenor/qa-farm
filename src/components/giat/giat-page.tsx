"use client"

import { FileText, ImageIcon, Lock, Play, Square, Unlock } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { EmptyState, PageHeader } from "@/components/panel/page-header"
import { StatusBadge } from "@/components/panel/status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { GiatRunStatus } from "@/core/giat"
import type { DeviceState } from "@/core/types"
import { usePoll } from "@/hooks/use-poll"
import { sendCommand } from "@/lib/client"
import { DEVICE_STATE, formatDateTime, type Tone } from "@/lib/format"

interface GiatDto {
  enabled: boolean
  runnerAlive: boolean
  tests: string[]
  reservations: Record<string, { since: string }>
  runs: Array<{
    id: string
    serial: string
    test: string
    env: "HML" | "PROD" | "MOCK"
    status: GiatRunStatus
    startedAt: string
    endedAt?: string
    exitCode?: number | null
    message?: string
    summary?: { total: number; passed: number; failed: number }
    files: string[]
  }>
  devices: Array<{ serial: string; name: string; kind: "emulator" | "physical"; state: DeviceState; note?: string; test?: string }>
}

const RUN_STATUS: Record<GiatRunStatus, { label: string; tone: Tone }> = {
  installing: { label: "Preparando APK", tone: "info" },
  running: { label: "Rodando", tone: "run" },
  passed: { label: "Passou", tone: "ok" },
  failed: { label: "Falhou", tone: "fail" },
  error: { label: "Erro", tone: "warn" },
  canceled: { label: "Cancelado", tone: "muted" },
}

const active = (s: GiatRunStatus) => s === "installing" || s === "running"

function duration(a: string, b?: string) {
  const ms = (b ? Date.parse(b) : Date.now()) - Date.parse(a)
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

/** GI-App-Test (QA_Automacao_TESTE) nos celulares deste servidor: reserva, disparo e resultados. */
export function GiatPage() {
  const [fast, setFast] = useState(false)
  const { data, reload } = usePoll<GiatDto>("/api/giat", fast ? 1500 : 5000)
  const running = !!data?.runs.some((r) => active(r.status))
  useEffect(() => setFast(running), [running])

  async function cmd(c: Parameters<typeof sendCommand>[0]) {
    await sendCommand(c)
    void reload()
  }

  return (
    <div className="grid gap-4">
      <PageHeader
        title="GI-App-Test"
        description="Testes Appium do projeto QA_Automacao_TESTE nos celulares deste servidor. Celular reservado sai das filas da fazenda até ser liberado."
      />
      {!data ? (
        <p className="text-muted-foreground text-sm">Carregando…</p>
      ) : !data.enabled ? (
        <EmptyState title="Projeto GI-App-Test não encontrado no servidor">
          Clone o QA_Automacao_TESTE em ~/www/QA_Automacao_TESTE (ou defina QAFARM_GIAT_DIR).
        </EmptyState>
      ) : (
        <>
          {!data.runnerAlive && (
            <p className="text-sm text-amber-700 dark:text-amber-400">O runner não está respondendo: reservas e execuções ficam paradas.</p>
          )}
          <Devices data={data} onCmd={cmd} />
          <RunForm data={data} onCmd={cmd} />
          <Runs data={data} onCmd={cmd} />
        </>
      )}
    </div>
  )
}

function Devices({ data, onCmd }: { data: GiatDto; onCmd: (c: Parameters<typeof sendCommand>[0]) => Promise<void> }) {
  return (
    <Card className="gap-3 py-5" data-testid="giat-devices">
      <CardHeader className="px-5">
        <CardTitle>Celulares</CardTitle>
        <CardDescription>
          Reserve para o GI-App-Test. Se houver um caso da fila rodando nele, a reserva vale quando ele terminar. Ao
          liberar, a fazenda confere o app e volta a usar o celular.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-5">
        {data.devices.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nenhum celular ligado neste servidor.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Celular</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.devices.map((d) => {
                const reserved = d.serial in data.reservations
                const busyGiat = data.runs.some((r) => r.serial === d.serial && active(r.status))
                return (
                  <TableRow key={d.serial} data-testid="giat-device" data-serial={d.serial}>
                    <TableCell>
                      <div className="font-medium">{d.name}</div>
                      <div className="text-muted-foreground font-mono text-xs">
                        {d.serial} · {d.kind === "physical" ? "físico" : "emulador"}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge {...DEVICE_STATE[d.state]} />
                      {reserved && d.state !== "reserved" && (
                        <span className="text-muted-foreground ml-2 text-xs">reserva pendente (termina o caso atual)</span>
                      )}
                      {d.note && d.state === "reserved" && <span className="text-muted-foreground ml-2 text-xs">{d.note}</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      {reserved ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyGiat}
                          onClick={() => void onCmd({ type: "giat_release", serial: d.serial })}
                          data-testid="giat-release"
                        >
                          <Unlock className="size-4" /> Liberar
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => void onCmd({ type: "giat_reserve", serial: d.serial })} data-testid="giat-reserve">
                          <Lock className="size-4" /> Reservar
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function RunForm({ data, onCmd }: { data: GiatDto; onCmd: (c: Parameters<typeof sendCommand>[0]) => Promise<void> }) {
  const ready = useMemo(
    () =>
      data.devices.filter(
        (d) => d.state === "reserved" && !data.runs.some((r) => r.serial === d.serial && active(r.status)),
      ),
    [data],
  )
  const [serial, setSerial] = useState("")
  const [test, setTest] = useState("")
  const [env, setEnv] = useState<"HML" | "PROD" | "MOCK">("HML")
  const dev = ready.find((d) => d.serial === serial)?.serial ?? ready[0]?.serial ?? ""
  const tst = data.tests.includes(test) ? test : (data.tests.find((t) => t.startsWith("smoke/")) ?? data.tests[0] ?? "")

  return (
    <Card className="gap-3 py-5" data-testid="giat-run-form">
      <CardHeader className="px-5">
        <CardTitle>Rodar um caso</CardTitle>
        <CardDescription>
          Antes de rodar, o GI-App-Test confere o APK pelo hash e instala se for diferente (em celular físico nunca
          desinstala: avisa para desinstalar à mão).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3 px-5">
        <div className="grid gap-1">
          <span className="text-muted-foreground text-xs">Caso</span>
          <Select value={tst} onValueChange={setTest}>
            <SelectTrigger className="w-80" data-testid="giat-test">
              <SelectValue placeholder="Nenhum caso" />
            </SelectTrigger>
            <SelectContent>
              {data.tests.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <span className="text-muted-foreground text-xs">Celular reservado</span>
          <Select value={dev} onValueChange={setSerial}>
            <SelectTrigger className="w-64" data-testid="giat-serial">
              <SelectValue placeholder="Reserve um celular" />
            </SelectTrigger>
            <SelectContent>
              {ready.map((d) => (
                <SelectItem key={d.serial} value={d.serial}>
                  {d.name} ({d.serial})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <span className="text-muted-foreground text-xs">Ambiente</span>
          <Select value={env} onValueChange={(v) => setEnv(v as typeof env)}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["HML", "PROD", "MOCK"] as const).map((e) => (
                <SelectItem key={e} value={e}>
                  {e}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          disabled={!dev || !tst}
          onClick={() => void onCmd({ type: "giat_run", serial: dev, test: tst, env })}
          data-testid="giat-start"
        >
          <Play className="size-4" /> Rodar
        </Button>
      </CardContent>
    </Card>
  )
}

function Runs({ data, onCmd }: { data: GiatDto; onCmd: (c: Parameters<typeof sendCommand>[0]) => Promise<void> }) {
  return (
    <Card className="gap-3 py-5" data-testid="giat-runs">
      <CardHeader className="px-5">
        <CardTitle>Execuções</CardTitle>
      </CardHeader>
      <CardContent className="px-5">
        {data.runs.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nenhuma execução ainda.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Caso</TableHead>
                <TableHead>Celular</TableHead>
                <TableHead>Resultado</TableHead>
                <TableHead>Início</TableHead>
                <TableHead>Duração</TableHead>
                <TableHead>Arquivos</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.runs.map((r) => (
                <TableRow key={r.id} data-testid="giat-run" data-status={r.status}>
                  <TableCell>
                    <div className="font-mono text-xs">{r.test}</div>
                    <div className="text-muted-foreground text-xs">{r.env}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.serial}</TableCell>
                  <TableCell>
                    <StatusBadge {...RUN_STATUS[r.status]} />
                    {r.summary && (
                      <span className="text-muted-foreground ml-2 text-xs">
                        {r.summary.passed}/{r.summary.total} ok
                      </span>
                    )}
                    {r.message && <div className="text-muted-foreground mt-1 max-w-md text-xs">{r.message}</div>}
                  </TableCell>
                  <TableCell className="text-xs">{formatDateTime(r.startedAt)}</TableCell>
                  <TableCell className="text-xs">{duration(r.startedAt, r.endedAt)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {r.files.map((f) => (
                        <a
                          key={f}
                          href={`/api/giat/files/${r.id}/${encodeURIComponent(f)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
                        >
                          {f.endsWith(".png") ? <ImageIcon className="size-3.5" /> : <FileText className="size-3.5" />}
                          {f}
                        </a>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {active(r.status) && (
                      <Button size="sm" variant="outline" onClick={() => void onCmd({ type: "giat_cancel", runId: r.id })} data-testid="giat-cancel">
                        <Square className="size-4" /> Cancelar
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
