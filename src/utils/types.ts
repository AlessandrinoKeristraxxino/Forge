// src/core/types.ts
//
// Forge Type System (static types for semantic checks)
// ---------------------------------------------------
// This file defines the type representations used by semantic.ts.
// It's intentionally lightweight but extensible.
//
// Goals:
// - Provide a stable internal model for:
//   - primitive types (string/number/boolean/null/any)
//   - arrays, objects (record-like), functions
//   - union types (optional)
// - Support type inference for:
//   - literals, variables
//   - basic operations (+, -, x, /, %, comparisons)
//   - member access (obj.prop)
//   - calls (func(...))
//
// Exported API:
//   - TypeKind, ForgeType
//   - Common constants (TAny, TString, TNumber, TBoolean, TNull, TVoid, TUnknown)
//   - constructors (tArray, tObject, tFunc, tUnion, tLiteralString, ...)
//   - helpers (typeToString, isAssignable, unify, widenLiteral)
//
// NOTE:
// - This is not a full compiler-grade type system.
// - It’s "good enough" to power hover info + error highlighting.

export type TypeKind =
  | "any"
  | "unknown"
  | "void"
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "literal_string"
  | "literal_number"
  | "literal_boolean"
  | "array"
  | "object"
  | "function"
  | "union";

export type ForgeType =
  | { kind: "any" }
  | { kind: "unknown" }
  | { kind: "void" }
  | { kind: "null" }
  | { kind: "boolean" }
  | { kind: "number" }
  | { kind: "string" }
  | { kind: "literal_string"; value: string }
  | { kind: "literal_number"; value: number }
  | { kind: "literal_boolean"; value: boolean }
  | { kind: "array"; element: ForgeType }
  | { kind: "object"; props: Record<string, ForgeType>; open: boolean } // open = allow unknown keys
  | { kind: "function"; params: ForgeType[]; returns: ForgeType }
  | { kind: "union"; types: ForgeType[] };

export const TAny: ForgeType = { kind: "any" };
export const TUnknown: ForgeType = { kind: "unknown" };
export const TVoid: ForgeType = { kind: "void" };
export const TNull: ForgeType = { kind: "null" };
export const TBoolean: ForgeType = { kind: "boolean" };
export const TNumber: ForgeType = { kind: "number" };
export const TString: ForgeType = { kind: "string" };

export function tLiteralString(value: string): ForgeType {
  return { kind: "literal_string", value: String(value) };
}
export function tLiteralNumber(value: number): ForgeType {
  return { kind: "literal_number", value: Number(value) };
}
export function tLiteralBoolean(value: boolean): ForgeType {
  return { kind: "literal_boolean", value: Boolean(value) };
}

export function tArray(element: ForgeType): ForgeType {
  return { kind: "array", element };
}

export function tObject(props: Record<string, ForgeType> = {}, open = true): ForgeType {
  return { kind: "object", props: { ...props }, open };
}

export function tFunc(params: ForgeType[], returns: ForgeType): ForgeType {
  return { kind: "function", params: [...params], returns };
}

export function tUnion(types: ForgeType[]): ForgeType {
  // Flatten unions and dedupe
  const flat: ForgeType[] = [];
  for (const t of types) {
    if (t.kind === "union") flat.push(...t.types);
    else flat.push(t);
  }
  const deduped: ForgeType[] = [];
  for (const t of flat) {
    if (!deduped.some((x) => typeEquals(x, t))) deduped.push(t);
  }
  if (deduped.length === 0) return TUnknown;
  if (deduped.length === 1) return deduped[0];
  return { kind: "union", types: deduped };
}

/* =========================================================
   Display
   ========================================================= */

export function typeToString(t: ForgeType): string {
  switch (t.kind) {
    case "any":
    case "unknown":
    case "void":
    case "null":
    case "boolean":
    case "number":
    case "string":
      return t.kind;
    case "literal_string":
      return `'${escapeSingle(t.value)}'`;
    case "literal_number":
      return String(t.value);
    case "literal_boolean":
      return t.value ? "True" : "False";
    case "array":
      return `array<${typeToString(t.element)}>`;
    case "object": {
      const keys = Object.keys(t.props);
      if (keys.length === 0) return t.open ? "object{...}" : "object{}";
      const inner = keys
        .slice(0, 12)
        .map((k) => `${k}: ${typeToString(t.props[k])}`)
        .join(", ");
      const suffix = keys.length > 12 ? ", ..." : "";
      return `object{ ${inner}${suffix} }`;
    }
    case "function":
      return `func(${t.params.map(typeToString).join(", ")}): ${typeToString(t.returns)}`;
    case "union":
      return t.types.map(typeToString).join(" | ");
    default:
      return "unknown";
  }
}

function escapeSingle(s: string): string {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/* =========================================================
   Equality / helpers
   ========================================================= */

export function typeEquals(a: ForgeType, b: ForgeType): boolean {
  if (a.kind !== b.kind) return false;

  switch (a.kind) {
    case "literal_string":
      return a.value === (b as any).value;
    case "literal_number":
      return a.value === (b as any).value;
    case "literal_boolean":
      return a.value === (b as any).value;
    case "array":
      return typeEquals(a.element, (b as any).element);
    case "object": {
      const bp = (b as any).props as Record<string, ForgeType>;
      const ak = Object.keys(a.props);
      const bk = Object.keys(bp);
      if (ak.length !== bk.length) return false;
      for (const k of ak) {
        if (!bp[k]) return false;
        if (!typeEquals(a.props[k], bp[k])) return false;
      }
      return a.open === (b as any).open;
    }
    case "function":
      return (
        a.params.length === (b as any).params.length &&
        a.params.every((p, i) => typeEquals(p, (b as any).params[i])) &&
        typeEquals(a.returns, (b as any).returns)
      );
    case "union": {
      const bt = (b as any).types as ForgeType[];
      if (a.types.length !== bt.length) return false;
      return a.types.every((t) => bt.some((x) => typeEquals(x, t)));
    }
    default:
      return true;
  }
}

/* =========================================================
   Assignability
   ========================================================= */

export function isAssignable(from: ForgeType, to: ForgeType): boolean {
  // any matches everything
  if (to.kind === "any" || from.kind === "any") return true;

  // unknown can be assigned to anything? usually no.
  // We allow unknown -> any only, otherwise false.
  if (from.kind === "unknown") return to.kind === "unknown";
  if (to.kind === "unknown") return true;

  // union rules
  if (to.kind === "union") {
    return to.types.some((t) => isAssignable(from, t));
  }
  if (from.kind === "union") {
    return from.types.every((t) => isAssignable(t, to));
  }

  // literal widening
  const fromW = widenLiteral(from);
  const toW = widenLiteral(to);

  if (fromW.kind === toW.kind) {
    // objects/arrays/functions need deeper check
    if (fromW.kind === "array") return isAssignable(fromW.element, (toW as any).element);
    if (fromW.kind === "object") return isAssignableObject(fromW, toW as any);
    if (fromW.kind === "function") return isAssignableFunction(fromW, toW as any);
    return true;
  }

  // null assignability: allow null -> any/unknown/null
  if (fromW.kind === "null") return toW.kind === "null" || toW.kind === "any" || toW.kind === "unknown";

  return false;
}

function isAssignableObject(from: Extract<ForgeType, { kind: "object" }>, to: Extract<ForgeType, { kind: "object" }>): boolean {
  // Every prop required by "to" must exist in "from" (unless to.open == true)
  for (const [k, tProp] of Object.entries(to.props)) {
    const fProp = from.props[k];
    if (!fProp) {
      if (to.open) continue;
      return false;
    }
    if (!isAssignable(fProp, tProp)) return false;
  }
  return true;
}

function isAssignableFunction(
  from: Extract<ForgeType, { kind: "function" }>,
  to: Extract<ForgeType, { kind: "function" }>
): boolean {
  // Very simplified:
  // - same arity
  // - params contravariant (we'll just require assignable both ways to be safe)
  // - returns covariant
  if (from.params.length !== to.params.length) return false;

  for (let i = 0; i < from.params.length; i++) {
    const fp = from.params[i];
    const tp = to.params[i];
    if (!isAssignable(tp, fp)) return false; // contravariant
  }

  return isAssignable(from.returns, to.returns);
}

/* =========================================================
   Unification (type inference helper)
   ========================================================= */

export function unify(a: ForgeType, b: ForgeType): ForgeType {
  // If either is any, result is any
  if (a.kind === "any" || b.kind === "any") return TAny;

  // unknown with something -> union-ish result, but prefer concrete
  if (a.kind === "unknown") return b;
  if (b.kind === "unknown") return a;

  // if equal, return one
  if (typeEquals(a, b)) return a;

  // If both literals of same base, union them
  if (a.kind.startsWith("literal_") || b.kind.startsWith("literal_")) {
    return tUnion([a, b]);
  }

  // Arrays unify element types
  if (a.kind === "array" && b.kind === "array") {
    return tArray(unify(a.element, b.element));
  }

  // Objects unify common props, keep open if either open
  if (a.kind === "object" && b.kind === "object") {
    const props: Record<string, ForgeType> = {};
    const keys = new Set([...Object.keys(a.props), ...Object.keys(b.props)]);
    for (const k of keys) {
      if (a.props[k] && b.props[k]) props[k] = unify(a.props[k], b.props[k]);
      else props[k] = a.props[k] ?? b.props[k];
    }
    return tObject(props, a.open || b.open);
  }

  // otherwise union
  return tUnion([a, b]);
}

/* =========================================================
   Literal widening
   ========================================================= */

export function widenLiteral(t: ForgeType): ForgeType {
  switch (t.kind) {
    case "literal_string":
      return TString;
    case "literal_number":
      return TNumber;
    case "literal_boolean":
      return TBoolean;
    default:
      return t;
  }
}
