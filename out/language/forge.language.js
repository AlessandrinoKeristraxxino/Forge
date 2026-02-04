"use strict";
// src/core/forge.language.ts
//
// Forge Language Service (high-level)
// -----------------------------------
// This is the single "do everything" entrypoint for editor features.
// It coordinates:
// - Lexer
// - Parser
// - Semantic analysis
// - Lint
// - (optional) Eval/runner in the future
//
// The VS Code extension should call ONLY this layer, so we can refactor internals freely.
//
// Exports:
//   - analyzeText(source, options): ForgeLanguageResult
//   - ForgeLanguageOptions / ForgeLanguageResult types
//
// Notes:
// - We keep dependencies minimal; this is pure TS logic.
// - configuration.ts is Node/VSC host side; this module stays core-only.
//   (If you want config integration, pass it through options from extension.ts.)
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeText = analyzeText;
const errors_1 = require("../diagnostics/errors");
const lexer_1 = require("../core/lexer");
const parser_1 = require("../core/parser");
const semantic_1 = require("../core/semantic");
const lint_1 = require("../diagnostics/lint");
/* =========================================================
   Main entrypoint
   ========================================================= */
function analyzeText(source, options = {}) {
    const started = nowMs();
    // Defaults
    const features = {
        lint: options.features?.lint ?? true,
        semantic: options.features?.semantic ?? true,
    };
    // -------- LEX --------
    const t0 = nowMs();
    const lex = safeLex(source);
    const lexMs = nowMs() - t0;
    // -------- PARSE --------
    const t1 = nowMs();
    const parse = safeParse(lex.tokens);
    const parseMs = nowMs() - t1;
    // If parse failed hard, we still proceed with best-effort semantic/lint if AST exists.
    const program = parse.program ?? null;
    // -------- SEMANTIC --------
    const t2 = nowMs();
    const semantic = features.semantic && program ? safeSemantic(program, options.semantic) : null;
    const semanticMs = nowMs() - t2;
    // -------- LINT --------
    const t3 = nowMs();
    const lintDiags = features.lint && program && semantic && (options.lint?.enabled ?? true)
        ? safeLint(program, semantic, options)
        : [];
    const lintMs = nowMs() - t3;
    // -------- DIAGNOSTICS MERGE --------
    const diags = (0, errors_1.dedupeDiagnostics)((0, errors_1.mergeDiagnostics)((0, errors_1.fromLexerErrors)(lex.errors), (0, errors_1.fromParserErrors)(parse.errors), (0, errors_1.fromSemanticDiagnostics)(semantic?.diagnostics ?? []), lintDiags));
    const totalMs = nowMs() - started;
    return {
        ok: diags.every((d) => d.severity !== "error"),
        tokens: lex.tokens,
        program,
        diagnostics: diags,
        semantic,
        timings: { lexMs, parseMs, semanticMs, lintMs, totalMs },
    };
}
/* =========================================================
   Safe wrappers (never throw)
   ========================================================= */
function safeLex(source) {
    try {
        return (0, lexer_1.tokenize)(source);
    }
    catch (e) {
        // catastrophic lexer failure
        return {
            tokens: [],
            errors: [
                {
                    message: `Internal lexer error: ${String(e?.message ?? e)}`,
                    range: {
                        start: { offset: 0, line: 0, column: 0 },
                        end: { offset: Math.min(1, source.length), line: 0, column: Math.min(1, source.length) },
                    },
                },
            ],
        };
    }
}
function safeParse(tokens) {
    try {
        return (0, parser_1.parseTokens)(tokens);
    }
    catch (e) {
        // catastrophic parser failure
        const emptyProgram = {
            kind: "Program",
            range: {
                start: { offset: 0, line: 0, column: 0 },
                end: { offset: 0, line: 0, column: 0 },
            },
            body: [],
        };
        return {
            program: emptyProgram,
            errors: [
                {
                    message: `Internal parser error: ${String(e?.message ?? e)}`,
                    range: {
                        start: { offset: 0, line: 0, column: 0 },
                        end: { offset: 0, line: 0, column: 0 },
                    },
                },
            ],
        };
    }
}
function safeSemantic(program, semanticOpts) {
    try {
        return (0, semantic_1.analyzeProgram)(program, semanticOpts ?? {});
    }
    catch (e) {
        return {
            diagnostics: [
                {
                    severity: "error",
                    message: `Internal semantic error: ${String(e?.message ?? e)}`,
                    range: {
                        start: { offset: 0, line: 0, column: 0 },
                        end: { offset: 0, line: 0, column: 0 },
                    },
                    code: "SEM_INTERNAL",
                },
            ],
            symbols: { global: {}, l: {}, v: {}, c: {} },
            modules: { allInOneEnabled: true, enabled: new Set(["AllInOne"]) },
            types: new Map(),
        };
    }
}
function safeLint(program, semantic, options) {
    try {
        const ctx = {
            modules: semantic.modules,
            symbols: semantic.symbols,
            types: semantic.types,
            preferQuotedStringsForPrompts: options.lint?.preferQuotedPrompts ?? true,
        };
        // lintProgram returns semantic.Diagnostic type — convert to CoreDiagnostic shape via errors.ts
        // But in our project, lint.ts already uses errors.ts factories, so it's already CoreDiagnostic-compatible.
        return (0, lint_1.lintProgram)(program, ctx);
    }
    catch (e) {
        return [
            {
                severity: "warning",
                code: "LINT_INTERNAL",
                message: `Internal lint error: ${String(e?.message ?? e)}`,
                range: {
                    start: { offset: 0, line: 0, column: 0 },
                    end: { offset: 0, line: 0, column: 0 },
                },
                source: "semantic",
            },
        ];
    }
}
/* =========================================================
   Timing helper
   ========================================================= */
function nowMs() {
    // Works in Node and browser
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const perf = globalThis.performance;
    if (perf && typeof perf.now === "function")
        return perf.now();
    return Date.now();
}
//# sourceMappingURL=forge.language.js.map