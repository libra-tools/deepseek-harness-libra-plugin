# Privacy and data flow

The plugin exchanges data with Libra through the local bridge. It does not access Libra storage directly or project the whole Harness transcript. The connected capability determines which inputs are sent; the current flows are described below.

## Recall

Recall sends the downstream-accepted user query and DSH session ID to the local Libra bridge. It does not project the whole DSH transcript. Libra applies Memory access, sensitivity, selection and budget policy, then persists a selection receipt before delivery.

## Optional capture

When `captureMemoryEpisodes` is enabled, the plugin also sends the final assistant text and turn number after a successful turn. Libra stores canonical history evidence and sends compiler inputs to its configured model provider. Treat enabling capture as consent to this additional storage and provider processing. Tool traces, reasoning blocks and later steering are not captured by this integration.

## Retention and redaction

The plugin does not create an event outbox and does not promise to remove secrets from the accepted query or final answer. The old projection/outbox redaction implementation has been removed. Avoid putting secrets in captured inputs; repository and provider policy remain the deployment owner's responsibility.

Memory snapshots and receipt metadata become part of DSH's immutable history. Retiring a snapshot changes the model-visible surface, not the stored history. Capture has no durable retry queue or automatic replay on remount; a settled DSH flush means capture finished or failed observably, not necessarily that a note exists.
