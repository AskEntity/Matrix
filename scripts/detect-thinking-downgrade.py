#!/usr/bin/env python3
"""Detect fable-5 server-side reply-downgrade turns in Matrix JSONL sessions.

Signal: an assistant turn containing >=2 thinking events and ZERO assistant_text
events. The second thinking block is the server-rewritten paraphrase of the
visible reply (original withheld, encrypted in the signature field).

Empirical false-positive rate: 0 / 94,081 turns on the full pre-fable corpus
(measured 2026-06-09). See memory.md "fable-5: old SDK gets replies downgraded".

Usage:
  python3 scripts/detect-thinking-downgrade.py            # all projects
  python3 scripts/detect-thinking-downgrade.py <since>    # e.g. 2026-06-09
"""

import datetime
import glob
import json
import os
import sys

since = (
    datetime.datetime.fromisoformat(sys.argv[1]).timestamp() * 1000
    if len(sys.argv) > 1
    else 0
)

total = 0
hits_by_file: dict[str, list] = {}
for f in sorted(glob.glob(os.path.expanduser("~/.mxd/projects/*/plugin/*/tasks/*.jsonl"))):
    turns = []
    cur = None
    for line in open(f):
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = e.get("type")
        if t in ("thinking", "assistant_text", "tool_call"):
            if cur is None:
                cur = {"ts": e.get("ts", 0), "blocks": [], "previews": []}
            cur["blocks"].append(t)
            if t == "thinking":
                cur["previews"].append((e.get("thinking") or "")[:70].replace("\n", " "))
        else:
            if cur:
                turns.append(cur)
                cur = None
    if cur:
        turns.append(cur)
    for tu in turns:
        total += 1
        if tu["ts"] < since:
            continue
        if tu["blocks"].count("thinking") >= 2 and tu["blocks"].count("assistant_text") == 0:
            hits_by_file.setdefault(f, []).append(tu)

print(f"scanned {total} assistant turns across {len(glob.glob(os.path.expanduser('~/.mxd/projects/*/plugin/*/tasks/*.jsonl')))} sessions\n")
if not hits_by_file:
    print("no downgraded turns found")
for f, hits in hits_by_file.items():
    rel = f.split("projects/")[1]
    print(f"### {rel} — {len(hits)} downgraded turn(s)")
    for tu in hits[-5:]:
        d = datetime.datetime.fromtimestamp(tu["ts"] / 1000).strftime("%m-%d %H:%M:%S")
        print(f"  @ {d}  blocks={tu['blocks']}")
        if tu["previews"]:
            print(f"    suspected reply (last thinking): {tu['previews'][-1]!r}")
    print()
