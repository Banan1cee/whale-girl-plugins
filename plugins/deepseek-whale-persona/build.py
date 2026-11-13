#!/usr/bin/env python3
"""Build the 鲸鲸 persona package from src/persona.txt.

ZIP layout (must stay exactly this, see market validate.py):
  plugin.json   -- manifest, copied verbatim from the repo root
  persona.json  -- {"customPrompt": "<persona text>"}

Run:  python build.py
"""
import hashlib
import json
import re
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src" / "persona.txt"
MANIFEST = ROOT / "plugin.json"
DIST = ROOT / "dist"
MAX_CHARS = 24000


def read_manifest():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8-sig"))
    version = manifest["Version"]
    return manifest, version


def read_prompt():
    text = SRC.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    text = "\n".join(line.rstrip() for line in text.split("\n")).strip()
    if not text:
        sys.exit("persona.txt is empty")
    if len(text) > MAX_CHARS:
        sys.exit(f"persona text is {len(text)} chars, hard limit is {MAX_CHARS}")
    if re.search(r"^#{1,6}\s", text, re.M):
        sys.exit("persona.txt must not use Markdown headings")
    return text


def add(zf, name, data):
    info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
    info.compress_type = ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    zf.writestr(info, data)


def main():
    manifest, version = read_manifest()
    text = read_prompt()
    DIST.mkdir(exist_ok=True)
    out = DIST / f"{manifest['Id']}-{version}.zip"

    manifest_bytes = MANIFEST.read_bytes()
    persona_bytes = json.dumps(
        {"customPrompt": text}, ensure_ascii=False, indent=2
    ).encode("utf-8")

    with ZipFile(out, "w", ZIP_DEFLATED) as zf:
        add(zf, "plugin.json", manifest_bytes)
        add(zf, "persona.json", persona_bytes)

    blob = out.read_bytes()
    print(f"built   {out}")
    print(f"prompt  {len(text)} chars")
    print(f"zip     {len(blob)} bytes")
    print(f"sha256  {hashlib.sha256(blob).hexdigest()}  (market CI computes its own; for reference only)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
