"use client"

import { Check, Copy, Eye, EyeOff } from "lucide-react"
import { useState } from "react"

import { isSecretField } from "@/core/massa"
import type { MassaEntry } from "@/core/types"
import { Button } from "@/components/ui/button"

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6"
      aria-label={`Copiar ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
    >
      {done ? <Check className="size-3" /> : <Copy className="size-3" />}
    </Button>
  )
}

function Field({ name, value }: { name: string; value: string }) {
  const secret = isSecretField(name)
  const [show, setShow] = useState(false)
  return (
    <div className="flex items-center gap-2 text-xs" data-testid="massa-field">
      <span className="text-muted-foreground w-28 shrink-0 truncate">{name}</span>
      <span className="min-w-0 flex-1 truncate font-mono" title={secret && !show ? undefined : value}>
        {secret && !show ? "••••••" : value}
      </span>
      {secret && (
        <Button variant="ghost" size="icon" className="size-6" aria-label={show ? "Esconder" : "Mostrar"} onClick={() => setShow((s) => !s)}>
          {show ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
        </Button>
      )}
      <CopyButton value={value} label={name} />
    </div>
  )
}

/** Massa de dados que o caso usou: contas (usuário/senha) e dados gerados durante a execução. */
export function MassaView({ entries, live, accounts }: { entries?: MassaEntry[]; live?: boolean; accounts?: string[] }) {
  const list = entries ?? []
  return (
    <div className="rounded-md border p-3" data-testid="massa">
      <p className="mb-2 text-xs font-medium">Massa usada {live && <span className="text-muted-foreground font-normal">(ao vivo)</span>}</p>
      {list.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {live ? "O caso ainda não leu a massa." : "Nenhuma massa registrada nesta tentativa."}
          {!!accounts?.length && ` Conta prevista no caso: ${accounts.join(", ")}.`}
        </p>
      ) : (
        <div className="grid gap-3">
          {list.map((e, i) =>
            e.kind === "conta" ? (
              <div key={i} className="grid gap-1">
                <p className="font-mono text-xs font-semibold">{e.account}</p>
                {Object.entries(e.fields).map(([k, v]) => (
                  <Field key={k} name={k} value={v} />
                ))}
              </div>
            ) : (
              <div key={i} className="grid gap-1">
                <Field name={e.var.replace(/^[$&@]\{|\}$/g, "")} value={e.value} />
                <p className="text-muted-foreground pl-30 text-[10px]">gerado por {e.source}</p>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  )
}
