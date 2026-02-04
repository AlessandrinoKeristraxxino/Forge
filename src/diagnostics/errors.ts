// src/core/errors.ts
//
// Forge diagnostics model + helpers
// ---------------------------------
// One shared format for:
// - Lexer errors
// - Parser errors
// - Semantic diagnostics
//
// This keeps extension.ts simple: it just converts these diagnostics to VS Code Diagnostics.
//
// Design goals:
// - Stable rule codes (so you can filter/suppress later)
// - Range-based (offset+line+col) so it maps cleanly to VS Code
// - Convenience factories + merging + sorting

export type Severity = "error" | "warning" | "info";

export type Position = {
  offset: number; // absolute offset in source (0..len)
  line: number; // 0-based
  column: number; // 0-based
};

export type Range = {
  start: Position;
  end: Position;
};

export type Diagnostic = {
  severity: Severity;
  code: string; // stable ID, e.g. "LEX_UNTERMINATED_STRING"
  message: string;
  range: Range;

  // Optional metadata
  source?: "lexer" | "parser" | "semantic";
  hint?: string;
};

/* =========================================================
   Factories
   ========================================================= */

export function diag(
  severity: Severity,
  code: string,
  message: string,
  range: Range,
  source?: Diagnostic["source"],
  hint?: string
): Diagnostic {
  return { severity, code, message, range, source, hint };
}

export function error(code: string, message: string, range: Range, source?: Diagnostic["source"], hint?: string): Diagnostic {
  return diag("error", code, message, range, source, hint);
}

export function warn(code: string, message: string, range: Range, source?: Diagnostic["source"], hint?: string): Diagnostic {
  return diag("warning", code, message, range, source, hint);
}

export function info(code: string, message: string, range: Range, source?: Diagnostic["source"], hint?: string): Diagnostic {
  return diag("info", code, message, range, source, hint);
}

/* =========================================================
   Merging & sorting
   ========================================================= */

export function mergeDiagnostics(...lists: Array<Diagnostic[] | undefined | null>): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const l of lists) {
    if (!l || !Array.isArray(l)) continue;
    out.push(...l);
  }
  return sortDiagnostics(out);
}

export function sortDiagnostics(list: Diagnostic[]): Diagnostic[] {
  return [...list].sort((a, b) => {
    const ao = a.range.start.offset;
    const bo = b.range.start.offset;
    if (ao !== bo) return ao - bo;

    // severity ordering: error > warning > info
    const sa = severityRank(a.severity);
    const sb = severityRank(b.severity);
    if (sa !== sb) return sb - sa;

    // stable tie-breaker: code
    return (a.code || "").localeCompare(b.code || "");
  });
}

function severityRank(s: Severity): number {
  switch (s) {
    case "error":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
    default:
      return 0;
  }
}

/* =========================================================
   Range utils
   ========================================================= */

export function clampPosition(pos: Position, maxOffset: number): Position {
  const offset = Math.max(0, Math.min(maxOffset, pos.offset));
  return { ...pos, offset };
}

export function clampRange(r: Range, maxOffset: number): Range {
  const start = clampPosition(r.start, maxOffset);
  const end = clampPosition(r.end, maxOffset);
  if (end.offset < start.offset) return { start, end: start };
  return { start, end };
}

export function isEmptyRange(r: Range): boolean {
  return r.start.offset === r.end.offset;
}

export function makeRange(
  startOffset: number,
  startLine: number,
  startCol: number,
  endOffset: number,
  endLine: number,
  endCol: number
): Range {
  return {
    start: { offset: startOffset, line: startLine, column: startCol },
    end: { offset: endOffset, line: endLine, column: endCol },
  };
}

/* =========================================================
   De-duplication
   ========================================================= */

export function dedupeDiagnostics(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];

  for (const d of sortDiagnostics(list)) {
    const key = `${d.code}|${d.severity}|${d.range.start.offset}|${d.range.end.offset}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }

  return out;
}

/* =========================================================
   Converters / interoperability
   ========================================================= */

// Often your lexer/parser return {message, range}.
// These helpers normalize them into this file's Diagnostic.

export type BasicError = { message: string; range: Range };

export function fromLexerErrors(errors: BasicError[]): Diagnostic[] {
  return errors.map((e) =>
    error("LEX_ERROR", e.message, e.range, "lexer")
  );
}

export function fromParserErrors(errors: BasicError[]): Diagnostic[] {
  return errors.map((e) =>
    error("PARSE_ERROR", e.message, e.range, "parser")
  );
}

export type SemanticDiagLike = { severity: "error" | "warning" | "info"; message: string; range: Range; code?: string };

export function fromSemanticDiagnostics(diags: SemanticDiagLike[]): Diagnostic[] {
  return diags.map((d) =>
    diag(d.severity, d.code ?? "SEM_DIAG", d.message, d.range, "semantic")
  );
}

/* =========================================================
   Pretty printing (debug)
   ========================================================= */

export function formatDiagnostic(d: Diagnostic): string {
  const loc = `${d.range.start.line + 1}:${d.range.start.column + 1}`;
  const src = d.source ? `[${d.source}]` : "";
  return `${d.severity.toUpperCase()} ${src} ${d.code} @ ${loc} — ${d.message}`;
}

export function formatDiagnostics(list: Diagnostic[]): string {
  return sortDiagnostics(list).map(formatDiagnostic).join("\n");
}
