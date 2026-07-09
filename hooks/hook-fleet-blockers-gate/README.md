# hook-fleet-blockers-gate

A PreToolUse hook that stops an agent from working through a fleet freeze. While an unread `[FREEZE]` blocking message is active, mutating tools are denied with a clear reason; read-only tools stay allowed so the agent can read the freeze and react. Part of the Hasna fleet comms workflow (every-turn insurance).

## Installation

```bash
hooks install fleet-blockers-gate
```

## How it works

On each `PreToolUse` event:

1. **Read-only tools pass immediately** — `Read`, `Glob`, `Grep`, `WebFetch`, MCP `get_*`/`list_*`/`search_*`-style operations, etc. A frozen agent must stay able to orient itself.
2. **Freeze state is TTL-cached** (`~/.hasna/hooks/state/fleet-blockers-gate.json`, default 60s) so the common path never spawns a process per tool call.
3. On cache expiry it runs `conversations blockers -j` with a hard 500ms timeout and scans unread blocking messages for the `[FREEZE]` severity tag.
4. If frozen, mutating tools are denied via `permissionDecision: "deny"` with the freeze reason; the agent is told to read the blocker and wait for `[UNFREEZE]`.

Fail-open by design: if the `conversations` CLI is missing, the service is down, or the check times out, tools are allowed — the gate must never wedge an agent.

The freeze clears when the blocking message is no longer unread (read + resolved), after which the next cache refresh allows tools again.

## Configuration

```bash
export HOOKS_FLEET_GATE_DISABLE=1     # Kill switch — allow everything
export HOOKS_FLEET_GATE_TTL_MS=60000  # Cache TTL (default 60000)
export HOOKS_FLEET_TIMEOUT_MS=500     # Blockers check timeout (default 500)
export HOOKS_FLEET_AGENT="chief"      # Identity passed as --from
```

## Requirements

- `conversations` CLI (@hasna/conversations) — optional; the gate fails open without it

## Event

- **PreToolUse** (all tools; read-only tools short-circuit to allow)
