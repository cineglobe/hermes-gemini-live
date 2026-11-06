#!/usr/bin/env python3
"""Generate the two UI bundles from src/ (no Node toolchain needed).

    python scripts/build.py          # write desktop/plugin.js, dashboard/dist/index.js, dashboard/dist/style.css
    python scripts/build.py --check  # exit 1 if any generated file is stale

The Desktop loader takes one uncompiled ESM file and the dashboard one IIFE, and neither may
import the other, so the shared engine is inlined into both. Output stays plain, readable source.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"


def _engine(indent: str = "") -> str:
    text = (SRC / "engine.js").read_text(encoding="utf-8").rstrip() + "\n"
    if not indent:
        return text
    return "".join((indent + line) if line.strip() else line for line in text.splitlines(True))


def outputs() -> dict[Path, str]:
    css = (SRC / "ui.css").read_text(encoding="utf-8")
    desktop = (SRC / "desktop.js").read_text(encoding="utf-8")
    dashboard = (SRC / "dashboard.js").read_text(encoding="utf-8")
    assert "/*@ENGINE@*/" in desktop and "/*@CSS@*/ ''" in desktop, "desktop.js placeholders missing"
    assert "  /*@ENGINE@*/" in dashboard, "dashboard.js placeholder missing"
    desktop = desktop.replace("/*@ENGINE@*/\n", _engine()).replace("/*@CSS@*/ ''", json.dumps(css))
    dashboard = dashboard.replace("  /*@ENGINE@*/\n", _engine("  "))
    return {
        ROOT / "desktop" / "plugin.js": desktop,
        ROOT / "dashboard" / "dist" / "index.js": dashboard,
        ROOT / "dashboard" / "dist" / "style.css": css,
    }


def main() -> int:
    check = "--check" in sys.argv[1:]
    stale = []
    for path, content in outputs().items():
        current = path.read_text(encoding="utf-8") if path.exists() else None
        if current == content:
            continue
        if check:
            stale.append(path.relative_to(ROOT))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            print(f"wrote {path.relative_to(ROOT)}")
    if stale:
        print("stale generated files (run python scripts/build.py): " + ", ".join(map(str, stale)))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
