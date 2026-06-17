import type { InsertValue } from "../edgeql/ast.js";
import type { ScalarType, ScalarValue } from "../types.js";

// The DML IR — the mutation-only IR (`InsertIR` / `UpdateIR` / `DeleteIR` and
// their link sub-IRs) emitted by `src/compiler/dml_lowering.ts` and consumed by
// the engine's write path. This is the surviving, narrowed remainder of the
// interpreter-era IR: SELECT / GROUP / FOR now execute off the Live IR's SQL
// artifact and carry no IR here (see docs/adr/0001, 0020, 0021). Everything in
// this file is reachable from `IRStatement`.

/* ---------------------------------- */
/* Path identity                      */
/* ---------------------------------- */

export interface PathStepIR {
  typeName: string;
  pointer?: string;
  direction?: "outbound" | "inbound";
  optional?: boolean;
}

export interface PathIdIR {
  id: string;
  steps: PathStepIR[];
  isPointerPath: boolean;
}

/* ---------------------------------- */
/* Shared basics                      */
/* ---------------------------------- */

export interface OverlayIR {
  table: string;
  sourcePathId: string;
  operation: "union" | "replace" | "exclude";
  policyPhase: "none" | "access" | "rewrite";
  rewritePhase: "none" | "insert" | "update";
}

export type Cardinality = "one" | "many" | "at_most_one" | "at_least_one" | "empty" | "unknown";

export type Multiplicity = "unique" | "duplicate" | "empty" | "unknown";

export type Volatility = "immutable" | "stable" | "volatile" | "modifying";

export interface InferenceResult {
  cardinality: Cardinality;
  multiplicity: Multiplicity;
  volatility: Volatility;
}

/* ---------------------------------- */
/* Statement bases                    */
/* ---------------------------------- */

export interface PathStatementIR {
  kind: string;
  pathId: PathIdIR;
}

export interface TableStatementIR extends PathStatementIR {
  table: string;
}

export interface MutationBaseIR extends TableStatementIR {
  overlays: OverlayIR[];
}

/* ---------------------------------- */
/* Mutations                          */
/* ---------------------------------- */

export interface InsertLinkPropertyIR {
  name: string;
  type: ScalarType;
  hasDefault: boolean;
  defaultValue?: ScalarValue;
  defaultExprText?: string;
}

export interface InsertLinkAssignmentIR {
  linkName: string;
  storage: "inline" | "table";
  inlineColumn?: string;
  ownerTable: string;
  linkTable?: string;
  propertyColumns?: string[];
  properties?: InsertLinkPropertyIR[];
  expectedTargetTables: string[];
  target: InsertValue;
}

export interface InsertLinkDefaultIR {
  linkName: string;
  storage: "inline" | "table";
  inlineColumn?: string;
  ownerTable: string;
  linkTable?: string;
  propertyColumns?: string[];
  properties?: InsertLinkPropertyIR[];
  targetTable: string;
  defaultTargetValues: ScalarValue[];
  lookupColumn?: string;
  // When the link `default` is an INSERT expression (e.g.
  // `default := (INSERT DefaultTest5 { … })`), this carries the EdgeQL text of
  // that nested insert. The runtime executes it and links the new row, rather
  // than looking an existing target up by `lookupColumn`.
  insertExprText?: string;
}

export interface InsertIR extends MutationBaseIR {
  kind: "insert";
  values: Record<string, ScalarValue>;
  linkAssignments?: InsertLinkAssignmentIR[];
  linkDefaults?: InsertLinkDefaultIR[];
  inference?: InferenceResult;
}

export interface UpdateLinkAssignmentIR {
  linkName: string;
  storage: "inline" | "table";
  inlineColumn?: string;
  ownerTable: string;
  linkTable?: string;
  propertyColumns?: string[];
  properties?: InsertLinkPropertyIR[];
  expectedTargetTables: string[];
  operation: "assign" | "append" | "subtract";
  target: InsertValue;
}

export interface UpdateIR extends MutationBaseIR {
  kind: "update";
  filter?: {
    column: string;
    value: ScalarValue;
  };
  values: Record<string, ScalarValue>;
  linkAssignments?: UpdateLinkAssignmentIR[];
  inference?: InferenceResult;
}

export interface DeleteIR extends MutationBaseIR {
  kind: "delete";
  filter?: {
    column: string;
    value: ScalarValue;
  };
  inference?: InferenceResult;
}

export type IRStatement =
  | InsertIR
  | UpdateIR
  | DeleteIR;
