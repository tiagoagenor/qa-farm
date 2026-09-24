#!/usr/bin/env node
// "Appium" mínimo para testes: escuta em --port e responde /wd/hub/status e /wd/hub/appium/sessions.
import http from "node:http"
const args = process.argv.slice(2)
const port = Number(args[args.indexOf("--port") + 1])
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json")
  if (req.url?.endsWith("/status")) return res.end(JSON.stringify({ value: { ready: true } }))
  if (req.url?.endsWith("/appium/sessions")) return res.end(JSON.stringify({ value: [] }))
  res.statusCode = 404
  res.end("{}")
})
server.on("error", () => process.exit(1)) // porta ocupada → morre, como o Appium real
server.listen(port, "127.0.0.1")
process.on("SIGTERM", () => process.exit(0))
