/**
 * Public API of the `aft/` layer.
 *
 * SAGE-FACING ONLY AT THIS POINT — see ../wrap/.
 *
 * Direct callers of this module from anywhere outside `wrap/` are considered
 * a layering violation. The sage-facing API is `sages_*` tools registered by
 * `wrap/index.ts`. This module is an implementation detail.
 *
 * What you CAN export from here (when needed for tests or one-off scripts):
 *   - resolveAftBinary (binary.ts)
 *   - snapshot, restoreFromSnapshot (safety.ts)
 *   - ensureConfigured (project.ts)
 *   - error classes (errors.ts)
 *   - types (types.ts)
 *
 * What stays internal to this module (only wrap/* imports):
 *   - AftBridge (bridge.ts) — wire protocol, AFT-specific
 */

export { resolveAftBinary, AftBinaryNotFoundError, __resetAftBinaryCache } from "./binary.js";
export { snapshot, restoreFromSnapshot } from "./safety.js";
export { ensureConfigured, __clearSessionCache } from "./project.js";
export { warmupCallgraph, __waitForWarmups, __clearWarmups, ensureReady, __resetReadyState } from "./warmup.js";
export { AftBridge, bridgeFor, __shutdownBridge } from "./bridge.js";
export {
	AftErrorBase,
	CallgraphBuildingError,
	NotConfiguredError,
	UnknownCommandError,
	InvalidRequestError,
	FileNotFoundError,
	ParseError,
	GenericAftError,
	aftErrorFromResponse,
	retryHintFor,
} from "./errors.js";
export type {
	AftResponse,
	AftError,
	AftSuccess,
	OutlineResult,
	OutlineSymbol,
	ZoomResult,
	ZoomAnnotation,
	CallgraphReference,
	CallgraphResult,
	GrepMatch,
	GrepResult,
	InspectFinding,
	InspectResult,
	ReadResult,
	WriteResult,
	EditResult,
	UndoResult,
	AftConfig,
	AftSessionState,
	AftDaemonStatus,
	AftErrorCode,
} from "./types.js";
export { AftErrorCodes } from "./types.js";
