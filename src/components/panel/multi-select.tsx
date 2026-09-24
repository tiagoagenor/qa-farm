"use client"

import { Check, ChevronsUpDown } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export function MultiSelect({
  label,
  options,
  value,
  onChange,
  testId,
}: {
  label: string
  options: Array<{ value: string; count: number }>
  value: ReadonlySet<string>
  onChange: (next: Set<string>) => void
  testId?: string
}) {
  const toggle = (v: string) => {
    const next = new Set(value)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    onChange(next)
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="justify-between gap-2" data-testid={testId}>
          {label}
          {value.size > 0 && <Badge variant="secondary">{value.size}</Badge>}
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[380px] p-0" align="start">
        <Command>
          <CommandInput placeholder={`Buscar ${label.toLowerCase()}…`} />
          <CommandList>
            <CommandEmpty>Nada encontrado.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem key={o.value} value={o.value} onSelect={() => toggle(o.value)}>
                  <Check className={cn("size-4", value.has(o.value) ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{o.value}</span>
                  <span className="text-muted-foreground ml-auto text-xs">{o.count}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {value.size > 0 && (
            <div className="border-t p-1">
              <Button variant="ghost" size="sm" className="w-full" onClick={() => onChange(new Set())}>
                Limpar {label.toLowerCase()}
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
