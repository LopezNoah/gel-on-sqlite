// Serialize a live-IR (`gel_ir.ts`) PathId to the Gel golden string form, e.g.
//   (__derived__::expr~3)
//   (default::Card)
//   (default::User).>deck[IS default::Card]                       (short names)
//   (default::User).>(default::__|deck@default|User)[IS …]        (debug=true)
//
// This mirrors `edb/ir/pathid.py:pformat_internal`. The live IR stores a path as
// `steps[0]` = the root type and `steps[1..]` = pointer steps (target type +
// pointer + direction), which is the same root-then-(ptr,target) sequence Gel's
// `_path` tuple encodes.

import { DERIVED_MODULE, getSpecializedName } from "./derived_names.js";
import type { PathId, PathStep, PointerRef, TypeRef } from "./gel_ir.js";

export interface PathIdFormatOptions {
  /**
   * Render pointers as their fully-qualified mangled names — the form the
   * compiler-fact goldens use, e.g. `(default::__|name@default|User)`. Default
   * false, which renders short names (`name`) like Gel's non-debug pformat.
   */
  debug?: boolean;
}

const typeName = (type: TypeRef): string => type.nameHint || type.id;

/**
 * The fully-qualified mangled name of a pointer as it appears in a debug-rendered
 * PathId. Computed/derived pointers live in the `__derived__` module; schema
 * pointers in their source type's module.
 */
const pointerDebugName = (pointer: PointerRef): string => {
  const sourceName = typeName(pointer.outSource);
  const module = pointer.isComputed || pointer.isDerived
    ? DERIVED_MODULE
    : sourceName.includes("::")
      ? sourceName.slice(0, sourceName.indexOf("::"))
      : "default";
  return `${module}::${getSpecializedName(`__::${pointer.shortName}`, sourceName)}`;
};

const renderStep = (step: PathStep, options: PathIdFormatOptions): string => {
  const pointer = step.pointer;
  if (!pointer) return "";

  const ptrText = options.debug ? `(${pointerDebugName(pointer)})` : pointer.shortName;
  const target = typeName(step.type);
  const lexpr = target ? `${ptrText}[IS ${target}]` : ptrText;

  if (pointer.isLinkProperty) return `@${lexpr}`;
  return `.${step.direction === "inbound" ? "<" : ">"}${lexpr}`;
};

export const serializePathId = (
  pathId: PathId,
  options: PathIdFormatOptions = {},
): string => {
  const steps = pathId.steps;
  if (steps.length === 0) return "";

  let result = "";
  if (pathId.namespace.length > 0) {
    result += `${[...pathId.namespace].sort().join("@")}@@`;
  }
  result += `(${typeName(steps[0].type)})`;

  for (let i = 1; i < steps.length; i += 1) {
    result += renderStep(steps[i], options);
  }

  if (pathId.isPointerPath) result += "@";
  return result;
};
