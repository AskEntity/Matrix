#!/bin/bash
# Mutation harness for the resume-launch work.
#
# Every guard here has value only on the day it fires, so each one is made to
# fire on purpose at least once. A mutation that SURVIVES is the finding.
#
# ⚠️ Refuses to report a verdict unless the file text actually changed AND bun
# printed a summary line — an instrument that fails by producing the
# comfortable answer ("survived") is worse than one that errors.

set -u
cd "$(dirname "$0")/.." || exit 1

if ! git diff --quiet || ! git diff --cached --quiet; then
	echo "REFUSING: working tree is dirty — a mutation revert would eat uncommitted work."
	exit 1
fi

pass=0
fail=0

mutate() {
	local name="$1" file="$2" from="$3" to="$4" tests="$5"
	echo
	echo "──────────────────────────────────────────────────────────────"
	echo "MUTATION: $name"
	echo "  $file"

	local before after
	before=$(md5 -q "$file")
	python3 - "$file" "$from" "$to" <<'PY'
import sys
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if frm not in s:
    sys.exit("PATTERN NOT FOUND")
open(path, "w").write(s.replace(frm, to, 1))
PY
	if [ $? -ne 0 ]; then
		echo "  ✗ INSTRUMENT BROKEN: pattern not found"
		git checkout -- "$file"
		fail=$((fail + 1))
		return
	fi
	after=$(md5 -q "$file")
	if [ "$before" = "$after" ]; then
		echo "  ✗ INSTRUMENT BROKEN: file unchanged"
		git checkout -- "$file"
		fail=$((fail + 1))
		return
	fi

	local out
	out=$(MXD_DISABLE_EMBEDDINGS=1 bun test $tests 2>&1)
	git checkout -- "$file"

	if ! echo "$out" | grep -qE "^ *[0-9]+ (pass|fail)"; then
		echo "  ✗ INSTRUMENT BROKEN: bun printed no summary (did it even run?)"
		echo "$out" | tail -5
		fail=$((fail + 1))
		return
	fi

	local failed
	failed=$(echo "$out" | grep -oE "^ *[0-9]+ fail" | grep -oE "[0-9]+" | head -1)
	failed=${failed:-0}
	if [ "$failed" -gt 0 ]; then
		echo "  ✓ CAUGHT by $failed test(s):"
		echo "$out" | grep "^(fail)" | sed 's/^/      /' | head -6
		pass=$((pass + 1))
	else
		echo "  ⚠ SURVIVED — nothing pins this."
		fail=$((fail + 1))
	fi
}

# 1. The launch decision itself: launch everything, as before.
mutate "autoResumeProjects stops asking (launch everything)" \
	src/runtime.ts \
	'if (!shouldLaunchAgent(eventStore.readActive(node.id))) {' \
	'if (false) {' \
	"src/resume-launch-decision.test.ts"

# 2. The interrupt notice is never written.
mutate "the interrupt notice is never written" \
	src/provider-shared.ts \
	'if (wasInterrupted) writeInterruptNotice(queue);' \
	'' \
	"src/resume-launch-decision.test.ts"

# 3. THE ORDERING TRAP: enqueue before the park instead of after.
mutate "ORDER: enqueue before the park (agent wakes itself)" \
	src/provider-shared.ts \
	'		const parked = queue.wait();
		if (wasInterrupted) writeInterruptNotice(queue);
		const first = await parked;' \
	'		if (wasInterrupted) writeInterruptNotice(queue);
		const parked = queue.wait();
		const first = await parked;' \
	"src/resume-launch-decision.test.ts src/interrupt-notice.test.ts"

# 4. hasPendingImplicitYield stops skipping consumptions again.
mutate "hasPendingImplicitYield ignores messages_consumed again" \
	src/events.ts \
	'			case "tool_result":
			case "messages_consumed":
			case "budget_warning":
				return { kind: "user", thinkingOnlyFrom: thinkingFrom };' \
	'			case "tool_result":
			case "budget_warning":
				return { kind: "user", thinkingOnlyFrom: thinkingFrom };
			case "messages_consumed":
				break;' \
	"src/should-launch.test.ts"

# 5. The unconsumed veto becomes "any launching source" (my original bug).
mutate "unconsumed messages stop being able to VETO" \
	src/events.ts \
	'	const unconsumed = findUnconsumedMessages(events);
	if (unconsumed.length > 0) {
		return unconsumed.some((m) => !NON_LAUNCHING_MESSAGE_SOURCES.has(m.source));
	}' \
	'	const unconsumed = findUnconsumedMessages(events);
	for (const m of unconsumed) {
		if (!NON_LAUNCHING_MESSAGE_SOURCES.has(m.source)) return true;
	}' \
	"src/should-launch.test.ts src/resume-launch-decision.test.ts"

# 6. The veto widens to "ignore interrupt notices entirely".
mutate "veto widens: interrupt notices merely filtered out" \
	src/events.ts \
	'	if (unconsumed.length > 0) {
		return unconsumed.some((m) => !NON_LAUNCHING_MESSAGE_SOURCES.has(m.source));
	}' \
	'	if (unconsumed.length > 0) {
		const real = unconsumed.filter(
			(m) => !NON_LAUNCHING_MESSAGE_SOURCES.has(m.source),
		);
		if (real.length > 0) return true;
	}' \
	"src/should-launch.test.ts src/resume-launch-decision.test.ts"

# 7. thinking stops being transparent — trailing thinking-only turn survives.
mutate "trailing thinking-only turn is no longer repaired away" \
	src/events.ts \
	'		const { thinkingOnlyFrom } = classifyTail(events);
		if (thinkingOnlyFrom > 0) {' \
	'		const { thinkingOnlyFrom } = classifyTail(events);
		if (false && thinkingOnlyFrom > 0) {' \
	"src/should-launch.test.ts"

# 8. The pendingReducer skip for interrupt (the permanent-chip bug).
mutate "pendingReducer stops skipping interrupt (chip never clears)" \
	.mxd/plugin/web/event-handler.ts \
	'			source === "compacted_resume" ||
			source === "interrupt"' \
	'			source === "compacted_resume"' \
	"src/plugin-event-handler.test.ts"

echo
echo "──────────────────────────────────────────────────────────────"
echo "caught: $pass    survived/broken: $fail"
