// src/core/lint.ts
//
// Forge Lint Rules
// ----------------
// Lint sits "above" semantic analysis:
// - semantic.ts focuses on correctness / resolution / basic type checks
// - lint.ts focuses on style, best practices, suspicious patterns,
//   and "you probably meant..." hints.
//
// Output is the same Diagnostic model (src/core/errors.ts), so extension.ts can show them.
// These rules are intentionally conservative to avoid annoying false positives.
//
// Export:
//   - lintProgram(program, ctx): Diagnostic[]
//
// Where ctx includes module state + symbol index from semantic analysis.

import type {
  Program,
  Statement,
  Expression,
  Range,
  Identifier,
  NamespacedIdentifier,
  CallExpression,
  MemberExpression,
  VarDeclaration,
  AssignmentStatement,
  AssignmentExpression,
  TemplateString,
  ObjectLiteral,
  ArrayLiteral,
  IfStatement,
  ForStatement,
  ForEachStatement,
  WhileStatement,
  DoWhileStatement,
  TryStatement,
  FunctionDeclaration,
  FunctionExpression,
  ArrowFunctionExpression,
} from "../core/ast";

import type { Diagnostic, ModuleContext, SymbolIndex, ForgeType, TypeMap } from "../core/semantic";
import { warn, info, error as mkError } from "./errors";

/* =========================================================
   Lint context
   ========================================================= */

export type LintContext = {
  modules: ModuleContext;
  symbols: SymbolIndex;
  types?: TypeMap;

  // Tuning
  maxLineLength?: number; // not implemented as line scanning yet (offset-based file needed)
  preferQuotedStringsForPrompts?: boolean;
};

export function lintProgram(program: Program, ctx: LintContext): Diagnostic[] {
  const linter = new Linter(ctx);
  linter.lint(program);
  return linter.diagnostics;
}

/* =========================================================
   Linter implementation
   ========================================================= */

class Linter {
  public readonly diagnostics: Diagnostic[] = [];
  private readonly ctx: Required<LintContext>;

  constructor(ctx: LintContext) {
    this.ctx = {
      maxLineLength: ctx.maxLineLength ?? 140,
      preferQuotedStringsForPrompts: ctx.preferQuotedStringsForPrompts ?? true,
      modules: ctx.modules,
      symbols: ctx.symbols,
      types: ctx.types ?? new Map<number, ForgeType>(),
    };
  }

  public lint(program: Program): void {
    this.visitProgram(program);
  }

  /* =========================================================
     Visitors
     ========================================================= */

  private visitProgram(node: Program): void {
    for (const st of node.body ?? []) this.visitStatement(st);
  }

  private visitStatement(node: Statement): void {
    if (!node) return;

    switch ((node as any).kind) {
      case "DisableDirective":
      case "AbleDirective":
        // no lint for these for now
        return;

      case "VarDeclaration":
        this.lintVarDecl(node as any);
        return;

      case "AssignmentStatement":
        this.lintAssignStmt(node as any);
        this.visitExpression((node as any).value);
        return;

      case "ExpressionStatement":
        this.visitExpression((node as any).expression);
        return;

      case "BlockStatement":
        for (const st of (node as any).body ?? []) this.visitStatement(st);
        return;

      case "IfStatement":
        this.visitIf(node as any);
        return;

      case "ForStatement":
        this.visitFor(node as any);
        return;

      case "ForEachStatement":
        this.visitForEach(node as any);
        return;

      case "WhileStatement":
        this.visitWhile(node as any);
        return;

      case "DoWhileStatement":
        this.visitDoWhile(node as any);
        return;

      case "TryStatement":
        this.visitTry(node as any);
        return;

      case "FunctionDeclaration":
        this.visitFunctionDecl(node as any);
        return;

      case "ReturnStatement":
      case "ThrowStatement":
      case "BreakStatement":
      case "ContinueStatement":
        // nothing special
        if ((node as any).argument) this.visitExpression((node as any).argument);
        return;

      default:
        // unknown node kind: ignore
        return;
    }
  }

  private visitIf(node: IfStatement): void {
    this.visitExpression((node as any).test);
    this.visitStatement((node as any).consequent);

    for (const e of (node as any).elifClauses ?? []) {
      this.visitExpression((e as any).test);
      this.visitStatement((e as any).consequent);
    }

    if ((node as any).alternate) this.visitStatement((node as any).alternate);

    // Rule: empty blocks in if chain
    if (isEmptyBlock((node as any).consequent)) {
      this.diagnostics.push(
        warn("LINT_EMPTY_BLOCK", "Empty 'if' block. Consider removing it or adding logic.", (node as any).consequent.range, "semantic")
      );
    }
  }

  private visitFor(node: ForStatement): void {
    if ((node as any).init) this.visitStatement((node as any).init);
    if ((node as any).test) this.visitExpression((node as any).test);
    if ((node as any).update) this.visitExpression((node as any).update);
    this.visitStatement((node as any).body);

    if (isEmptyBlock((node as any).body)) {
      this.diagnostics.push(
        warn("LINT_EMPTY_LOOP", "Empty 'for' loop body. This is usually a bug.", (node as any).body.range, "semantic")
      );
    }
  }

  private visitForEach(node: ForEachStatement): void {
    this.visitExpression((node as any).iterable);
    this.visitStatement((node as any).body);

    if (isEmptyBlock((node as any).body)) {
      this.diagnostics.push(
        warn("LINT_EMPTY_LOOP", "Empty 'forEach' loop body. This is usually a bug.", (node as any).body.range, "semantic")
      );
    }
  }

  private visitWhile(node: WhileStatement): void {
    this.visitExpression((node as any).test);
    this.visitStatement((node as any).body);

    if (isEmptyBlock((node as any).body)) {
      this.diagnostics.push(
        warn("LINT_EMPTY_LOOP", "Empty 'while' loop body. This is usually a bug.", (node as any).body.range, "semantic")
      );
    }
  }

  private visitDoWhile(node: DoWhileStatement): void {
    this.visitStatement((node as any).body);
    this.visitExpression((node as any).test);

    if (isEmptyBlock((node as any).body)) {
      this.diagnostics.push(
        warn("LINT_EMPTY_LOOP", "Empty 'do' loop body. This is usually a bug.", (node as any).body.range, "semantic")
      );
    }
  }

  private visitTry(node: TryStatement): void {
    this.visitStatement((node as any).block);
    if ((node as any).handler) this.visitStatement((node as any).handler.body);
    if ((node as any).finalizer) this.visitStatement((node as any).finalizer);

    // Rule: try without catch and without finally is pointless
    const hasCatch = !!(node as any).handler;
    const hasFinally = !!(node as any).finalizer;
    if (!hasCatch && !hasFinally) {
      this.diagnostics.push(
        warn("LINT_TRY_NO_HANDLER", "A 'try' without 'catch' or 'finally' has no effect.", node.range, "semantic")
      );
    }
  }

  private visitFunctionDecl(node: FunctionDeclaration): void {
    const name = (node as any).name?.name ?? "";
    if (name) {
      // Rule: function name style (camelCase)
      if (!isCamelCase(name)) {
        this.diagnostics.push(
          info("LINT_FUNC_NAME", `Function name '${name}' should be camelCase (e.g., myFunction).`, (node as any).name.range, "semantic")
        );
      }
    }
    // Visit body
    this.visitStatement((node as any).body);
  }

  private visitExpression(node: Expression): void {
    if (!node) return;

    switch ((node as any).kind) {
      case "Identifier":
        this.lintIdentifier(node as any);
        return;

      case "NamespacedIdentifier":
        this.lintNamespacedIdentifier(node as any);
        return;

      case "MemberExpression":
        this.lintMember(node as any);
        this.visitExpression((node as any).object);
        return;

      case "CallExpression":
        this.lintCall(node as any);
        this.visitExpression((node as any).callee);
        for (const a of (node as any).args ?? []) {
          const v = a?.kind === "NamedArgument" ? a.value : a?.value;
          this.visitExpression(v);
        }
        return;

      case "AssignmentExpression":
        this.lintAssignExpr(node as any);
        this.visitExpression((node as any).left);
        this.visitExpression((node as any).right);
        return;

      case "UnaryExpression":
        this.visitExpression((node as any).argument);
        return;

      case "BinaryExpression":
        this.visitExpression((node as any).left);
        this.visitExpression((node as any).right);
        return;

      case "BooleanOpExpression":
        this.visitExpression((node as any).subject);
        return;

      case "AwaitExpression":
        this.visitExpression((node as any).argument);
        return;

      case "FunctionExpression":
        this.visitStatement((node as any).body);
        return;

      case "ArrowFunctionExpression":
        if ((node as any).body?.kind === "BlockStatement") this.visitStatement((node as any).body);
        else this.visitExpression((node as any).body);
        return;

      case "ObjectLiteral":
        this.lintObject(node as any);
        for (const p of (node as any).properties ?? []) this.visitExpression(p.value);
        return;

      case "ArrayLiteral":
        for (const e of (node as any).elements ?? []) this.visitExpression(e);
        return;

      case "TemplateString":
        this.lintTemplate(node as any);
        for (const part of (node as any).parts ?? []) {
          if (part?.kind === "TemplateExprPart") this.visitExpression(part.expression);
        }
        return;

      default:
        // literals & unknown: ignore
        return;
    }
  }

  /* =========================================================
     Lint rules
     ========================================================= */

  private lintVarDecl(node: VarDeclaration): void {
    const kind = (node as any).declKind as "let" | "var" | "const";
    const name = (node as any).name?.name ?? "";
    if (!name) return;

    // Rule: prefer let/const over var
    if (kind === "var") {
      this.diagnostics.push(
        info("LINT_PREFER_LET", `Prefer 'let'/'const' over 'var' for safer scoping.`, node.range, "semantic")
      );
    }

    // Rule: const without initializer is suspicious
    if (kind === "const" && !(node as any).initializer) {
      this.diagnostics.push(
        warn("LINT_CONST_NO_INIT", `Const '${name}' should be initialized when declared.`, node.range, "semantic")
      );
    }

    // Rule: name style
    if (!isCamelCase(name) && !isUpperSnake(name)) {
      this.diagnostics.push(
        info("LINT_VAR_NAME", `Variable '${name}' should be camelCase (or UPPER_SNAKE for constants).`, (node as any).name.range, "semantic")
      );
    }
  }

  private lintAssignStmt(node: AssignmentStatement): void {
    // Rule: assigning into c.* store is suspicious (const store)
    const target = (node as any).target;
    if (target?.kind === "NamespacedIdentifier" && target.namespace === "c") {
      this.diagnostics.push(
        mkError("LINT_CONST_STORE", "Assignments into 'c.' are not allowed (const store).", target.range, "semantic")
      );
    }
  }

  private lintAssignExpr(node: AssignmentExpression): void {
    const left = (node as any).left;
    if (left?.kind === "NamespacedIdentifier" && left.namespace === "c") {
      this.diagnostics.push(
        mkError("LINT_CONST_STORE", "Assignments into 'c.' are not allowed (const store).", left.range, "semantic")
      );
    }
  }

  private lintIdentifier(node: Identifier): void {
    const name = (node as any).name ?? "";

    // Rule: warn about identifiers that look like typos of common keywords
    if (looksLikeTypo(name, "checkBoolean") || looksLikeTypo(name, "chekBoolean")) {
      // In your language you use "chekBoolean" – keep as info only
      this.diagnostics.push(
        info("LINT_SPELLING", `Identifier '${name}' looks like a spelling variant. Keep it consistent.`, node.range, "semantic")
      );
    }
  }

  private lintNamespacedIdentifier(node: NamespacedIdentifier): void {
    // Rule: avoid creating variables inside v./l. with PascalCase
    const nm = (node as any).name?.name ?? "";
    if (nm && isPascalCase(nm)) {
      this.diagnostics.push(
        info("LINT_NS_NAME", `Prefer camelCase for ${node.namespace}. variables (e.g., myVar).`, (node as any).name.range, "semantic")
      );
    }
  }

  private lintMember(node: MemberExpression): void {
    // Rule: chained member access without module enabled (soft hint)
    // semantic.ts already errors; lint adds a gentle hint if it detects a module root.
    const path = getMemberPath(node);
    const root = path[0];

    if (isModuleRoot(root) && !this.ctx.modules.allInOneEnabled && !this.ctx.modules.enabled.has(root as any)) {
      this.diagnostics.push(
        info(
          "LINT_ENABLE_MODULE",
          `Tip: Add "able '${root}'" at the top to use ${root}.*`,
          node.range,
          "semantic"
        )
      );
    }
  }

  private lintCall(node: CallExpression): void {
    // Rule: calling inp(...) or console.text.var(...) with bare template is allowed,
    // but recommend quoted strings for prompts (since parser heuristics can be ambiguous).
    if (!this.ctx.preferQuotedStringsForPrompts) return;

    const calleePath = getCalleePath(node.callee);
    const isInp = calleePath[0] === "inp";
    const isConsoleVar =
      calleePath[0] === "console" && calleePath[1] === "text" && calleePath[2] === "var";

    if (!isInp && !isConsoleVar) return;

    const args = (node as any).args ?? [];
    if (!args.length) return;

    // If first arg is TemplateString (bare template) -> suggest quoting
    const firstVal = args[0]?.kind === "NamedArgument" ? args[0].value : args[0]?.value;
    if (firstVal?.kind === "TemplateString") {
      this.diagnostics.push(
        info(
          "LINT_QUOTE_PROMPT",
          `Consider using quotes for prompts/messages to avoid ambiguity (e.g., inp('What is your name? >> ')).`,
          firstVal.range,
          "semantic"
        )
      );
    }
  }

  private lintObject(node: ObjectLiteral): void {
    // Rule: object literal trailing commas not relevant; but we can warn about duplicate keys
    const seen = new Set<string>();
    for (const p of (node as any).properties ?? []) {
      const k = p?.key?.name ?? "";
      if (!k) continue;
      if (seen.has(k)) {
        this.diagnostics.push(
          warn("LINT_DUP_KEY", `Duplicate object key '${k}'. The last one will win.`, p.key.range, "semantic")
        );
      }
      seen.add(k);
    }
  }

  private lintTemplate(node: TemplateString): void {
    // Rule: templates with no expressions are just strings — recommend StringLiteral
    const parts = (node as any).parts ?? [];
    const hasExpr = parts.some((p: any) => p?.kind === "TemplateExprPart");
    if (!hasExpr) {
      this.diagnostics.push(
        info("LINT_PLAIN_TEMPLATE", "This template has no {expressions}. A normal string literal is clearer.", node.range, "semantic")
      );
    }
  }
}

/* =========================================================
   Helpers
   ========================================================= */

function isEmptyBlock(node: any): boolean {
  return node?.kind === "BlockStatement" && Array.isArray(node.body) && node.body.length === 0;
}

function isCamelCase(s: string): boolean {
  return /^[a-z][a-zA-Z0-9]*$/.test(s);
}

function isPascalCase(s: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(s);
}

function isUpperSnake(s: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(s);
}

function looksLikeTypo(given: string, target: string): boolean {
  if (given === target) return false;
  // simple heuristic: small edit distance approximated by length and shared prefix/suffix
  const minLen = Math.min(given.length, target.length);
  let pref = 0;
  while (pref < minLen && given[pref] === target[pref]) pref++;
  let suf = 0;
  while (
    suf < minLen - pref &&
    given[given.length - 1 - suf] === target[target.length - 1 - suf]
  ) {
    suf++;
  }
  const similarity = (pref + suf) / Math.max(given.length, target.length);
  return similarity >= 0.6;
}

function getMemberPath(expr: any): string[] {
  const parts: string[] = [];
  let cur = expr;
  while (cur && cur.kind === "MemberExpression") {
    const p = cur.property?.name ?? "";
    if (p) parts.unshift(p);
    cur = cur.object;
  }
  if (cur?.kind === "Identifier") parts.unshift(cur.name ?? "");
  return parts.filter(Boolean);
}

function getCalleePath(expr: any): string[] {
  if (!expr) return [];
  if (expr.kind === "Identifier") return [expr.name ?? ""].filter(Boolean);
  if (expr.kind === "MemberExpression") return getMemberPath(expr);
  return [];
}

function isModuleRoot(root: string): boolean {
  return (
    root === "Math" ||
    root === "Time" ||
    root === "Sys" ||
    root === "Terminal" ||
    root === "File" ||
    root === "Net" ||
    root === "Crypto" ||
    root === "DateTime" ||
    root === "Regex" ||
    root === "Async" ||
    root === "JSON"
  );
}
