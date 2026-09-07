# @libra/dsh-protocol

TypeScript **receiver** for the Libra agent bridge contract (`DEP-LB-01`).

## Responsibilities

- Load `protocol/agent-bridge.v1.schema.json` from the repository root and verify its
  `protocol/agent-bridge.v1.receipt.json` authority handoff before treating it as current.
- Validate the fixture shape at runtime (methods, limits, `protocol_version`, error catalogue).
- Expose typed helpers for the bridge client and Memory bundle.

## Blocked strategy

When the fixture file is **missing** or **zero bytes**, the receiver returns `{ status: "blocked" }`
instead of inventing a parallel server schema. Downstream cards must treat that as `GAP-09` /
`DEP-LB-01` not yet materialized and must not mark real bridge integration complete.

When the fixture is present, its adjacent authority receipt is mandatory. The receiver verifies
the schema hash plus the recorded Libra source, golden-frame and revision provenance before it
becomes ready. Libra Rust (`src/internal/ai/agent_bridge/protocol.rs`) remains the protocol
authority; if the fixture and Rust constants diverge, refresh both files from the fixed Libra
revision rather than patching TypeScript semantics locally. The current receipt pins
`a92b29e8fc9ad514ebe2e6c53216845aa059d94f` (Libra `0.21.25`, Bridge `1.2`).

## Usage

```ts
import { assertSupportedProtocolMajor, loadProtocolReceiver } from "@libra/dsh-protocol";

const receiver = loadProtocolReceiver();
const contract = assertSupportedProtocolMajor(receiver, { major: 1, minor: 2 });
console.log(contract.methods); // includes memory.recall and memory.episode.record
```
