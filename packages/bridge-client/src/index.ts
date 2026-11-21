export { BridgeClient, BridgeClientError } from "./client.js";
export { BridgeConfigError, BRIDGE_FIXED_ARGS, normalizeBridgeConfig } from "./config.js";
export {
  NdjsonProtocolError,
  classifyTerminalState,
  parseResponseLine,
  serializeRequest,
  utf8ByteLength,
} from "./ndjson.js";
export type {
  BridgeClientConfig,
  BridgeRequestRecord,
  BridgeRequestTerminalState,
  CompletedRequest,
  InitializeResult,
  JsonRpcErrorObject,
  JsonRpcRequest,
  JsonRpcResponse,
  PendingRequest,
} from "./types.js";

export {
  MAX_CURSOR_OFFSET,
  MAX_PAGE,
  VCS_READ_METHODS,
  VcsReadError,
  VcsReadMethods,
} from "./vcs-methods.js";
export type {
  VcsCommitFileState,
  VcsCommitSummary,
  VcsCursor,
  VcsDiffFile,
  VcsDiffParams,
  VcsDiffResult,
  VcsDiffSides,
  VcsDiffTruncation,
  VcsLogParams,
  VcsLogResult,
  VcsReadFailureKind,
  VcsReadMethod,
  VcsShowFile,
  VcsShowParams,
  VcsShowResult,
  VcsStatusEntry,
  VcsStatusParams,
  VcsStatusState,
  VcsStatusResult,
} from "./vcs-methods.js";
