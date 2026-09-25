"use client"

import { Cloud, Plus, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"

import { StatusBadge } from "@/components/panel/status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { usePoll } from "@/hooks/use-poll"
import { sendCommand } from "@/lib/client"

import type { MachinesDto } from "./machine-admin"

interface BsDto {
  enabled: boolean
  runOn?: string
  slots: Array<{ id: number; device: string; osVersion: string; enabled: boolean }>
  status: {
    updatedAt: string
    configured: boolean
    user: string
    plan: {
      parallel_sessions_running: number
      parallel_sessions_max_allowed: number
      queued_sessions?: number
    } | null
    error?: string
    ourRunning: number
  } | null
  devices: Array<{ device: string; os: string; os_version: string }>
}

/** BrowserStack como mais uma fonte de celulares: liga/desliga, vagas (modelo + Android) e uso da conta. */
export function BrowserStackCard() {
  const { data, reload } = usePoll<BsDto>("/api/browserstack", 4000)
  const { data: machines } = usePoll<MachinesDto>("/api/machines", 10_000)
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState("")
  const options = useMemo(
    () =>
      (data?.devices ?? [])
        .map((d) => ({
          value: `${d.device}|${d.os_version}`,
          label: `${d.device} · Android ${d.os_version}`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, "pt-BR")),
    [data?.devices],
  )

  async function run(cmd: Parameters<typeof sendCommand>[0]) {
    setBusy(true)
    await sendCommand(cmd)
    setBusy(false)
    void reload()
  }

  const st = data?.status
  const plan = st?.plan
  const configured = st?.configured ?? false
  return (
    <Card className="mt-6 gap-4 py-5" data-testid="browserstack-card">
      <CardHeader className="flex flex-row items-start justify-between gap-3 px-5">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Cloud className="size-5" /> BrowserStack
            {data && (
              <StatusBadge
                label={data.enabled ? "Ligado" : "Desligado"}
                tone={data.enabled ? "ok" : "muted"}
              />
            )}
          </CardTitle>
          <CardDescription>
            Celulares reais na nuvem como mais uma fonte da fazenda. Cada vaga roda um caso por vez no modelo
            escolhido; a conta é compartilhada com o time (o painel sempre deixa 1 sessão livre).
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="bs-on" className="text-sm">
            {data?.enabled ? "Ligado" : "Desligado"}
          </Label>
          <Switch
            id="bs-on"
            checked={!!data?.enabled}
            disabled={busy || !configured}
            onCheckedChange={(v) => run({ type: "bs_set_enabled", enabled: v })}
            data-testid="bs-enabled"
          />
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 px-5 text-sm">
        {!configured ? (
          <p
            className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
            data-testid="bs-not-configured"
          >
            Credenciais não configuradas: defina QAFARM_BS_USER e QAFARM_BS_KEY no .env do painel (servidor
            mestre) e reinicie o painel.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs" data-testid="bs-plan">
            <span>
              Conta: <b>{st?.user}</b>
            </span>
            {plan && (
              <span>
                Sessões em uso: <b>{plan.parallel_sessions_running}</b> de{" "}
                {plan.parallel_sessions_max_allowed} (nossas: {st?.ourRunning ?? 0}
                {plan.queued_sessions ? ` · na fila do BrowserStack: ${plan.queued_sessions}` : ""})
              </span>
            )}
            {st?.error && <span className="text-red-700 dark:text-red-400">{st.error}</span>}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3" data-testid="bs-run-on">
          <Label className="text-sm">Robot dos casos roda em</Label>
          <Select
            value={data?.runOn ?? "__master"}
            disabled={busy || !machines}
            onValueChange={(v) => run({ type: "bs_set_run_on", machineId: v === "__master" ? null : v })}
          >
            <SelectTrigger className="w-64" data-testid="bs-run-on-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__master">{machines?.master.id ?? "mestre"} (mestre)</SelectItem>
              {(machines?.machines ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                  {m.status?.robotReady === false ? " (robot não instalado)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground text-xs">
            O celular fica na nuvem; só o processo do Robot roda aqui. Com a máquina escolhida fora do ar, os casos do
            BrowserStack esperam.
          </span>
        </div>

        <div className="grid gap-2">
          <p className="font-medium">Vagas</p>
          {(data?.slots ?? []).length === 0 && (
            <p className="text-muted-foreground text-xs">Nenhuma vaga. Adicione um modelo abaixo.</p>
          )}
          {(data?.slots ?? []).map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-3 rounded-md border px-3 py-2"
              data-testid="bs-slot"
              data-slot={s.id}
            >
              <span className="text-muted-foreground w-10 text-xs">#{s.id}</span>
              <span className="flex-1">
                {s.device} · Android {s.osVersion}
              </span>
              <Label htmlFor={`bs-slot-${s.id}`} className="text-muted-foreground text-xs">
                Usar nos testes
              </Label>
              <Switch
                id={`bs-slot-${s.id}`}
                checked={s.enabled}
                disabled={busy}
                onCheckedChange={(v) => run({ type: "bs_set_slot_enabled", id: s.id, enabled: v })}
                data-testid="bs-slot-switch"
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Remover vaga ${s.id}`}
                disabled={busy}
                onClick={() => run({ type: "bs_remove_slot", id: s.id })}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Select value={pick} onValueChange={setPick} disabled={!options.length}>
              <SelectTrigger className="w-80" data-testid="bs-device-select">
                <SelectValue placeholder={options.length ? "Escolha o modelo" : "Carregando modelos…"} />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              disabled={busy || !pick}
              data-testid="bs-add-slot"
              onClick={() => {
                const [device, osVersion] = pick.split("|")
                void run({ type: "bs_add_slot", device, osVersion })
              }}
            >
              <Plus /> Adicionar vaga
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
