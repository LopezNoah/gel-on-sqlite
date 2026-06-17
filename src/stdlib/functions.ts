// The standard library now lives in one place: `stdlib/registry.ts`, where
// each function's metadata, SQL-lowering, and runtime-evaluation slots are
// co-located. This module is the runtime/inference-facing facade over that
// registry — it keeps the historical import path and surface stable for
// `runtime/engine.ts`, `runtime/default_resolution.ts`, and
// `compiler/inference.ts`. See `docs/adr/0043`.

export type {
  RuntimeFunctionArg,
  StdlibVolatility,
  StdlibFunctionDef,
} from "./registry.js";

export {
  resolveStdlibFunction,
  tryResolveStdlibFunction,
  executeStdlibFunction,
} from "./registry.js";
