#!/bin/bash
# What the running daemon costs: every descendant process and their total RSS.
#
# Written for the before/after on "only resume what will actually do something"
# (2026-07-25). The MCP subprocesses a dormant agent holds are children of the
# daemon and live as long as its session — and a parked session never ends — so
# a snapshot of the process tree IS the measurement.
#
# Read the ACCOUNTING, not the total. A total that does not move between two
# runs has two explanations — the fix did nothing, or something other than
# agent sessions is spawning them — and only the per-etime breakdown tells them
# apart. Processes spawned within a second of each other at daemon-boot time
# are the auto-resume batch; later ones belong to agents a human started.
#
# Measured baseline, daemon booted 21:39:02 on 2026-07-25: 13 dormant nodes
# auto-resumed, 0 did any work, 8 of them (the matrix-scope ones) held
# 32 subprocesses = 8 x 4 and 1.58 GB, unchanged 85 minutes later.

set -u
ps -eo pid,ppid,rss,etime,command > /tmp/mxd-psdump.txt
ROOT=$(grep "src/daemon.ts" /tmp/mxd-psdump.txt | grep -v grep | awk '{print $1}' | head -1)
if [ -z "$ROOT" ]; then
	echo "no running daemon found (looked for 'src/daemon.ts' in the process list)"
	exit 1
fi

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

# Walk the whole descendant tree — MCP servers spawn children of their own
# (chrome-devtools-mcp runs a node build plus a telemetry watchdog), and a
# direct-children-only count misses roughly half of them.
seen, stack = [], [root]
while stack:
    p = stack.pop()
    if p in byid:
        seen.append(byid[p])
    for c in children.get(p, []):
        stack.append(c[0])

total = sum(r[2] for r in seen)
daemon = byid.get(root)
print(f"daemon pid {root}  uptime {daemon[3] if daemon else '?'}")
print(f"descendant processes (incl daemon): {len(seen)}")
print(f"total RSS: {total / 1024 / 1024:.2f} GB ({total} KB)")

def secs(etime: str) -> int:
    """ps etime -> seconds. Forms: SS, MM:SS, HH:MM:SS, D-HH:MM:SS."""
    days = 0
    if "-" in etime:
        d, etime = etime.split("-", 1)
        days = int(d)
    parts = [int(p) for p in etime.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]


# The auto-resume batch starts WITH the daemon — that is what makes it the
# boot batch rather than an agent a human started later. Bucket by "how long
# after the daemon did this start", not by raw etime: launches spread over a
# few seconds, so per-second grouping splits one batch into four.
daemon_age = secs(daemon[3]) if daemon else 0
boot, later = [], []
for r in seen:
    if r[0] == root:
        continue
    (boot if daemon_age - secs(r[3]) <= 30 else later).append(r)

boot_rss = sum(r[2] for r in boot)
print(f"\nBOOT BATCH (started within 30s of the daemon) — the auto-resume cost:")
print(f"  {len(boot)} proc  {boot_rss / 1024 / 1024:.2f} GB", end="")
if len(boot) % 4 == 0 and boot:
    print(f"   = {len(boot) // 4} session(s) x 4")
else:
    print()
print(f"started LATER (agents a human began): {len(later)} proc  "
      f"{sum(r[2] for r in later) / 1024 / 1024:.2f} GB")

print("\n--- pid ppid rss_kb etime cmd ---")
for r in sorted(seen, key=lambda x: -x[2]):
    print(f"{r[0]:7d} {r[1]:7d} {r[2]:9d} {r[3]:>14s}  {r[4][:120]}")
PY
