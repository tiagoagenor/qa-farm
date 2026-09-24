"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"

import type { AppMeta, Env } from "@/core/types"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { getJson, sendCommand } from "@/lib/client"

function defaultName() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `Fila ${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function CreateQueueDialog({
  open,
  onOpenChange,
  testIds,
  onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  testIds: string[]
  onCreated?: () => void
}) {
  const router = useRouter()
  const [apps, setApps] = useState<AppMeta[] | null>(null)
  const [name, setName] = useState(defaultName)
  const [appId, setAppId] = useState("")
  const [env, setEnv] = useState<Env>("hml")
  const [timeoutMin, setTimeoutMin] = useState("15")
  const [retries, setRetries] = useState("0")
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(defaultName())
    getJson<{ apps: AppMeta[] }>("/api/apps")
      .then((r) => {
        setApps(r.apps)
        setAppId((cur) => cur || r.apps[0]?.id || "")
      })
      .catch(() => setApps([]))
  }, [open])

  const timeoutSec = Math.round(Number(timeoutMin) * 60)
  const valid = name.trim() && appId && timeoutSec >= 10 && Number.isInteger(Number(retries))

  async function submit() {
    setSending(true)
    const res = await sendCommand({
      type: "create_queue",
      input: { name: name.trim(), appId, env, timeoutSec, retries: Number(retries), testIds },
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
            <Input id="q-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
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
