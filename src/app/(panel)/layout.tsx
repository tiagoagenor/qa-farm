import { AppShell } from "@/components/panel/app-shell"

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}
