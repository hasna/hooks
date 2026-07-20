# hook-fleet-blockers-gate

A PreToolUse hook that stops an agent from working through a real fleet stop. While an unread **`blocking=1` blocker** is active, mutating tools are denied with a clear reason; read-only tools stay allowed so the agent can read the blocker and react. Part of the Hasna fleet comms workflow (every-turn insurance).

To halt the fleet, the owner creates a `blocking=1` blocker (tag it `[FREEZE]` by convention); to lift it, the owner resolves/removes that blocker. Freeze **text** posted to channels is informational and never stops work.

## Installation

```bash
hooks install fleet-blockers-gate
```

## How it works

On each `PreToolUse` event:

1. **Read-only tools pass immediately** — `Read`, `Glob`, `Grep`, `WebFetch`, MCP `get_*`/`list_*`/`search_*`-style operations, etc. A frozen agent must stay able to orient itself. **Exception:** `conversations` `read_*` tools (`read_messages`, `read_channel`, `read_digest`, `read_thread`, …) are **gated** during a freeze, because they mark messages read by default and would clear the blocker's unread state — self-lifting the stop just by browsing. A frozen agent inspects the blocker with the read-only `mcp__conversations__get_blockers` (and `get_message`/`search_messages`/`list_*`/`get_thread_replies`), none of which mark messages read.
2. **Freeze state is TTL-cached** (`~/.hasna/hooks/state/fleet-blockers-gate.json`) so the common path never spawns a process per tool call. The TTL is asymmetric — a freeze is held for the full TTL (default 60s) but a "clear" is re-checked quickly (default 5s), so a freshly-issued freeze engages fast while a lift disengages slowly (the safe direction).
3. On cache miss it runs `conversations blockers -j` once (default 1500ms timeout) and denies if the result contains **any** `blocking=1` blocker. `conversations blockers` (`getUnreadBlockers`) returns every unread, in-scope blocker with no limit window, so the check is order-independent and cannot be truncated.
4. If frozen, mutating tools are denied via `permissionDecision: "deny"` with the blocker's author and text as **advisory** context; the agent is told the blocker must be resolved/removed to lift the stop.

**Freeze text is never scanned.** Denial is driven solely by the `blocking=1` flag — this kills the phantom-freeze bug where any `[FREEZE]` string from any author wedged the fleet, and it stops ignoring real blockers that lacked the `[FREEZE]` text.

**Author is not a security gate.** `conversations` does not authenticate `from_agent`, so the author is shown only as advisory context and is never used to allow or deny (gating on a spoofable field would be false assurance).

**Fail-open by design:** if the `conversations` CLI is missing, the service is down, or the check times out, tools are allowed — the gate must never wedge an agent. An unverified (comms-failure) "clear" is not cached, so the check retries on the next mutating tool.

## Operating notes & limitations

- **Identity and membership are effectively required.** The blockers query is scoped to the agent (`getUnreadBlockers`: `to_agent = me OR channel in my channels`). Set `HOOKS_FLEET_AGENT` to the agent's **real registered identity**, and ensure that identity is a **member of a broadly-subscribed freeze channel**, with the freeze posted using `--blocking`. If the identity is wrong or not subscribed, the blocker is never returned and the brake silently no-ops (fail-open). Wiring this correctly is a deployment responsibility.
- **Author-agnostic = fail-safe, not tamper-proof.** `conversations` does not authenticate `from_agent`, so the gate does not (and cannot meaningfully) trust the author. Any agent that can set `blocking=1` can therefore cause a stop; recovery is to resolve/remove the blocker or use the kill switch. This is a deliberate fail-safe tradeoff, not an authenticated control.
- **The deny reason echoes untrusted content.** Up to ~240 characters of the blocker's body are included in the deny message as advisory context. Treat that text as untrusted input (it originates from whoever posted the blocker).
- **The MCP read-only classification is a prefix heuristic.** Operations whose last `__` segment starts with `get`/`list`/`read`/`search`/… are treated as read-only. A destructively-named op (e.g. a hypothetical `get_and_reset`) could be misclassified as read-only; the `conversations` `read_*` family is explicitly gated as an exception. For high-assurance servers, prefer an explicit per-server allowlist.

## Configuration

```bash
export HOOKS_FLEET_GATE_DISABLE=1        # Kill switch — allow everything
export HOOKS_FLEET_GATE_TTL_MS=60000     # Frozen-state cache TTL (default 60000)
export HOOKS_FLEET_GATE_CLEAR_TTL_MS=5000 # Clear-state cache TTL (default 5000)
export HOOKS_FLEET_TIMEOUT_MS=1500       # Blockers check timeout (default 1500)
export HOOKS_FLEET_AGENT="chief"         # Identity passed as --from to scope the query
```

## Requirements

- `conversations` CLI (@hasna/conversations) — optional; the gate fails open without it

## Event

- **PreToolUse** (all tools; read-only tools short-circuit to allow)
