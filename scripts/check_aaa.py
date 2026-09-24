#!/usr/bin/env python3
"""Verifica o padrão AAA nos testes pytest: cada `def test_*` precisa de
"# Arrange", "# Act" e "# Assert" nessa ordem ("# Act & Assert" só com pytest.raises)."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "scripts" / "robot" / "tests"
DECL = re.compile(r"^def (test_\w+)\(", re.M)


def check(path: Path) -> tuple[int, list[str]]:
    src = path.read_text(encoding="utf-8")
    decls = list(DECL.finditer(src))
    problems: list[str] = []
    for i, m in enumerate(decls):
        body = src[m.start() : decls[i + 1].start() if i + 1 < len(decls) else len(src)]
        # corta no próximo bloco de nível superior (classe, constante, def não-teste)
        first_nl = body.find("\n")
        top = re.search(r"^\S", body[first_nl + 1 :], re.M)
        if top:
            body = body[: first_nl + 1 + top.start()]
        where = f"{path.name}:{src[: m.start()].count(chr(10)) + 1} {m.group(1)}"
        arrange, act_assert = body.find("# Arrange"), body.find("# Act & Assert")
        act = next((x.start() for x in re.finditer(r"# Act(?! &)", body)), -1)
        assert_ = body.find("# Assert")
        if arrange < 0:
            problems.append(f"{where}: falta '# Arrange'")
        elif act_assert >= 0:
            if "pytest.raises" not in body:
                problems.append(f"{where}: '# Act & Assert' só com pytest.raises")
        elif act < 0 or assert_ < 0:
            problems.append(f"{where}: falta '# Act' ou '# Assert'")
        elif not (arrange < act < assert_):
            problems.append(f"{where}: ordem deve ser Arrange → Act → Assert")
    return len(decls), problems


def main() -> int:
    total, problems = 0, []
    for f in sorted(ROOT.glob("test_*.py")):
        n, p = check(f)
        total += n
        problems += p
    if problems:
        print(f"check_aaa: {len(problems)} problema(s) em {total} teste(s):\n  " + "\n  ".join(problems), file=sys.stderr)
        return 1
    print(f"check_aaa: {total} teste(s) Python seguem o padrão AAA")
    return 0


if __name__ == "__main__":
    sys.exit(main())
