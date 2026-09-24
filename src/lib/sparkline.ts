/** Traçado SVG ("M x y L ...") de uma série; `null` interrompe a linha. Escala vertical entre `min` e `max`. */
export function sparkPath(values: Array<number | null>, width: number, height: number, min: number, max: number): string {
  if (values.length === 0) return ""
  const span = max - min || 1
  const stepX = values.length > 1 ? width / (values.length - 1) : 0
  let out = ""
  let pen = false
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false
      return
    }
    const clamped = Math.min(max, Math.max(min, v))
    const x = Math.round(i * stepX * 10) / 10
    const y = Math.round((height - ((clamped - min) / span) * height) * 10) / 10
    out += `${pen ? "L" : "M"}${x} ${y} `
    pen = true
  })
  return out.trim()
}

/** Posição vertical (px) de um valor de referência (linha tracejada de limite). */
export function refY(value: number, height: number, min: number, max: number): number {
  const span = max - min || 1
  return Math.round((height - ((Math.min(max, Math.max(min, value)) - min) / span) * height) * 10) / 10
}
