"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
    setLoading(false)
    if (!r.ok) {
      setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Não foi possível entrar")
      return
    }
    const next = params.get("next")
    router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/filas")
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>QA Farm</CardTitle>
        <CardDescription>Painel de testes em massa. Entre com a senha do painel.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="password">Senha</Label>
            <Input id="password" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && (
            <p className="text-destructive text-sm" role="alert" data-testid="login-error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={loading || !password}>
            {loading ? "Entrando…" : "Entrar"}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

export default function LoginPage() {
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  )
}
