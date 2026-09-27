"use client"

import { Camera, MonitorPlay } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * Botão da tela do celular de um caso rodando: "Ao vivo" (emulador/físico, se o serviço de tela estiver no ar)
 * ou "Ver tela" (vaga do BrowserStack, ou tela ao vivo desligada).
 */
export function LiveButton({
  serial,
  liveOn,
  onLive,
  onScreen,
  size = "sm",
}: {
  serial: string
  liveOn: boolean
  onLive: (serial: string) => void
  onScreen: (serial: string) => void
  size?: "sm" | "xs"
}) {
  const cloud = serial.startsWith("browserstack:")
  const live = liveOn && !cloud
  const label = live ? "Ao vivo" : "Ver tela"
  return (
    <Button
      variant="ghost"
      size="icon"
      className={size === "xs" ? "size-6" : "size-7"}
      title={label}
      aria-label={`${label} — ${serial}`}
      onClick={(e) => {
        e.stopPropagation()
        if (live) onLive(serial)
        else onScreen(serial)
      }}
      data-testid={live ? "item-live" : "item-screen"}
    >
      {live ? <MonitorPlay className="size-4" /> : <Camera className="size-4" />}
    </Button>
  )
}
