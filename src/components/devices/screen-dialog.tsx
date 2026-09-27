"use client"

import { RefreshCw } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

/** Print da tela do celular (emulador/físico pelo adb; vaga do BrowserStack pela sessão em andamento), com Atualizar. */
export function ScreenDialog({ serial, onClose }: { serial: string | null; onClose: () => void }) {
  const [nonce, setNonce] = useState(0)
  const [shot, setShot] = useState<{ url: string; at: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const cloud = !!serial?.startsWith("browserstack:")
  useEffect(() => {
    if (!serial) return
    let alive = true
    let url: string | null = null
    setLoading(true)
    setErr(null)
    void fetch(`/api/devices/${encodeURIComponent(serial)}/screen?n=${nonce}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Erro ${r.status}`,
          )
        url = URL.createObjectURL(await r.blob())
        if (alive) setShot({ url, at: Number(r.headers.get("X-Captured-At")) || Date.now() })
      })
      .catch((e: Error) => alive && setErr(e.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [serial, nonce])
  useEffect(() => {
    if (!serial) setShot(null)
  }, [serial])
  return (
    <Dialog open={!!serial} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Tela de {serial}</DialogTitle>
          <DialogDescription>
            {cloud
              ? "Print da sessão do BrowserStack em andamento. Atualize quando quiser."
              : "Print tirado agora (cache de 10 s)."}
            {shot && !err && <> · capturado às {new Date(shot.at).toLocaleTimeString("pt-BR")}</>}
          </DialogDescription>
        </DialogHeader>
        {err ? (
          <p
            className="text-muted-foreground rounded-md border p-4 text-sm"
            data-testid="device-screen-error"
          >
            {err}
          </p>
        ) : (
          shot && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={shot.url}
              alt={`Tela de ${serial}`}
              className={`mx-auto max-h-[65vh] rounded-md border ${loading ? "opacity-60" : ""}`}
              data-testid="device-screen"
            />
          )
        )}
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => setNonce((n) => n + 1)}
          data-testid="device-screen-refresh"
        >
          <RefreshCw className={loading ? "animate-spin" : ""} /> Atualizar
        </Button>
      </DialogContent>
    </Dialog>
  )
}
