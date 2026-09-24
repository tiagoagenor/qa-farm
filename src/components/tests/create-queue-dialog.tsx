"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"

import type { AppMeta, CatalogEntry, Env } from "@/core/types"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { getJson, sendCommand } from "@/lib/client"
import { defaultQueueName } from "@/lib/queue-name"

export function CreateQueueDialog({
  open,
  onOpenChange,
  entries,
  onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  entries: CatalogEntry[]
  onCreated?: () => void
}) {
  const testIds = entries.map((e) => e.id)
  const router = useRouter()
  const [apps, setApps] = useState<AppMeta[] | null>(null)
  const [name, setName] = useState("")
  const [nameTouched, setNameTouched] = useState(false)
  const [appId, setAppId] = useState("")
  const [env, setEnv] = useState<Env>("hml")
  const [timeoutMin, setTimeoutMin] = useState("15")
  const [retries, setRetries] = useState("0")
  const [closeAppAfter, setCloseAppAfter] = useState(true)
  const [allowSameAccount, setAllowSameAccount] = useState(true)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!open) return
    setNameTouched(false)
    getJson<{ apps: AppMeta[] }>("/api/apps")
      .then((r) => {
        setApps(r.apps)
        setAppId((cur) => cur || r.apps[0]?.id || "")
      })
      .catch(() => setApps([]))
  }, [open])

  // nome sugerido: "{versão-build} {pasta}" ou "{versão-build} Fila {data}" — acompanha o APK escolhido
  const app = apps?.find((a) => a.id === appId) ?? null
  const suggested = defaultQueueName(app, entries)
  useEffect(() => {
    if (open && !nameTouched) setName(suggested)
  }, [open, nameTouched, suggested])

  const timeoutSec = Math.round(Number(timeoutMin) * 60)
  const valid = name.trim() && appId && timeoutSec >= 10 && Number.isInteger(Number(retries))

  async function submit() {
    setSending(true)
    const res = await sendCommand({
      type: "create_queue",
      input: { name: name.trim(), appId, env, timeoutSec, retries: Number(retries), closeAppAfter, allowSameAccount, testIds },
    })
    setSending(false)
    if (res?.ok && res.data?.queueId) {
      onOpenChange(false)
      onCreated?.()
      router.push(`/filas/${res.data.queueId}`)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Criar fila com {testIds.length} caso(s)</DialogTitle>
          <DialogDescription>Cada celular livre pega o próximo caso da fila automaticamente.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="q-name">Nome</Label>
            <Input
              id="q-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setNameTouched(true)
              }}
              maxLength={120}
              data-testid="queue-name"
            />
          </div>
          <div className="grid gap-2">
            <Label>App</Label>
            {apps && apps.length === 0 ? (
              <p className="text-destructive text-sm">Nenhum APK enviado. Envie um na página Apps.</p>
            ) : (
              <Select value={appId} onValueChange={setAppId}>
                <SelectTrigger data-testid="queue-app">
                  <SelectValue placeholder="Escolha o APK" />
                </SelectTrigger>
                <SelectContent>
                  {(apps ?? []).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.versionName} ({a.versionCode}) · {a.originalName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-2">
              <Label>Ambiente</Label>
              <Select value={env} onValueChange={(v) => setEnv(v as Env)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hml">hml</SelectItem>
                  <SelectItem value="dev">dev</SelectItem>
                  <SelectItem value="pre">pre</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="q-timeout">Timeout (min)</Label>
              <Input id="q-timeout" type="number" min={0.2} step={0.5} value={timeoutMin} onChange={(e) => setTimeoutMin(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Tentativas extras</Label>
              <Select value={retries} onValueChange={setRetries}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["0", "1", "2", "3"].map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md border p-3">
            <div className="grid gap-1">
              <Label htmlFor="q-same-account">Usar vários celulares com a mesma conta</Label>
              <p className="text-muted-foreground text-xs">
                Os casos saem em sequência para qualquer celular livre, mesmo usando a mesma conta (cada caso faz o próprio
                login). Desligue se o app derrubar a sessão quando a conta entra em outro aparelho.
              </p>
            </div>
            <Switch
              id="q-same-account"
              checked={allowSameAccount}
              onCheckedChange={setAllowSameAccount}
              data-testid="queue-same-account"
            />
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md border p-3">
            <div className="grid gap-1">
              <Label htmlFor="q-close-app">Fechar o app ao terminar cada caso</Label>
              <p className="text-muted-foreground text-xs">
                Evita que o app fique aberto (tocando vídeo) no celular parado, gastando CPU e memória do servidor.
              </p>
            </div>
            <Switch id="q-close-app" checked={closeAppAfter} onCheckedChange={setCloseAppAfter} data-testid="queue-close-app" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!valid || sending} data-testid="create-queue-submit">
            {sending ? "Criando…" : "Criar fila"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
