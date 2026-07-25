#!/bin/bash
# What the running daemon costs, and how much of it auto-resume caused.
#
# Two questions, two sources, deliberately not mixed:
#
#   "how many sessions did auto-resume create?"  → the daemon's own log line,
#      which states it exactly and is the only thing that knows.
#   "what does the process tree weigh right now?" → ps, which knows the weight
#      and NOTHING about what caused any of it.
#
# ⚠️ DO NOT reintroduce a clock-based split of the process tree. This script
# used to bucket processes as "the boot batch" if they started within 30s of
# the daemon, as a proxy for "auto-resume made this". The proxy was written
# against a boot where nothing else was happening, so it looked exact — and on
# the very first boot after the fix it reported `4 proc / 0.54 GB = 1 session`
# for an agent the USER had started 14 seconds after boot. Auto-resume's cost
# was zero. **It reported the relocated cost as the eliminated cost**, which is
# the one confusion this whole measurement exists to avoid, and it reported it
# in a plausible-looking number rather than as an error.
#
# A heuristic validated only where it works reads as verified. `ps` carries no
# causal information, so the honest output says so rather than guessing.
#
# Measured baselines, both from the log rather than from the tree:
#   before (boot 964babe3, 21:39): 14 nodes eagerly launched, 0 did any work;
#     the 8 matrix-scope ones held 32 subprocesses = 8 x 4 and 1.58 GB,
#     unchanged 85 minutes later, because a parked session never ends.
#   after  (boot b1183ac3): 0 launched of 10 resumable nodes.

set -u
LOG="${MXD_DAEMON_LOG:-$HOME/.mxd/logs/daemon.log}"

ps -eo pid,ppid,rss,etime,command > /tmp/mxd-psdump.txt
ROOT=$(grep "src/daemon.ts" /tmp/mxd-psdump.txt | grep -v grep | awk '{print $1}' | head -1)
if [ -z "$ROOT" ]; then
	echo "no running daemon found (looked for 'src/daemon.ts' in the process list)"
	exit 1
fi

# ── 1. What auto-resume decided, from the authoritative source ──
if [ -f "$LOG" ]; then
	python3 - "$LOG" <<'PY'
import re
import sys

lines = open(sys.argv[1], errors="ignore").read().splitlines()
boots = [i for i, l in enumerate(lines) if "listening on http" in l]
if not boots:
    print("AUTO-RESUME: no daemon-start marker in the log — cannot say.")
    raise SystemExit

start = boots[-1]
blk = lines[start:]
ver = re.search(r"\(([0-9a-f]+)\)", blk[0])
# Pre-fix code prints one "Auto-resuming <project> node <id>" per launch and
# nothing about refusals; post-fix code prints a per-project summary. Reading
# both means this script keeps working across the change it measures.
eager = [l for l in blk if l.startswith("Auto-resuming")]
summary = [l for l in blk if "[autoResume]" in l and "launched" in l]
launched = sum(int(re.search(r"launched (\d+)/", l).group(1)) for l in summary)
resumable = sum(int(re.search(r"launched \d+/(\d+)", l).group(1)) for l in summary)

print(f"AUTO-RESUME (boot {ver.group(1) if ver else '?'}, from the daemon log):")
if not summary and not eager:
    print("  nothing logged yet — the boot may still be in progress, or the")
    print("  log is buffered. NOT the same as 'launched nothing'.")
elif summary:
    print(f"  launched {launched} session(s) of {resumable} resumable node(s)")
    if eager:
        print(f"  plus {len(eager)} logged as eagerly resumed (pre-fix code)")
    print(f"  → auto-resume MCP cost: {launched} x 4 = {launched * 4} subprocess(es)")
else:
    print(f"  {len(eager)} node(s) eagerly launched, no refusal accounting")
    print("  (pre-fix code — every resumable node was launched)")
    print(f"  → auto-resume MCP cost: up to {len(eager)} x 4 subprocess(es),")
    print("    minus any whose scope does not enable MCP")
PY
else
	echo "AUTO-RESUME: $LOG not found — cannot say what auto-resume launched."
fi

# ── 2. What the tree weighs. No causal claim. ──
python3 - "$ROOT" <<'PY'
import collections
import sys

root = int(sys.argv[1])
rows = []
with open("/tmp/mxd-psdump.txt") as f:
    f.readline()  # header
    for line in f:
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        pid, ppid, rss, etime, cmd = parts
        try:
            rows.append((int(pid), int(ppid), int(rss), etime, cmd.rstrip()))
        except ValueError:
            pass

children = collections.defaultdict(list)
for r in rows:
    children[r[1]].append(r)
byid = {r[0]: r for r in rows}

# Walk the whole descendant tree, not direct children: chrome-devtools-mcp
# spawns a node build of its own, so a one-level count misses about half.
seen, stack = [], [root]
while stack:
    p = stack.pop()
    if p in byid:
        seen.append(byid[p])
    for c in children.get(p, []):
        stack.append(c[0])

total = sum(r[2] for r in seen)
daemon = byid.get(root)
print(f"\nPROCESS TREE (daemon pid {root}, uptime {daemon[3] if daemon else '?'}):")
print(f"  {len(seen)} process(es), {total / 1024 / 1024:.2f} GB resident")

kinds = collections.Counter()
kind_rss = collections.Counter()
for r in seen:
    cmd = r[4]
    for key in ("chrome-devtools-mcp", "brave-search", "embedder-child",
                "daemon.ts", "npm exec"):
        if key in cmd:
            break
    else:
        key = "other"
    kinds[key] += 1
    kind_rss[key] += r[2]
for k, v in kinds.most_common():
    print(f"    {v:4d}  {kind_rss[k] / 1024:8.0f} MB  {k}")

# Count the MCP kinds by NAME rather than by subtracting the ones we thought
# of — "everything except the daemon and the embedder" swept in this script's
# own bash and ps processes and called them MCP.
MCP_KINDS = ("chrome-devtools-mcp", "brave-search", "npm exec")
mcp = sum(v for k, v in kinds.items() if k in MCP_KINDS)
print(f"\n  MCP subprocesses: {mcp}  (4 per agent session that has one)")
print("  ⚠️ ps cannot say WHICH session, or what caused it to exist. A session")
print("     started by a user message and one started by auto-resume are")
print("     indistinguishable here — read the AUTO-RESUME block above for that.")
PY
