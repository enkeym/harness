# Native missing-result diagnostic (redacted)

Observed: Codex repeats `missing custom-tool output for call_<redacted>` for
the same thread/call id. Multiple log lines are one unresolved pairing, not
independent MCP failures. No tool arguments, credentials or user text are needed.

Minimal upstream report: installed CLI version; request transport; method names
and ordered call/result ids from the affected native rollout; whether a controller
was interrupted or compacted between call and result. Replace ids consistently.
An exact triggering sequence has not been established; do not claim this fixture
reproduces the native bug. Attach a sanitized trace only after verifying pairing.

Local protocol regression: test-context-runner.mjs sends turn/completed before
the turn/start response. The client buffers this event and pairs it by turn id.
Its crash test refuses replay after an uncertain turn/start. These reproduce
supported client boundary races, not an internal Codex history repair.

Mitigation: inspect the uncertain operation's effects, preserve rollout history,
stop the old owner, then use a fresh thread with a verified checkpoint. Do not
blindly replay writes or insert a fabricated tool result.
