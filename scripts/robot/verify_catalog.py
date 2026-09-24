"""Confere, com `robot --dryrun`, que o `--test <fileLongName>` de cada caso do catálogo casa exatamente
com um caso quando o robot recebe só o arquivo (como o runner executa).

Uso: python verify_catalog.py <raiz do projeto> <catalog.json>
Saída: JSON {"files": N, "cases": N, "matched": N, "problems": [...]} ; código 0 se tudo casou.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path


def escape(name: str) -> str:
    return re.sub(r"[\[*?]", lambda m: f"[{m.group(0)}]", name)


def verify(project: Path, catalog_path: Path) -> dict:
    entries = json.loads(catalog_path.read_text(encoding="utf-8"))["entries"]
    by_file: dict[str, list[dict]] = defaultdict(list)
    for e in entries:
        by_file[e["file"]].append(e)
    problems: list[str] = []
    matched = 0
    robot_bin = str(Path(sys.executable).parent / "robot")
    with tempfile.TemporaryDirectory() as tmp:
        for i, (rel, items) in enumerate(sorted(by_file.items())):
            argfile = Path(tmp) / f"args{i}.txt"
            argfile.write_text("".join(f"--test {escape(e['fileLongName'])}\n" for e in items), encoding="utf-8")
            out = Path(tmp) / f"out{i}.xml"
            subprocess.run(
                [robot_bin, "--dryrun", "--output", str(out), "--log", "NONE", "--report", "NONE",
                 "-A", str(argfile), rel],
                cwd=project, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=os.environ.copy(),
            )
            if not out.exists():
                problems.append(f"{rel}: robot não gerou output")
                continue
            xml = out.read_text(encoding="utf-8")
            ran = [m.group(1) for m in re.finditer(r'<test id="[^"]+" name="([^"]*)"', xml)]
            ran_decoded = [
                n.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'")
                for n in ran
            ]
            expected = [e["name"] for e in items]
            if sorted(ran_decoded) != sorted(expected):
                missing = sorted(set(expected) - set(ran_decoded))
                extra = sorted(set(ran_decoded) - set(expected))
                problems.append(f"{rel}: faltando={missing[:3]} extra={extra[:3]}")
            matched += len(set(ran_decoded) & set(expected))
    return {"files": len(by_file), "cases": len(entries), "matched": matched, "problems": problems}


if __name__ == "__main__":
    result = verify(Path(sys.argv[1]), Path(sys.argv[2]))
    print(json.dumps(result, ensure_ascii=False, indent=1))
    sys.exit(0 if not result["problems"] and result["matched"] == result["cases"] else 1)
