"""Gera o catálogo de casos Robot do projeto (JSON), sem executar nada.

Uso: python catalog.py <raiz do projeto> <arquivo de saída .json> [hash do snapshot]

Cada arquivo .robot em scenarios/ é construído sozinho (como o runner vai executá-lo), então
`fileLongName` = "<suíte do arquivo>.<nome do caso>" casa com `robot --test ... <arquivo>`.
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Iterable

from robot.running.builder import TestSuiteBuilder

ACCOUNT_RE = re.compile(r"\busuario_[a-z0-9_]+", re.IGNORECASE)
VAR_RE = re.compile(r"\$\{([^}]+)\}")


def _texts(items: Iterable[Any]) -> Iterable[str]:
    """Nomes e argumentos de keywords, recursivamente (FOR/IF/TRY têm .body)."""
    for obj in items or ():
        name = getattr(obj, "name", None)
        if isinstance(name, str):
            yield name
        for arg in getattr(obj, "args", ()) or ():
            if isinstance(arg, str):
                yield arg
        for attr in ("body", "orelse", "branches", "handlers"):
            child = getattr(obj, attr, None)
            if child is None:
                continue
            if hasattr(child, "__iter__"):
                yield from _texts(child)
            else:
                yield from _texts([child])


def _file_variables(suite: Any) -> dict[str, str]:
    """Variáveis da seção *** Variables *** do próprio arquivo (nome normalizado → texto)."""
    out: dict[str, str] = {}
    for var in getattr(suite.resource, "variables", ()) or ():
        name = var.name.strip("${}@&%").lower().replace(" ", "").replace("_", "")
        out[name] = " ".join(str(v) for v in var.value)
    return out


def accounts_for(test: Any, file_vars: dict[str, str]) -> list[str]:
    found: set[str] = set()
    items = [test.setup, *test.body] if getattr(test, "setup", None) else list(test.body)
    for text in _texts(items):
        found.update(m.lower() for m in ACCOUNT_RE.findall(text))
        for ref in VAR_RE.findall(text):
            val = file_vars.get(ref.lower().replace(" ", "").replace("_", ""))
            if val:
                found.update(m.lower() for m in ACCOUNT_RE.findall(val))
    return sorted(found)


def build_catalog(project: Path, snapshot_hash: str = "") -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    for path in sorted((project / "scenarios").rglob("*.robot")):
        rel = path.relative_to(project).as_posix()
        suite = TestSuiteBuilder(process_curdir=False, allow_empty_suite=True).build(str(path))
        file_vars = _file_variables(suite)
        seen: dict[str, int] = {}
        for test in suite.tests:
            seen[test.name] = seen.get(test.name, 0) + 1
        for test in suite.tests:
            entries.append(
                {
                    "id": f"{rel}::{test.name}",
                    "name": test.name,
                    "fileLongName": f"{suite.name}.{test.name}",
                    "suite": suite.name,
                    "file": rel,
                    "folder": path.parent.relative_to(project).as_posix(),
                    "line": int(getattr(test, "lineno", 0) or 0),
                    "tags": sorted(str(t) for t in test.tags),
                    "accounts": accounts_for(test, file_vars),
                    "duplicate": seen[test.name] > 1,
                }
            )
    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "snapshotHash": snapshot_hash,
        "total": len(entries),
        "entries": entries,
    }


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    project, out = Path(argv[1]), Path(argv[2])
    data = build_catalog(project, argv[3] if len(argv) > 3 else "")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(out)
    print(json.dumps({"total": data["total"], "out": str(out)}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
