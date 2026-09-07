# Testing Libra Memory algorithms with DSH

Enable the optional module on the Cordis bundle entry:

```json
{
  "libraExecutable": "/absolute/path/to/libra",
  "repositoryRoot": "/absolute/path/to/repository",
  "captureMemoryEpisodes": true,
  "memoryModel": "deepseek-chat"
}
```

Use a Libra build supporting Bridge `1.2` and a repository with an initial code
commit. Supply `DEEPSEEK_API_KEY` to DSH, or configure the normal Libra repository
credentials. The plugin passes the key only to its generation-enabled bridge.

For each successful turn, the first recall captures starting HEAD. At completion,
Libra records the accepted query, final assistant answer, and terminal HEAD as
canonical history evidence, then runs the current Episode compiler and Memory
writer. The following recall waits for this operation. Algorithm changes in
Libra are therefore exercised without moving the implementation into the plugin.

The structured Memory note is stored as a repository object. `.libra/libra.db`
holds its note/revision indexes, live head, search document and FTS postings,
compile job state, and context selection receipts. Search projections are not a
replacement for the canonical Memory note.

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

## Current capture limits

Capture currently skips failed, aborted, blocked, and truncated turns. It does
not collect tool traces, regenerate queries for later steering, or replay old
turns on remount. There is no durable capture retry queue; a failed capture is
reported as a warning (subject to DSH's exporter levels), and manually resubmitting a record can create another
Episode. Only the accepted query and final assistant text are generation inputs.
Canonical history timestamps describe Libra ingestion; full DSH turn timing is
not projected yet. The bridge's current 30-second request deadline also applies
to generation, even though the client allows extra time for the request.
