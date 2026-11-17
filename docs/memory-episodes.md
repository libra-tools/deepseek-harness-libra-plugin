# Libra Memory integration

Memory is one capability of the Libra profile plugin. Harness owns the turn lifecycle; Libra owns selection and storage. The bundle delivers recall results and can optionally capture completed turns through a compatible bridge. The new local conversation-memory implementation uses bounded lexical selection and redacted local records; it does not invoke a model or generate a structured note. The compiler-backed implementation described in the historical verification section is a different development revision.

## Recall and lifecycle

- Recall uses the downstream-accepted user query before an admitted turn. Rejected or cancelled steps do not recall.
- The plugin validates the delivery envelope and exact text hash, then attaches the same identified message to Harness history and the model request with receipt provenance.
- Surface replacement and overflow recovery refresh the delivery. Empty or null results retire the previous visible snapshot without deleting durable history.
- Cordis unload drains pending work and closes the bridge without closing live Harness sessions. Session disposal retires the corresponding bridge session before its ID can be reused.

## Optional Episode capture

Enable the optional module on the Cordis bundle entry:

```json
{
  "libraExecutable": "/absolute/path/to/libra",
  "repositoryRoot": "/absolute/path/to/repository",
  "captureMemoryEpisodes": true,
  "memoryModel": "deepseek-chat"
}
```

For the new local implementation, use a Libra build advertising Bridge `1.2`
and explicitly enable the repository-local setting `bridge.conversationMemory`
with the value `true`. Both the Libra setting and `captureMemoryEpisodes` must
be enabled for capture. With the setting disabled, recall returns an empty
delivery and recording is refused without creating a memory database.

After a successful turn, the new bridge stores the accepted query and final
assistant answer in a separate private repository-local database. Searches use
bounded literal keywords and can return records from other sessions in the same
repository; they are not semantic search. The following recall waits for capture
settlement. This implementation does not call a model provider, persist a
selection receipt, create a structured Memory note, or freeze a starting HEAD.

Capture is best-effort. Failed, aborted, blocked, and truncated turns are
skipped; tool traces, later steering, and historical replay are not captured.
The local store bounds a goal to 4,096 UTF-8 bytes and a response to 16,384
bytes. The plugin truncates longer inputs at UTF-8 character boundaries,
adds an explicit truncation marker and logs only the session, turn, field and
original byte count; a truncated record is not a complete transcript. Direct
bridge callers that exceed the limits are rejected. There is no durable capture retry queue.
A settled Harness `session/flush` does not guarantee a stored record. See
[privacy](privacy.md) for data handling, redaction and retention limits. Older
compiler-backed bridges can have different setup and provider requirements.

## Reproducible generation gate

Run in the development Docker environment, with the pinned DSH source checkout
and its dependencies already prepared:

```sh
pnpm build
DSH_CHECKOUT=/cache/dsh-alpha1 \
LIBRA_BINARY=/cache/cargo-target/debug/libra \
LIBRA_GATE_KEY_FILE=/cache/libra-secrets/deepseek-api-key \
LIBRA_GATE_RECEIPT_FILE=/cache/libra-dsh-artifacts/episode-gate.json \
node scripts/test-memory-episodes.mjs
```

The gate creates an isolated repository and uses a deterministic DSH model
answer with a real DeepSeek Episode compiler. It loads the built bundle through
the real Cordis Loader, checks the generated note and SQLite projections,
unloads/reloads the plugin, and checks exact Memory injection in a new session.
It prints and optionally saves the repository path, full structured note, and
recall receipt. The isolated repository remains available for inspection.

## Pre-refactor verified run (2026-09-07)

Environment: Debian GNU/Linux 12 (bookworm), Rust 1.97.1, Node.js 22.23.2,
pnpm 11.10.0, and DSH `v0.1.2-alpha.1` at
`cd5ef8148158c3a752a658978873241fdf8e2bbc`. All compilation and testing ran
inside Docker. Libra was the development `0.21.25` build with Bridge `1.2`.

The real `deepseek-chat` compiler produced this summary from a completed DSH
turn: “The deployment result for dshcedarepisode was recorded as the color violet.”
The complete note contained typed observations, inferences, decisions,
unresolved claims, evidence references, code anchors, and compile provenance
(`episode_compiler`, `libra-memory/1`, `task-episode-v1`).

The database held one note, one revision, one live head, and one search/FTS row.
Its compile job was `idle`, with observed and processed generation both `1`.
After the remount gate and a separate packed-profile/live-headless gate, the
receipt ledger contained four rows. The real DSH headless model returned
`violet` from the generated Memory. No prebuilt Memory was seeded into this repo.

The plugin's `pnpm check`, all 126 Memory tests, and Rust
`cargo clippy --all-targets --all-features -- -D warnings` passed. This is an
implementation receipt, not an npm release or a claim that every repository
test was run. Configuration and protocol authority remained development changes
at the time of this receipt. The [Cordis refactor receipt](release-evidence-CORDIS-20260907.md)
records the subsequent fixed authority, real type/lifecycle gates and new model run.

## Capture limits

Capture skips failed, aborted, blocked, and truncated turns. It does not collect
tool traces, regenerate queries for later steering, or replay old turns on
remount. There is no durable capture retry queue; a failed capture is reported
as a warning, and a settled flush does not prove storage succeeded. The new
local store treats a repeat of the same session and turn as idempotent only
when the redacted contents match. The client bounds its initial handshake but
not later requests; the server's own deadline still applies. Closing the bridge
or a child exit rejects pending requests.
