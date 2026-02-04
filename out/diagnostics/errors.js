"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.diag = diag;
exports.error = error;
exports.warn = warn;
exports.info = info;
exports.mergeDiagnostics = mergeDiagnostics;
exports.sortDiagnostics = sortDiagnostics;
exports.clampPosition = clampPosition;
exports.clampRange = clampRange;
exports.isEmptyRange = isEmptyRange;
exports.makeRange = makeRange;
exports.dedupeDiagnostics = dedupeDiagnostics;
exports.fromLexerErrors = fromLexerErrors;
exports.fromParserErrors = fromParserErrors;
exports.fromSemanticDiagnostics = fromSemanticDiagnostics;
exports.formatDiagnostic = formatDiagnostic;
exports.formatDiagnostics = formatDiagnostics;
/* =========================================================
   Factories
   ========================================================= */
function diag(severity, code, message, range, source, hint) {
    return { severity, code, message, range, source, hint };
}
function error(code, message, range, source, hint) {
    return diag("error", code, message, range, source, hint);
}
function warn(code, message, range, source, hint) {
    return diag("warning", code, message, range, source, hint);
}
function info(code, message, range, source, hint) {
    return diag("info", code, message, range, source, hint);
}
/* =========================================================
   Merging & sorting
   ========================================================= */
function mergeDiagnostics(...lists) {
    const out = [];
    for (const l of lists) {
        if (!l || !Array.isArray(l))
            continue;
        out.push(...l);
    }
    return sortDiagnostics(out);
}
function sortDiagnostics(list) {
    return [...list].sort((a, b) => {
        const ao = a.range.start.offset;
        const bo = b.range.start.offset;
        if (ao !== bo)
            return ao - bo;
        // severity ordering: error > warning > info
        const sa = severityRank(a.severity);
        const sb = severityRank(b.severity);
        if (sa !== sb)
            return sb - sa;
        // stable tie-breaker: code
        return (a.code || "").localeCompare(b.code || "");
    });
}
function severityRank(s) {
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
function clampPosition(pos, maxOffset) {
    const offset = Math.max(0, Math.min(maxOffset, pos.offset));
    return { ...pos, offset };
}
function clampRange(r, maxOffset) {
    const start = clampPosition(r.start, maxOffset);
    const end = clampPosition(r.end, maxOffset);
    if (end.offset < start.offset)
        return { start, end: start };
    return { start, end };
}
function isEmptyRange(r) {
    return r.start.offset === r.end.offset;
}
function makeRange(startOffset, startLine, startCol, endOffset, endLine, endCol) {
    return {
        start: { offset: startOffset, line: startLine, column: startCol },
        end: { offset: endOffset, line: endLine, column: endCol },
    };
}
/* =========================================================
   De-duplication
   ========================================================= */
function dedupeDiagnostics(list) {
    const seen = new Set();
    const out = [];
    for (const d of sortDiagnostics(list)) {
        const key = `${d.code}|${d.severity}|${d.range.start.offset}|${d.range.end.offset}|${d.message}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(d);
    }
    return out;
}
function fromLexerErrors(errors) {
    return errors.map((e) => error("LEX_ERROR", e.message, e.range, "lexer"));
}
function fromParserErrors(errors) {
    return errors.map((e) => error("PARSE_ERROR", e.message, e.range, "parser"));
}
function fromSemanticDiagnostics(diags) {
    return diags.map((d) => diag(d.severity, d.code ?? "SEM_DIAG", d.message, d.range, "semantic"));
}
/* =========================================================
   Pretty printing (debug)
   ========================================================= */
function formatDiagnostic(d) {
    const loc = `${d.range.start.line + 1}:${d.range.start.column + 1}`;
    const src = d.source ? `[${d.source}]` : "";
    return `${d.severity.toUpperCase()} ${src} ${d.code} @ ${loc} — ${d.message}`;
}
function formatDiagnostics(list) {
    return sortDiagnostics(list).map(formatDiagnostic).join("\n");
}
//# sourceMappingURL=errors.js.map