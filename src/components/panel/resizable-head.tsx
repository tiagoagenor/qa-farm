"use client"

import { useRef } from "react"

import { TableHead } from "@/components/ui/table"
import type { ColumnDef } from "@/lib/table-columns"
import { cn } from "@/lib/utils"

const ALIGN = { left: "", right: "text-right", center: "text-center" } as const

/** Cabeçalho com alça na borda direita: arrastar muda a largura; duplo clique volta ao padrão. */
export function ResizableHead({
  col,
  onPreview,
  onCommit,
  onReset,
}: {
  col: ColumnDef & { px: number }
  onPreview: (width: number) => void
  onCommit: () => void
  onReset: () => void
}) {
  const drag = useRef<{ x: number; w: number } | null>(null)
  return (
    <TableHead className={cn("relative select-none", ALIGN[col.align ?? "left"])} data-col={col.key}>
      <span className="block truncate">{col.label}</span>
      {col.resizable !== false && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Ajustar largura da coluna ${col.label || col.key}`}
          title="Arraste para ajustar a largura (duplo clique volta ao padrão)"
          data-testid={`resize-${col.key}`}
          className="hover:bg-primary/30 active:bg-primary/50 absolute top-0 right-0 z-10 h-full w-2 cursor-col-resize touch-none"
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { x: e.clientX, w: col.px }
          }}
          onPointerMove={(e) => {
            if (drag.current) onPreview(drag.current.w + e.clientX - drag.current.x)
          }}
          onPointerUp={() => {
            if (!drag.current) return
            drag.current = null
            onCommit()
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            onReset()
          }}
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </TableHead>
  )
}
