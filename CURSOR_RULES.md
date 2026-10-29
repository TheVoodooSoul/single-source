# Cross-agent bus — drop this into Cursor

Adam set up a shared message bus at `/Users/egopanda/agent-bus/bus` so
Claude Code and you can talk without him copying messages
between chat tools. Two ways to wire Cursor in:

## Option A — Quick (paste in chat)
Paste once at the start of any Composer chat:

```
Cross-tool bus: shared JSONL log at /Users/egopanda/agent-bus/.
Run `bus read --agent cursor --mark` at session start to pick up messages
from siblings (Claude Code / Adam) addressed to you or broadcast (*).
Use `bus send --from cursor --to <agent>|--all --kind <kind> --subject "<short>" --body "<msg>"`
to reply. CLI is /Users/egopanda/agent-bus/bus. Full docs in
/Users/egopanda/agent-bus/README.md.
```

## Option B — Project `.cursorrules`
Drop this `.cursorrules` file at the project root (e.g.
`/Users/egopanda/aktionfilmai/.cursorrules`) so every Cursor session in
that repo picks it up automatically:

```cursorrules
# Cross-agent bus
# Shared JSONL log at /Users/egopanda/agent-bus/ — bidirectional handoff
# with Claude Code and Adam. Read on session start.

At the start of any non-trivial session, run:
  /Users/egopanda/agent-bus/bus read --agent cursor --mark

To send a message back to a sibling agent:
  /Users/egopanda/agent-bus/bus send --from cursor --to <agent>|--all \
    --kind note|question|answer|task|handoff \
    --subject "<short title>" --body "<msg>" [--re <msg-id>]

Agents: claude-code, cursor, adam
Full reference: /Users/egopanda/agent-bus/README.md
```

## Option C — Cursor global rules (Settings → Rules)
Open Cursor → Settings → Rules → User Rules, paste:

```
Cross-tool bus: /Users/egopanda/agent-bus/bus. Run
`bus read --agent cursor --mark` at session start to pull context from
Claude Code, or Adam. Use `bus send --from cursor --to <agent>|--all --kind
<kind> --subject "<short>" --body "<msg>"` to reply. Schema in
/Users/egopanda/agent-bus/README.md.
```

## Found a bug you're not fixing? File it
```
/Users/egopanda/agent-bus/bus issue --from cursor --sev low|med|high \
  --subject "<short>" --body "<file:line + repro>"
```
It lands in the hub's Open issues panel (http://127.0.0.1:7780). Whoever fixes it
runs `bus fixed --from <agent> --re <issue-id>`. `bus issues` lists what's open.

## Don't break the contract
- Subjects stay short. Bodies stay focused.
- Use `--re <msg-id>` when replying to a specific message so threads are traceable.
- Don't pollute the stream with narration; use it for handoffs/confirmations/decisions only.
