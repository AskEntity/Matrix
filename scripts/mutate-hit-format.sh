#!/usr/bin/env bash
# Mutation harness for the search-hit identity work.
#
# Refuses to print a verdict unless the file text ACTUALLY changed and bun
# ACTUALLY printed a summary line — an instrument that fails by producing the
# comfortable answer ("SURVIVED") is worse than one that errors, and this repo
# has been burned by exactly that twice.
#
# Every mutation names the tests it ran, so a verdict aimed at the wrong file
# set is visible at the moment it is printed.
set -uo pipefail
cd "$(dirname "$0")/.."

TESTS="src/search-format.test.ts src/search-hit-format.test.ts"

run_mutation() {
	local name="$1" file="$2" from="$3" to="$4" tests="${5:-$TESTS}"
	local backup out summary before after
	# Byte-exact backup via cp, NOT `before=$(cat f)` + `printf '%s'` — command
	# substitution strips trailing newlines, so that restore silently deletes
	# the file's final newline. An instrument may not modify what it measures.
	backup=$(mktemp)
	cp "$file" "$backup"
	before=$(md5 -q "$file" 2>/dev/null || md5sum "$file" | cut -d" " -f1)
	python3 - "$file" "$from" "$to" <<'PY'
import sys
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if frm not in s:
    sys.exit(9)
open(path, "w").write(s.replace(frm, to, 1))
PY
	if [ $? -eq 9 ]; then
		echo "!! ANCHOR NOT FOUND — $name (mutation never applied)"
		rm -f "$backup"
		return
	fi
	after=$(md5 -q "$file" 2>/dev/null || md5sum "$file" | cut -d" " -f1)
	if [ "$before" = "$after" ]; then
		echo "!! NO TEXT CHANGE — $name (instrument broken)"
		cp "$backup" "$file"; rm -f "$backup"
		return
	fi

	out=$(bun test $tests 2>&1)
	summary=$(echo "$out" | grep -E '^ *[0-9]+ (pass|fail)' | tr '\n' ' ')
	cp "$backup" "$file"
	rm -f "$backup"

	if [ -z "$summary" ]; then
		echo "!! NO SUMMARY — $name (bun did not run; verdict withheld)"
		return
	fi
	local fails
	fails=$(echo "$out" | grep -cE '^\(fail\)')
	if [ "$fails" -gt 0 ]; then
		echo "CAUGHT ($fails) — $name"
		echo "$out" | grep -E '^\(fail\)' | sed 's/^/       /' | head -6
	else
		echo "!! SURVIVED — $name   [ran: $tests]"
	fi
}

echo "=== mutations over: $TESTS ==="

run_mutation "statusTag: drop the execution marker entirely" \
	src/search-hit-format.ts \
	'	if (!TERMINAL_STATUSES.has(status)) return `[${status}]`;
	return `[${status} · ${hasExecuted(task) ? "ran" : "never ran"}]`;' \
	'	return `[${status}]`;'

run_mutation "statusTag: marker on EVERY status (over-strict direction)" \
	src/search-hit-format.ts \
	'	if (!TERMINAL_STATUSES.has(status)) return `[${status}]`;' \
	''

run_mutation "statusTag: always claim it ran" \
	src/search-hit-format.ts \
	'hasExecuted(task) ? "ran" : "never ran"' \
	'"ran"'

run_mutation "taskAges: label updatedAt as activity" \
	src/search-hit-format.ts \
	'record touched ${dateWithAge(task.updatedAt' \
	'last active ${dateWithAge(task.updatedAt'

run_mutation "taskAges: drop createdAt, keep only the bumpable one" \
	src/search-hit-format.ts \
	'return `created ${dateWithAge(task.createdAt, now)} · record touched ${dateWithAge(task.updatedAt, now)}`;' \
	'return `record touched ${dateWithAge(task.updatedAt, now)}`;'

run_mutation "relativeAge: drop the age, absolute date only" \
	src/search-hit-format.ts \
	'	const age = relativeAge(iso, now);' \
	'	const age = "just now";'

run_mutation "probe: resultRounds only (the tempting single signal)" \
	src/search-hit-format.ts \
	'		(task.resultRounds?.length ?? 0) > 0 ||
		task.costUsd > 0 ||
		existsSync(join(tasksDir, `${task.id}.jsonl`));' \
	'		(task.resultRounds?.length ?? 0) > 0;'

run_mutation "probe: drop the JSONL member of the union" \
	src/search-hit-format.ts \
	'		task.costUsd > 0 ||
		existsSync(join(tasksDir, `${task.id}.jsonl`));' \
	'		task.costUsd > 0;'

run_mutation "dedupe: no-op (every hit renders separately)" \
	src/search-hit-format.ts \
	'		const seen = byTask.get(hit.taskId);' \
	'		const seen = undefined as DedupedHit | undefined;'

run_mutation "dedupe: drop the merged field labels" \
	src/search-hit-format.ts \
	'			if (!seen.fields.includes(label)) seen.fields.push(label);' \
	''

run_mutation "formatTieredHits: dedupe AFTER the tier split (i.e. not at all)" \
	src/orchestrator-tools.ts \
	'	const deduped = dedupeHitsByTask(hits);' \
	'	const deduped = hits.map((h) => ({ ...h, fields: [h.field] }));'

run_mutation "formatTieredHits: tier by raw index again (dead hit eats a slot)" \
	src/orchestrator-tools.ts \
	'			rendered < fullCount' \
	'			lines.length - (header ? 1 : 0) < fullCount - 1'

run_mutation "formatBriefHit: drop identity from the brief tier" \
	src/orchestrator-tools.ts \
	'		`- ${statusTag(task, hasExecuted)} "${task.title}" (${hit.taskId}) ` +
		`${taskAges(task, now)} — score: ${hit.score.toFixed(2)}`' \
	'		`- "${task.title}" (${hit.taskId}) — score: ${hit.score.toFixed(2)}`'

run_mutation "formatFullHit: put status back at the END of the line" \
	src/orchestrator-tools.ts \
	'		`- ${statusTag(task, hasExecuted)} "${task.title}" (${hit.taskId})` +' \
	'		`- "${task.title}" (${hit.taskId}, ${statusTag(task, hasExecuted)})` +'

echo
echo "=== work_context surface (integration) ==="
run_mutation "scope-opts: drop identity from the work_context line" \
	.mxd/plugin/scope-opts.ts \
	'			`- ${statusTag(task, hasExecuted)} "${task.title}" (task ${hit.taskId}) ` +
			`${taskAges(task, now)} · matched ${hit.fields.join(", ")}: "${snippet}"`' \
	'			`- "${task.title}" (task ${hit.taskId}, ${hit.fields[0]}): "${snippet}"`' \
	"src/integration.test.ts"
