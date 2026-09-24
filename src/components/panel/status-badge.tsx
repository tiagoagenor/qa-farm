import { Badge } from "@/components/ui/badge"
import { TONE_CLASS, type Tone } from "@/lib/format"
import { cn } from "@/lib/utils"

export function StatusBadge({ tone, label, className }: { tone: Tone; label: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium whitespace-nowrap", TONE_CLASS[tone], className)} data-tone={tone}>
      {label}
    </Badge>
  )
}
