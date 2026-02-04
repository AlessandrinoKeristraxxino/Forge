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

import type { Program } from "../core/ast";
import type { Diagnostic as CoreDiagnostic } from "../diagnostics/errors";
import { mergeDiagnostics, dedupeDiagnostics, fromLexerErrors, fromParserErrors, fromSemanticDiagnostics } from "../diagnostics/errors";

import { tokenize, type LexResult } from "../core/lexer";
import { parseTokens, type ParseResult } from "../core/parser";
import { analyzeProgram, type SemanticOptions, type SemanticResult } from "../core/semantic";
import { lintProgram, type LintContext } from "../diagnostics/lint";

/* =========================================================
   Public types
   ========================================================= */

export type ForgeLanguageOptions = {
  // Semantic options
  semantic?: SemanticOptions;

  // Lint options
  lint?: {
    enabled?: boolean;
    preferQuotedPrompts?: boolean;
  };

  // Feature switches
  features?: {
    // If false, skip lint stage
    lint?: boolean;
    // If false, skip semantic stage (still parse)
    semantic?: boolean;
  };
};

export type ForgeLanguageStageTimings = {
  lexMs: number;
  parseMs: number;
  semanticMs: number;
  lintMs: number;
  totalMs: number;
};

export type ForgeLanguageResult = {
  ok: boolean;

  // Pipeline outputs
  tokens: LexResult["tokens"];
  program: Program | null;

  // Diagnostics (merged)
  diagnostics: CoreDiagnostic[];

  // Extra: semantic data (for completions etc.)
  semantic: SemanticResult | null;

  timings: ForgeLanguageStageTimings;
};

/* =========================================================
   Main entrypoint
   ========================================================= */

export function analyzeText(source: string, options: ForgeLanguageOptions = {}): ForgeLanguageResult {
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
  const semantic: SemanticResult | null =
    features.semantic && program ? safeSemantic(program, options.semantic) : null;
  const semanticMs = nowMs() - t2;

  // -------- LINT --------
  const t3 = nowMs();
  const lintDiags: CoreDiagnostic[] =
    features.lint && program && semantic && (options.lint?.enabled ?? true)
      ? safeLint(program, semantic, options)
      : [];
  const lintMs = nowMs() - t3;

  // -------- DIAGNOSTICS MERGE --------
  const diags = dedupeDiagnostics(
    mergeDiagnostics(
      fromLexerErrors(lex.errors),
      fromParserErrors(parse.errors),
      fromSemanticDiagnostics(semantic?.diagnostics ?? []),
      lintDiags
    )
  );

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

function safeLex(source: string): LexResult {
  try {
    return tokenize(source);
  } catch (e: any) {
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

function safeParse(tokens: LexResult["tokens"]): ParseResult {
  try {
    return parseTokens(tokens);
  } catch (e: any) {
    // catastrophic parser failure
    const emptyProgram: Program = {
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

function safeSemantic(program: Program, semanticOpts?: SemanticOptions): SemanticResult {
  try {
    return analyzeProgram(program, semanticOpts ?? {});
  } catch (e: any) {
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

function safeLint(program: Program, semantic: SemanticResult, options: ForgeLanguageOptions): CoreDiagnostic[] {
  try {
    const ctx: LintContext = {
      modules: semantic.modules,
      symbols: semantic.symbols,
      types: semantic.types,
      preferQuotedStringsForPrompts: options.lint?.preferQuotedPrompts ?? true,
    };

    // lintProgram returns semantic.Diagnostic type — convert to CoreDiagnostic shape via errors.ts
    // But in our project, lint.ts already uses errors.ts factories, so it's already CoreDiagnostic-compatible.
    return lintProgram(program, ctx) as any;
  } catch (e: any) {
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
      } as any,
    ];
  }
}

/* =========================================================
   Timing helper
   ========================================================= */

function nowMs(): number {
  // Works in Node and browser
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const perf = (globalThis as any).performance;
  if (perf && typeof perf.now === "function") return perf.now();
  return Date.now();
}
