"use client"

import { Check, Copy, MoreVertical, Plus, Power, RefreshCw } from "lucide-react"
import { useState } from "react"

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
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { usePoll } from "@/hooks/use-poll"
import { sendCommand } from "@/lib/client"
import type { Tone } from "@/lib/format"

export interface MachineRow {
  id: string
  name: string
  host: string
  sshUser: string
  sshPort: number
  slot: number
  maxDevices: number
  enabled: boolean
  transport: "ssh" | "direct"
  status: {
    state: string
    lastSeenAt?: string
    lastError?: string
    agentVersion?: string
    agentCommit?: string
    tunnel: string
    desired: number
    emulators: number
    farmJob?: { command: string; startedAt: string }
    clockSkewMs?: number
  } | null
}
export interface MachinesDto {
  master: { id: string }
  publicKey: string | null
  machines: MachineRow[]
}

export const MACHINE_STATE: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Pendente", tone: "muted" },
  connecting: { label: "Conectando", tone: "info" },
  online: { label: "Online", tone: "ok" },
  degraded: { label: "Instável", tone: "warn" },
  offline: { label: "Offline", tone: "fail" },
  incompatible: { label: "Agente desatualizado", tone: "warn" },
  draining: { label: "Drenando", tone: "warn" },
  disabled: { label: "Desativada", tone: "muted" },
}

function ago(iso?: string) {
  if (!iso) return "nunca"
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? `há ${s} s` : `há ${Math.round(s / 60)} min`
}

function CopyBox({ text, testId }: { text: string; testId?: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="bg-muted/40 flex items-start gap-2 rounded-md border p-2">
      <code className="min-w-0 flex-1 font-mono text-[11px] break-all" data-testid={testId}>
        {text}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="Copiar"
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(() => {
            setDone(true)
            setTimeout(() => setDone(false), 1200)
          })
        }
      >
        {done ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}

const EMPTY = { id: "", name: "", host: "", sshUser: "", sshPort: "22", maxDevices: "6" }

function MachineDialog({
  open,
  onOpenChange,
  editing,
  publicKey,
  onSaved,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  editing: MachineRow | null
  publicKey: string | null
  onSaved: () => void
}) {
  const [f, setF] = useState(EMPTY)
  const [sending, setSending] = useState(false)
  const [lastOpen, setLastOpen] = useState(false)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open)
      setF(
        editing
          ? { id: editing.id, name: editing.name, host: editing.host, sshUser: editing.sshUser, sshPort: String(editing.sshPort), maxDevices: String(editing.maxDevices) }
          : EMPTY,
      )
  }
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }))
  const idOk = /^[a-z0-9][a-z0-9-]{1,31}$/.test(f.id)
  const valid = idOk && f.name.trim() && f.host.trim() && f.sshUser.trim() && Number(f.sshPort) > 0 && Number(f.maxDevices) >= 1 && Number(f.maxDevices) <= 18

  async function save() {
    setSending(true)
    const common = { name: f.name.trim(), host: f.host.trim(), sshUser: f.sshUser.trim(), sshPort: Number(f.sshPort), maxDevices: Number(f.maxDevices) }
    const r = await sendCommand(editing ? { type: "update_machine", id: editing.id, ...common } : { type: "add_machine", id: f.id, ...common })
    setSending(false)
    if (r?.ok) {
      onOpenChange(false)
      onSaved()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Editar ${editing.name}` : "Adicionar máquina"}</DialogTitle>
          <DialogDescription>
            A máquina vira uma extensão da fazenda: os emuladores dela entram no mesmo conjunto de testes. O mestre ({"este servidor"}) continua
            responsável pelas filas e resultados.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="m-id">ID</Label>
              <Input id="m-id" value={f.id} onChange={set("id")} disabled={!!editing} placeholder="server02" data-testid="machine-id" />
              {!editing && f.id && !idOk && <p className="text-destructive text-xs">Minúsculas, números e hífen (2 a 32).</p>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="m-name">Nome</Label>
              <Input id="m-name" value={f.name} onChange={set("name")} placeholder="server02" data-testid="machine-name" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="m-host">IP ou endereço</Label>
            <Input id="m-host" value={f.host} onChange={set("host")} placeholder="192.168.100.34 ou IP do WireGuard" data-testid="machine-host" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="m-user">Usuário SSH</Label>
              <Input id="m-user" value={f.sshUser} onChange={set("sshUser")} placeholder="server02" data-testid="machine-user" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="m-port">Porta SSH</Label>
              <Input id="m-port" type="number" value={f.sshPort} onChange={set("sshPort")} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="m-max">Máx. emuladores</Label>
              <Input id="m-max" type="number" min={1} max={18} value={f.maxDevices} onChange={set("maxDevices")} data-testid="machine-max" />
            </div>
          </div>
          {!editing && publicKey && (
            <div className="grid gap-1.5 text-xs">
              <p className="text-muted-foreground">
                Antes de testar, autorize o mestre na máquina nova (rode lá, como o usuário SSH):
              </p>
              <CopyBox text={`echo '${publicKey}' >> ~/.ssh/authorized_keys`} testId="authorize-command" />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!valid || sending} data-testid="machine-save">
            {sending ? "Salvando…" : editing ? "Salvar" : "Adicionar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StartDialog({ m, onClose, onDone }: { m: MachineRow | null; onClose: () => void; onDone: () => void }) {
  const [n, setN] = useState("5")
  const num = Number(n)
  const ok = !!m && Number.isInteger(num) && num >= 1 && num <= m.maxDevices
  return (
    <Dialog open={!!m} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Ligar emuladores em {m?.name}</DialogTitle>
          <DialogDescription>Máximo desta máquina: {m?.maxDevices}. A máquina mantém essa quantidade ligada.</DialogDescription>
        </DialogHeader>
        <Input type="number" min={1} max={m?.maxDevices} value={n} onChange={(e) => setN(e.target.value)} data-testid="machine-start-count" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!ok}
            data-testid="machine-start-submit"
            onClick={async () => {
              const r = await sendCommand({ type: "start_devices", count: num, machineId: m!.id })
              if (r?.ok) {
                onClose()
                onDone()
              }
            }}
          >
            <Power /> Ligar {Number.isInteger(num) ? num : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Cadastro das máquinas worker (IP, SSH, agente, ativar/desativar) — o mestre é este servidor. */
export function MachineAdmin() {
  const { data, reload } = usePoll<MachinesDto>("/api/machines", 3000)
  const [dialog, setDialog] = useState<{ open: boolean; editing: MachineRow | null }>({ open: false, editing: null })
  const [removing, setRemoving] = useState<MachineRow | null>(null)
  const [starting, setStarting] = useState<MachineRow | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(cmd: Parameters<typeof sendCommand>[0]) {
    setBusy(true)
    await sendCommand(cmd)
    setBusy(false)
    void reload()
  }

  return (
    <Card className="mt-6 gap-4 py-5" data-testid="machine-admin">
      <CardHeader className="flex flex-row items-start justify-between gap-3 px-5">
        <div>
          <CardTitle>Máquinas da fazenda</CardTitle>
          <CardDescription>Cadastre outras máquinas pelo IP para somar os emuladores delas ao mesmo conjunto de testes.</CardDescription>
        </div>
        <Button onClick={() => setDialog({ open: true, editing: null })} data-testid="add-machine">
          <Plus /> Adicionar máquina
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4 px-5">
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Máquina</TableHead>
                <TableHead>Endereço</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Última resposta</TableHead>
                <TableHead>Agente</TableHead>
                <TableHead className="text-right">Emuladores</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">
                  {data?.master.id ?? "…"} <StatusBadge label="mestre" tone="info" className="ml-1" />
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">este servidor</TableCell>
                <TableCell>
                  <StatusBadge label="Online" tone="ok" />
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">—</TableCell>
                <TableCell className="text-muted-foreground text-xs">painel e runner</TableCell>
                <TableCell className="text-right text-xs">página Celulares</TableCell>
                <TableCell />
              </TableRow>
              {(data?.machines ?? []).map((m) => {
                const st = m.status
                const state = MACHINE_STATE[st?.state ?? "pending"] ?? MACHINE_STATE.pending
                return (
                  <TableRow key={m.id} data-testid="machine-row" data-machine={m.id} data-state={st?.state ?? "pending"}>
                    <TableCell className="font-medium">
                      {m.name}
                      <span className="text-muted-foreground ml-1 text-xs">({m.id})</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {m.transport === "direct" ? "teste" : `${m.sshUser}@${m.host}${m.sshPort !== 22 ? `:${m.sshPort}` : ""}`}
                    </TableCell>
                    <TableCell>
                      <div className="grid gap-0.5">
                        <StatusBadge {...state} />
                        {st?.lastError && (
                          <span className="text-muted-foreground max-w-[260px] truncate text-[11px]" title={st.lastError} data-testid="machine-error">
                            {st.lastError}
                          </span>
                        )}
                        {st?.farmJob && <span className="text-[11px] text-sky-700 dark:text-sky-400">{st.farmJob.command}…</span>}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">{ago(st?.lastSeenAt)}</TableCell>
                    <TableCell className="font-mono text-xs">{st?.agentCommit ? `${st.agentVersion} · ${st.agentCommit}` : "—"}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums" data-testid="machine-emulators">
                      {st?.emulators ?? 0} ligados · alvo {st?.desired ?? 0} · máx {m.maxDevices}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-7" aria-label={`Ações de ${m.name}`} disabled={busy} data-testid="machine-actions">
                            <MoreVertical />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => run({ type: "test_machine", id: m.id })} data-testid="machine-test">
                            <RefreshCw /> Testar conexão
                          </DropdownMenuItem>
                          {m.transport === "ssh" && (
                            <DropdownMenuItem onClick={() => run({ type: "deploy_machine", id: m.id })} data-testid="machine-deploy">
                              Instalar / atualizar agente
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => setStarting(m)} data-testid="machine-start">
                            <Power /> Ligar emuladores…
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => run({ type: "stop_all_devices", machineId: m.id })}>Desligar emuladores</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => run({ type: "set_machine_enabled", id: m.id, enabled: !m.enabled })} data-testid="machine-toggle">
                            {m.enabled ? "Desativar (não recebe casos)" : "Ativar"}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDialog({ open: true, editing: m })}>Editar</DropdownMenuItem>
                          {m.transport === "ssh" && <DropdownMenuItem onClick={() => run({ type: "rotate_machine_token", id: m.id })}>Trocar token</DropdownMenuItem>}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setRemoving(m)} data-testid="machine-remove">
                            Remover
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        {data?.publicKey && (
          <div className="grid gap-1.5 text-xs">
            <p className="text-muted-foreground">Chave pública do mestre (autorize-a em cada máquina nova, no ~/.ssh/authorized_keys do usuário SSH):</p>
            <CopyBox text={data.publicKey} testId="master-public-key" />
          </div>
        )}
      </CardContent>
      <MachineDialog open={dialog.open} editing={dialog.editing} publicKey={data?.publicKey ?? null} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} onSaved={() => void reload()} />
      <StartDialog m={starting} onClose={() => setStarting(null)} onDone={() => void reload()} />
      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              A máquina sai da fazenda (os emuladores dela continuam como estão). Só é permitido sem casos rodando nela.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="confirm-remove-machine"
              onClick={() => {
                const m = removing
                setRemoving(null)
                if (m) void run({ type: "remove_machine", id: m.id })
              }}
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
