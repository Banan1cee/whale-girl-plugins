#!/usr/bin/env python3
"""Static test: the packaged persona text must actually teach every case in cases.json.

This cannot run the model, so it checks the next best thing -- that each
trigger/response pair and each behaviour rule is still present in the prompt
after an edit. The live check is the trial in 鲸鲸 (see README, 试装).

Run:  python test/check_cases.py
"""
import json
import sys
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
CASES = ROOT / "test" / "cases.json"


def prompt_from_zip():
    zips = sorted((ROOT / "dist").glob("*.zip"))
    if not zips:
        sys.exit("no ZIP in dist/, run build.py first")
    with ZipFile(zips[-1]) as package:
        return zips[-1].name, json.loads(package.read("persona.json"))["customPrompt"]


def main():
    name, prompt = prompt_from_zip()
    cases = json.loads(CASES.read_text(encoding="utf-8-sig"))
    print(f"{name}: {len(prompt)} chars, {len(cases)} cases\n")
    bad = 0
    for case in cases:
        missing = [a for a in case["anchors"] if a not in prompt]
        leaked = [r for r in case["reject"] if r in prompt]
        ok = not missing and not leaked
        bad += 0 if ok else 1
        print(f"  {'ok  ' if ok else 'FAIL'} {case['id']}")
        if missing:
            print(f"         missing anchors: {missing}")
        if leaked:
            print(f"         forbidden text present: {leaked}")

    for rule in ("你是傲娇，不是温柔", "不情愿的起手", "傲娇在态度里"):
        ok = rule in prompt
        bad += 0 if ok else 1
        print(f"  {'ok  ' if ok else 'FAIL'} rule: {rule}")

    print("\nall cases covered" if not bad else f"\n{bad} problem(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
