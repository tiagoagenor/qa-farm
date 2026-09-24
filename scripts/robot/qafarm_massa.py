"""QA Farm: registra a massa de dados que um caso usou, sem alterar o projeto.

Uso: robot --listener /caminho/absoluto/qafarm_massa.py ...

Grava `massa.json` na pasta de saída do Robot, atualizado durante a execução (o painel mostra ao vivo):
  - conta: `Get From Dictionary  ${DATA_MASSA}  ${user}` → nome da conta + usuário/senha
  - gerado: qualquer keyword das bibliotecas geradoras (dataGenerator, FakerLibrary) com atribuição

Só lê o que o Robot já registra no log (mensagens "${var} = valor"); nunca muda o fluxo do caso.
API de listener 2 (a 3 não tem eventos de keyword no Robot 6.1).
"""

from __future__ import annotations

import ast
import json
import os
import re
from typing import Any

ROBOT_LISTENER_API_VERSION = 2

GENERATOR_LIBS = {"dataGenerator", "FakerLibrary"}
MASSA_DICTS = {"${DATA_MASSA}"}
_ASSIGN = re.compile(r"^([$&@]\{[^}]+\}) = (.*)$", re.S)

_stack: list[dict[str, Any]] = []
_entries: list[dict[str, Any]] = []
_seen: set[str] = set()


def _output_dir() -> str | None:
    try:
        from robot.libraries.BuiltIn import BuiltIn

        return BuiltIn().get_variable_value("${OUTPUT DIR}")
    except Exception:  # fora de uma execução do Robot
        return None


def _resolve(text: str) -> str:
    try:
        from robot.libraries.BuiltIn import BuiltIn

        return str(BuiltIn().replace_variables(text))
    except Exception:
        return text


def _save() -> None:
    out = _output_dir()
    if not out:
        return
    tmp = os.path.join(out, "massa.json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"entries": _entries}, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, os.path.join(out, "massa.json"))


def classify(libname: str, kwname: str, args: list[str]) -> dict[str, Any] | None:
    """Diz se a keyword é fonte de massa e de que tipo (None = ignorar)."""
    if libname == "Collections" and kwname == "Get From Dictionary" and len(args) >= 2 and args[0] in MASSA_DICTS:
        return {"kind": "conta", "account": args[1]}
    if libname in GENERATOR_LIBS:
        return {"kind": "gerado", "source": f"{libname}.{kwname}"}
    return None


def parse_value(text: str) -> Any:
    """Valor como o Robot escreveu no log: dicionário/lista em repr Python ou texto puro."""
    if text[:1] in "{[(":
        try:
            return ast.literal_eval(text)
        except (ValueError, SyntaxError):
            return text
    return text


def entry_from_message(ctx: dict[str, Any], message: str) -> dict[str, Any] | None:
    m = _ASSIGN.match(message)
    if not m:
        return None
    var, value = m.group(1), parse_value(m.group(2))
    if ctx["kind"] == "conta":
        fields = {str(k): str(v) for k, v in value.items()} if isinstance(value, dict) else {"valor": str(value)}
        return {"kind": "conta", "account": ctx["account"], "var": var, "fields": fields}
    return {"kind": "gerado", "source": ctx["source"], "var": var, "value": str(value)}


def reset() -> None:
    _stack.clear()
    _entries.clear()
    _seen.clear()


# ---------------------------------------------------------------- eventos do Robot ---
def start_test(name, attrs):  # noqa: ARG001
    reset()
    _save()


def start_keyword(name, attrs):  # noqa: ARG001
    ctx = classify(attrs.get("libname", ""), attrs.get("kwname", ""), list(attrs.get("args", [])))
    if ctx and ctx["kind"] == "conta":
        ctx["account"] = _resolve(ctx["account"])
    _stack.append(ctx or {})


def end_keyword(name, attrs):  # noqa: ARG001
    if _stack:
        _stack.pop()


def log_message(message):
    if not _stack or not _stack[-1]:
        return
    entry = entry_from_message(_stack[-1], message.get("message", ""))
    if not entry:
        return
    key = json.dumps(entry, sort_keys=True, ensure_ascii=False)
    if key in _seen:  # a mesma conta lida várias vezes no caso aparece uma vez só
        return
    _seen.add(key)
    _entries.append(entry)
    _save()
