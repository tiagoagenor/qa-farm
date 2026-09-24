"use client"

import { Camera, ChevronDown, MoreVertical, Power, RefreshCw, RotateCw } from "lucide-react"
import Link from "next/link"
import { useState } from "react"

import type { Device } from "@/core/types"
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { usePoll } from "@/hooks/use-poll"
import { sendCommand } from "@/lib/client"
import { DEVICE_STATE } from "@/lib/format"

interface DevicesDto {
  updatedAt: string | null
  devices: Device[]
  adbRaw: string
  desired: number
  farmJob: { command: string; startedAt: string } | null
  activeAppId: string | null
}

function ScreenDialog({ serial, onClose }: { serial: string | null; onClose: () => void }) {
  const [nonce, setNonce] = useState(0)
  return (
    <Dialog open={!!serial} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Tela de {serial}</DialogTitle>
          <DialogDescription>Print tirado agora (cache de 10 s).</DialogDescription>
        </DialogHeader>
        {serial && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={nonce}
            src={`/api/devices/${encodeURIComponent(serial)}/screen?n=${nonce}`}
            alt={`Tela de ${serial}`}
            className="mx-auto max-h-[65vh] rounded-md border"
            data-testid="device-screen"
          />
        )}
        <Button variant="outline" onClick={() => setNonce((n) => n + 1)}>
          <RefreshCw /> Atualizar
        </Button>
      </DialogContent>
    </Dialog>
  )
}

export function DeviceGrid() {
  const { data, loading, reload } = usePoll<DevicesDto>("/api/devices", 3000)
  const [count, setCount] = useState("15")
  const [screen, setScreen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const devices = data?.devices ?? []
  const emulators = devices.filter((d) => d.kind === "emulator")
  const physicalOn = devices.filter((d) => d.kind === "physical" && d.enabled).length

  async function run(cmd: Parameters<typeof sendCommand>[0]) {
    setBusy(true)
    await sendCommand(cmd)
    setBusy(false)
    void reload()
  }

  const n = Number(count)
  const validCount = Number.isInteger(n) && n >= 1 && n <= 18

  return (
    <div>
      <PageHeader
        title="Celulares"
        description={`${emulators.filter((d) => d.state === "ready").length} pronto(s), ${emulators.filter((d) => d.state === "busy").length} ocupado(s) de ${emulators.length} emulador(es)${data?.desired ? ` · alvo: ${data.desired}` : ""}${physicalOn ? ` · ${physicalOn} aparelho(s) físico(s) ativado(s)` : ""}. Cada emulador tem 2 GB de RAM.`}
        actions={
          <>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={18}
                className="w-20"
                value={count}
                onChange={(e) => setCount(e.target.value)}
                aria-label="Quantidade de celulares"
                data-testid="start-count"
              />
              <Button disabled={!validCount || busy} onClick={() => run({ type: "start_devices", count: n })} data-testid="start-devices">
                <Power /> Ligar
              </Button>
            </div>
            <Button variant="outline" disabled={busy} onClick={() => run({ type: "restart_appiums" })}>
              <RotateCw /> Reiniciar Appiums
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={busy || emulators.length === 0}>
                  Desligar todos
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Desligar todos os emuladores?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Só é permitido sem casos em execução. Os dados dos celulares são mantidos. O aparelho físico não é afetado.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Voltar</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => run({ type: "stop_all_devices" })}>
                    Desligar
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        }
      />
      {data?.farmJob && (
        <div className="mb-4 rounded-md border border-sky-500/40 bg-sky-500/10 p-3 text-sm">
          Em andamento: {data.farmJob.command} (desde {new Date(data.farmJob.startedAt).toLocaleTimeString("pt-BR")})…
        </div>
      )}
      {loading && !data ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : devices.length === 0 ? (
        <EmptyState title="Nenhum celular no ADB">Informe a quantidade e clique em Ligar.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {devices.map((d) => (
            <Card key={d.serial} className="gap-3 py-4" data-testid="device-card" data-serial={d.serial} data-state={d.state}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 px-4">
                <div className="min-w-0">
                  <CardTitle className="truncate font-mono text-sm">{d.serial}</CardTitle>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {d.kind === "emulator" ? `${d.name} · emulador` : `${d.model ?? "aparelho"} · físico`}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <StatusBadge {...DEVICE_STATE[d.state]} />
                  {d.kind === "emulator" && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="size-7" aria-label={`Ações de ${d.serial}`}>
                          <MoreVertical />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem disabled={d.state === "busy"} onClick={() => run({ type: "restart_device", serial: d.serial })}>
                          <RotateCw /> Reiniciar celular
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </CardHeader>
              <CardContent className="grid gap-2 px-4 text-xs">
                {d.kind === "physical" && (
                  <div className="bg-muted/40 flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                    <div className="grid gap-0.5">
                      <Label htmlFor={`use-${d.serial}`} className="text-xs font-medium">
                        Usar nos testes
                      </Label>
                      <span className="text-muted-foreground text-[11px]">
                        {d.enabled ? "Recebe casos das filas" : "Desativado — não recebe casos"}
                      </span>
                    </div>
                    <Switch
                      id={`use-${d.serial}`}
                      checked={!!d.enabled}
                      disabled={busy || (d.enabled && d.state === "busy")}
                      onCheckedChange={(v) => run({ type: "set_physical", serial: d.serial, enabled: v })}
                      aria-label={`Usar ${d.serial} nos testes`}
                      data-testid="physical-switch"
                    />
                  </div>
                )}
                {d.appVersionCode !== undefined && <p className="text-muted-foreground">App instalado: versionCode {d.appVersionCode}</p>}
                {d.state === "busy" && d.currentQueueId && (
                  <p className="truncate">
                    Rodando:{" "}
                    <Link href={`/filas/${d.currentQueueId}`} className="font-medium underline" title={d.currentTestName}>
                      {d.currentTestName}
                    </Link>
                  </p>
                )}
                {d.note && <p className="text-muted-foreground">{d.note}</p>}
                {d.adbState === "device" && (
                  <Button variant="outline" size="sm" className="w-fit" onClick={() => setScreen(d.serial)}>
                    <Camera /> Ver tela
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Collapsible className="mt-6">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm">
            <ChevronDown /> Diagnóstico (adb devices -l)
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="bg-muted/40 mt-2 overflow-auto rounded-md border p-3 font-mono text-xs">{data?.adbRaw || "(vazio)"}</pre>
        </CollapsibleContent>
      </Collapsible>
      <ScreenDialog serial={screen} onClose={() => setScreen(null)} />
    </div>
  )
}
