"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.lintProgram = lintProgram;
const errors_1 = require("./errors");
function lintProgram(program, ctx) {
    const linter = new Linter(ctx);
    linter.lint(program);
    return linter.diagnostics;
}
/* =========================================================
   Linter implementation
   ========================================================= */
class Linter {
    diagnostics = [];
    ctx;
    constructor(ctx) {
        this.ctx = {
            maxLineLength: ctx.maxLineLength ?? 140,
            preferQuotedStringsForPrompts: ctx.preferQuotedStringsForPrompts ?? true,
            modules: ctx.modules,
            symbols: ctx.symbols,
            types: ctx.types ?? new Map(),
        };
    }
    lint(program) {
        this.visitProgram(program);
    }
    /* =========================================================
       Visitors
       ========================================================= */
    visitProgram(node) {
        for (const st of node.body ?? [])
            this.visitStatement(st);
    }
    visitStatement(node) {
        if (!node)
            return;
        switch (node.kind) {
            case "DisableDirective":
            case "AbleDirective":
                // no lint for these for now
                return;
            case "VarDeclaration":
                this.lintVarDecl(node);
                return;
            case "AssignmentStatement":
                this.lintAssignStmt(node);
                this.visitExpression(node.value);
                return;
            case "ExpressionStatement":
                this.visitExpression(node.expression);
                return;
            case "BlockStatement":
                for (const st of node.body ?? [])
                    this.visitStatement(st);
                return;
            case "IfStatement":
                this.visitIf(node);
                return;
            case "ForStatement":
                this.visitFor(node);
                return;
            case "ForEachStatement":
                this.visitForEach(node);
                return;
            case "WhileStatement":
                this.visitWhile(node);
                return;
            case "DoWhileStatement":
                this.visitDoWhile(node);
                return;
            case "TryStatement":
                this.visitTry(node);
                return;
            case "FunctionDeclaration":
                this.visitFunctionDecl(node);
                return;
            case "ReturnStatement":
            case "ThrowStatement":
            case "BreakStatement":
            case "ContinueStatement":
                // nothing special
                if (node.argument)
                    this.visitExpression(node.argument);
                return;
            default:
                // unknown node kind: ignore
                return;
        }
    }
    visitIf(node) {
        this.visitExpression(node.test);
        this.visitStatement(node.consequent);
        for (const e of node.elifClauses ?? []) {
            this.visitExpression(e.test);
            this.visitStatement(e.consequent);
        }
        if (node.alternate)
            this.visitStatement(node.alternate);
        // Rule: empty blocks in if chain
        if (isEmptyBlock(node.consequent)) {
            this.diagnostics.push((0, errors_1.warn)("LINT_EMPTY_BLOCK", "Empty 'if' block. Consider removing it or adding logic.", node.consequent.range, "semantic"));
        }
    }
    visitFor(node) {
        if (node.init)
            this.visitStatement(node.init);
        if (node.test)
            this.visitExpression(node.test);
        if (node.update)
            this.visitExpression(node.update);
        this.visitStatement(node.body);
        if (isEmptyBlock(node.body)) {
            this.diagnostics.push((0, errors_1.warn)("LINT_EMPTY_LOOP", "Empty 'for' loop body. This is usually a bug.", node.body.range, "semantic"));
        }
    }
    visitForEach(node) {
        this.visitExpression(node.iterable);
        this.visitStatement(node.body);
        if (isEmptyBlock(node.body)) {
            this.diagnostics.push((0, errors_1.warn)("LINT_EMPTY_LOOP", "Empty 'forEach' loop body. This is usually a bug.", node.body.range, "semantic"));
        }
    }
    visitWhile(node) {
        this.visitExpression(node.test);
        this.visitStatement(node.body);
        if (isEmptyBlock(node.body)) {
            this.diagnostics.push((0, errors_1.warn)("LINT_EMPTY_LOOP", "Empty 'while' loop body. This is usually a bug.", node.body.range, "semantic"));
        }
    }
    visitDoWhile(node) {
        this.visitStatement(node.body);
        this.visitExpression(node.test);
        if (isEmptyBlock(node.body)) {
            this.diagnostics.push((0, errors_1.warn)("LINT_EMPTY_LOOP", "Empty 'do' loop body. This is usually a bug.", node.body.range, "semantic"));
        }
    }
    visitTry(node) {
        this.visitStatement(node.block);
        if (node.handler)
            this.visitStatement(node.handler.body);
        if (node.finalizer)
            this.visitStatement(node.finalizer);
        // Rule: try without catch and without finally is pointless
        const hasCatch = !!node.handler;
        const hasFinally = !!node.finalizer;
        if (!hasCatch && !hasFinally) {
            this.diagnostics.push((0, errors_1.warn)("LINT_TRY_NO_HANDLER", "A 'try' without 'catch' or 'finally' has no effect.", node.range, "semantic"));
        }
    }
    visitFunctionDecl(node) {
        const name = node.name?.name ?? "";
        if (name) {
            // Rule: function name style (camelCase)
            if (!isCamelCase(name)) {
                this.diagnostics.push((0, errors_1.info)("LINT_FUNC_NAME", `Function name '${name}' should be camelCase (e.g., myFunction).`, node.name.range, "semantic"));
            }
        }
        // Visit body
        this.visitStatement(node.body);
    }
    visitExpression(node) {
        if (!node)
            return;
        switch (node.kind) {
            case "Identifier":
                this.lintIdentifier(node);
                return;
            case "NamespacedIdentifier":
                this.lintNamespacedIdentifier(node);
                return;
            case "MemberExpression":
                this.lintMember(node);
                this.visitExpression(node.object);
                return;
            case "CallExpression":
                this.lintCall(node);
                this.visitExpression(node.callee);
                for (const a of node.args ?? []) {
                    const v = a?.kind === "NamedArgument" ? a.value : a?.value;
                    this.visitExpression(v);
                }
                return;
            case "AssignmentExpression":
                this.lintAssignExpr(node);
                this.visitExpression(node.left);
                this.visitExpression(node.right);
                return;
            case "UnaryExpression":
                this.visitExpression(node.argument);
                return;
            case "BinaryExpression":
                this.visitExpression(node.left);
                this.visitExpression(node.right);
                return;
            case "BooleanOpExpression":
                this.visitExpression(node.subject);
                return;
            case "AwaitExpression":
                this.visitExpression(node.argument);
                return;
            case "FunctionExpression":
                this.visitStatement(node.body);
                return;
            case "ArrowFunctionExpression":
                if (node.body?.kind === "BlockStatement")
                    this.visitStatement(node.body);
                else
                    this.visitExpression(node.body);
                return;
            case "ObjectLiteral":
                this.lintObject(node);
                for (const p of node.properties ?? [])
                    this.visitExpression(p.value);
                return;
            case "ArrayLiteral":
                for (const e of node.elements ?? [])
                    this.visitExpression(e);
                return;
            case "TemplateString":
                this.lintTemplate(node);
                for (const part of node.parts ?? []) {
                    if (part?.kind === "TemplateExprPart")
                        this.visitExpression(part.expression);
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
    lintVarDecl(node) {
        const kind = node.declKind;
        const name = node.name?.name ?? "";
        if (!name)
            return;
        // Rule: prefer let/const over var
        if (kind === "var") {
            this.diagnostics.push((0, errors_1.info)("LINT_PREFER_LET", `Prefer 'let'/'const' over 'var' for safer scoping.`, node.range, "semantic"));
        }
        // Rule: const without initializer is suspicious
        if (kind === "const" && !node.initializer) {
            this.diagnostics.push((0, errors_1.warn)("LINT_CONST_NO_INIT", `Const '${name}' should be initialized when declared.`, node.range, "semantic"));
        }
        // Rule: name style
        if (!isCamelCase(name) && !isUpperSnake(name)) {
            this.diagnostics.push((0, errors_1.info)("LINT_VAR_NAME", `Variable '${name}' should be camelCase (or UPPER_SNAKE for constants).`, node.name.range, "semantic"));
        }
    }
    lintAssignStmt(node) {
        // Rule: assigning into c.* store is suspicious (const store)
        const target = node.target;
        if (target?.kind === "NamespacedIdentifier" && target.namespace === "c") {
            this.diagnostics.push((0, errors_1.error)("LINT_CONST_STORE", "Assignments into 'c.' are not allowed (const store).", target.range, "semantic"));
        }
    }
    lintAssignExpr(node) {
        const left = node.left;
        if (left?.kind === "NamespacedIdentifier" && left.namespace === "c") {
            this.diagnostics.push((0, errors_1.error)("LINT_CONST_STORE", "Assignments into 'c.' are not allowed (const store).", left.range, "semantic"));
        }
    }
    lintIdentifier(node) {
        const name = node.name ?? "";
        // Rule: warn about identifiers that look like typos of common keywords
        if (looksLikeTypo(name, "checkBoolean") || looksLikeTypo(name, "chekBoolean")) {
            // In your language you use "chekBoolean" – keep as info only
            this.diagnostics.push((0, errors_1.info)("LINT_SPELLING", `Identifier '${name}' looks like a spelling variant. Keep it consistent.`, node.range, "semantic"));
        }
    }
    lintNamespacedIdentifier(node) {
        // Rule: avoid creating variables inside v./l. with PascalCase
        const nm = node.name?.name ?? "";
        if (nm && isPascalCase(nm)) {
            this.diagnostics.push((0, errors_1.info)("LINT_NS_NAME", `Prefer camelCase for ${node.namespace}. variables (e.g., myVar).`, node.name.range, "semantic"));
        }
    }
    lintMember(node) {
        // Rule: chained member access without module enabled (soft hint)
        // semantic.ts already errors; lint adds a gentle hint if it detects a module root.
        const path = getMemberPath(node);
        const root = path[0];
        if (isModuleRoot(root) && !this.ctx.modules.allInOneEnabled && !this.ctx.modules.enabled.has(root)) {
            this.diagnostics.push((0, errors_1.info)("LINT_ENABLE_MODULE", `Tip: Add "able '${root}'" at the top to use ${root}.*`, node.range, "semantic"));
        }
    }
    lintCall(node) {
        // Rule: calling inp(...) or console.text.var(...) with bare template is allowed,
        // but recommend quoted strings for prompts (since parser heuristics can be ambiguous).
        if (!this.ctx.preferQuotedStringsForPrompts)
            return;
        const calleePath = getCalleePath(node.callee);
        const isInp = calleePath[0] === "inp";
        const isConsoleVar = calleePath[0] === "console" && calleePath[1] === "text" && calleePath[2] === "var";
        if (!isInp && !isConsoleVar)
            return;
        const args = node.args ?? [];
        if (!args.length)
            return;
        // If first arg is TemplateString (bare template) -> suggest quoting
        const firstVal = args[0]?.kind === "NamedArgument" ? args[0].value : args[0]?.value;
        if (firstVal?.kind === "TemplateString") {
            this.diagnostics.push((0, errors_1.info)("LINT_QUOTE_PROMPT", `Consider using quotes for prompts/messages to avoid ambiguity (e.g., inp('What is your name? >> ')).`, firstVal.range, "semantic"));
        }
    }
    lintObject(node) {
        // Rule: object literal trailing commas not relevant; but we can warn about duplicate keys
        const seen = new Set();
        for (const p of node.properties ?? []) {
            const k = p?.key?.name ?? "";
            if (!k)
                continue;
            if (seen.has(k)) {
                this.diagnostics.push((0, errors_1.warn)("LINT_DUP_KEY", `Duplicate object key '${k}'. The last one will win.`, p.key.range, "semantic"));
            }
            seen.add(k);
        }
    }
    lintTemplate(node) {
        // Rule: templates with no expressions are just strings — recommend StringLiteral
        const parts = node.parts ?? [];
        const hasExpr = parts.some((p) => p?.kind === "TemplateExprPart");
        if (!hasExpr) {
            this.diagnostics.push((0, errors_1.info)("LINT_PLAIN_TEMPLATE", "This template has no {expressions}. A normal string literal is clearer.", node.range, "semantic"));
        }
    }
}
/* =========================================================
   Helpers
   ========================================================= */
function isEmptyBlock(node) {
    return node?.kind === "BlockStatement" && Array.isArray(node.body) && node.body.length === 0;
}
function isCamelCase(s) {
    return /^[a-z][a-zA-Z0-9]*$/.test(s);
}
function isPascalCase(s) {
    return /^[A-Z][a-zA-Z0-9]*$/.test(s);
}
function isUpperSnake(s) {
    return /^[A-Z][A-Z0-9_]*$/.test(s);
}
function looksLikeTypo(given, target) {
    if (given === target)
        return false;
    // simple heuristic: small edit distance approximated by length and shared prefix/suffix
    const minLen = Math.min(given.length, target.length);
    let pref = 0;
    while (pref < minLen && given[pref] === target[pref])
        pref++;
    let suf = 0;
    while (suf < minLen - pref &&
        given[given.length - 1 - suf] === target[target.length - 1 - suf]) {
        suf++;
    }
    const similarity = (pref + suf) / Math.max(given.length, target.length);
    return similarity >= 0.6;
}
function getMemberPath(expr) {
    const parts = [];
    let cur = expr;
    while (cur && cur.kind === "MemberExpression") {
        const p = cur.property?.name ?? "";
        if (p)
            parts.unshift(p);
        cur = cur.object;
    }
    if (cur?.kind === "Identifier")
        parts.unshift(cur.name ?? "");
    return parts.filter(Boolean);
}
function getCalleePath(expr) {
    if (!expr)
        return [];
    if (expr.kind === "Identifier")
        return [expr.name ?? ""].filter(Boolean);
    if (expr.kind === "MemberExpression")
        return getMemberPath(expr);
    return [];
}
function isModuleRoot(root) {
    return (root === "Math" ||
        root === "Time" ||
        root === "Sys" ||
        root === "Terminal" ||
        root === "File" ||
        root === "Net" ||
        root === "Crypto" ||
        root === "DateTime" ||
        root === "Regex" ||
        root === "Async" ||
        root === "JSON");
}
//# sourceMappingURL=lint.js.map