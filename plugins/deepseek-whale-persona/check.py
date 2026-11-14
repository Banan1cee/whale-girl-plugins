#!/usr/bin/env python3
"""Offline check of a built persona ZIP against the rules in
Banan1cee/whale-girl-plugins/validate.py (persona branch of check_entry).

It does not download anything: the catalog rules that involve SHA-256 /
Download URLs do not apply to a locally installed ZIP.

Run:  python check.py [path/to.zip]
"""
import json
import re
import stat
import sys
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent
VERSION = re.compile(r"^\d+\.\d+\.\d+(\.\d+)?$", re.ASCII)
ID_RE = re.compile(r"[a-z][a-z0-9-]{0,47}")
RESERVED = re.compile(r"con|prn|aux|nul|com[1-9]|lpt[1-9]")
LIMIT = 1024 * 1024
MAX_PROMPT = 24000

failures = []


def check(ok, message):
    if ok:
        print(f"  ok    {message}")
    else:
        print(f"  FAIL  {message}")
        failures.append(message)


def main(path):
    print(f"checking {path}")
    blob = path.read_bytes()
    check(len(blob) <= LIMIT, f"zip <= 1 MiB ({len(blob)} bytes)")

    with ZipFile(path) as package:
        names = package.namelist()
        check(sorted(names) == ["persona.json", "plugin.json"],
              f"zip contains exactly plugin.json + persona.json -> {names}")
        for item in package.infolist():
            check(not item.flag_bits & 1, f"{item.filename}: not encrypted")
            check(not stat.S_ISLNK(item.external_attr >> 16), f"{item.filename}: not a symlink")
        check(package.getinfo("plugin.json").file_size <= 8192, "plugin.json <= 8 KiB")
        check(package.getinfo("persona.json").file_size <= 65536, "persona.json <= 64 KiB")

        manifest = json.loads(package.read("plugin.json"))
        preset = json.loads(package.read("persona.json"))

    plugin_id = manifest.get("Id", "")
    check(isinstance(plugin_id, str) and bool(ID_RE.fullmatch(plugin_id))
          and not RESERVED.fullmatch(plugin_id), f"Id is a valid lowercase slug: {plugin_id}")
    check(manifest.get("Api") == 1, "Api == 1")
    check(manifest.get("Kind") == "persona", "Kind == 'persona'")
    check(manifest.get("HostAction") is None, "HostAction absent (persona cannot declare one)")
    check(not manifest.get("Hooks"), "Hooks absent")
    check(not manifest.get("Permissions"), "Permissions absent")
    for field in ("Name", "Author"):
        value = manifest.get(field)
        check(isinstance(value, str) and 0 < len(value.strip()) <= 80, f"{field} is 1..80 chars: {value}")
    description = manifest.get("Description")
    check(isinstance(description, str) and len(description) <= 600,
          f"Description <= 600 chars ({len(description or '')})")
    # 入门模板要求工具和人设都填 ResultLabel；人设包只会把它带进目录，不参与执行。
    label = manifest.get("ResultLabel")
    check(isinstance(label, str) and 0 < len(label.strip()) <= 80,
          f"ResultLabel is 1..80 chars: {label}")
    for field in ("Version", "MinAppVersion"):
        check(isinstance(manifest.get(field), str) and bool(VERSION.fullmatch(manifest[field])),
              f"{field} is x.y.z: {manifest.get(field)}")
    maximum = manifest.get("MaxAppVersion")
    if maximum:
        check(bool(VERSION.fullmatch(maximum)), f"MaxAppVersion is x.y.z: {maximum}")
    check(manifest.get("MinAppVersion") == "4.1.0",
          "MinAppVersion is 4.1.0 (persona market ships with 4.1)")

    check(isinstance(preset, dict) and set(preset) == {"customPrompt"},
          f"persona.json has exactly one key, customPrompt -> {sorted(preset) if isinstance(preset, dict) else preset}")
    text = preset.get("customPrompt") if isinstance(preset, dict) else None
    check(isinstance(text, str) and 0 < len(text.strip()) <= MAX_PROMPT,
          f"customPrompt is 1..{MAX_PROMPT} chars ({len(text) if isinstance(text, str) else 'n/a'})")
    if isinstance(text, str):
        check(not re.search(r"^#{1,6} ", text, re.M),
              "customPrompt has no Markdown headings (client renders it as plain prompt text)")

    # manifest inside the zip must equal the source manifest, byte for byte
    source = (ROOT / "plugin.json")
    if source.exists():
        check(json.loads(source.read_text(encoding="utf-8-sig")) == manifest,
              "zipped plugin.json matches the source manifest")

    if failures:
        print(f"\n{len(failures)} check(s) failed")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if target is None:
        dist = ROOT / "dist"
        zips = sorted(dist.glob("*.zip")) if dist.exists() else []
        if not zips:
            sys.exit("no ZIP in dist/, run build.py first")
        target = zips[-1]
    sys.exit(main(target))
