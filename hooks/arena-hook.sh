#!/bin/sh
# Claude Arena — capture hook.
# Fire-and-forget: read the hook JSON payload on stdin, append one NDJSON line to
# the arena event log, exit 0. Must be FAST and must NEVER alter Claude's behavior.
#
# Output line format (one self-contained JSON object per line):
#   {"t":<epoch_seconds>,"ev":<raw hook payload>}
#
# We deliberately do almost nothing here. All enrichment (project detection,
# world state, faction stats) happens server-side so this stays cheap enough to
# run on every PreToolUse / PostToolUse without being felt.

DIR="${CLAUDE_ARENA_HOME:-$HOME/.claude/claude-arena}"
LOG="$DIR/events.ndjson"

# Ensure the data dir exists (idempotent, cheap).
[ -d "$DIR" ] || mkdir -p "$DIR" 2>/dev/null

# Read stdin, strip raw newlines/carriage returns so the payload is a single line.
# JSON strings can't contain literal newlines, so this is lossless for valid JSON.
PAYLOAD=$(cat | tr -d '\r\n')

# Guard against empty / non-object payloads (don't write garbage lines).
case "$PAYLOAD" in
  '{'*'}') : ;;
  *) exit 0 ;;
esac

TS=$(date +%s)

# Append atomically-ish. A single printf write of a short line is effectively
# atomic on local filesystems for our line lengths.
printf '{"t":%s,"ev":%s}\n' "$TS" "$PAYLOAD" >> "$LOG" 2>/dev/null

exit 0
