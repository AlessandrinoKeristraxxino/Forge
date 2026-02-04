"use strict";
// src/core/ast.ts
//
// Forge AST (Abstract Syntax Tree)
// -------------------------------
// This file defines the canonical AST types used by the Forge toolchain:
//
//   Lexer  -> tokens
//   Parser -> AST (this file)
//   Semantic Analyzer -> symbol/module checks
//   Evaluator/Runner -> execution
//   Diagnostics -> error ranges
//
// Design goals:
// - Precise source locations (line/column + offsets)
// - Strong typing (strict mode friendly)
// - Flexible enough to represent Forge-specific syntax:
//   - disable/able directives
//   - namespaces l./v./c.
//   - escaped property keys via backslash: v.\v.dog
//   - object literals with "key = value" pairs
//   - named arguments in calls: Net.get(url, headers: l.headers)
//   - duration literals: 1s, 0.5s, 200ms
//   - boolean operators: ?isBoolean / !isBoolean / isBoolean / isBoolean.t / isBoolean.f
//
// NOTE: This AST is intentionally "complete enough" for a real language.
// You can start implementing only a subset in parser/semantic/evaluator,
// while keeping the AST stable as the source of truth.
Object.defineProperty(exports, "__esModule", { value: true });
exports.NODE_KINDS = exports.UNKNOWN_RANGE = exports.UNKNOWN_POSITION = void 0;
exports.clonePosition = clonePosition;
exports.cloneRange = cloneRange;
exports.mergeRanges = mergeRanges;
exports.isElifClause = isElifClause;
exports.isCatchClause = isCatchClause;
exports.node = node;
exports.id = id;
exports.nsId = nsId;
exports.strLit = strLit;
exports.numLit = numLit;
exports.boolLit = boolLit;
exports.nullLit = nullLit;
exports.durationLit = durationLit;
exports.propKey = propKey;
exports.isNode = isNode;
exports.isStatement = isStatement;
exports.isExpression = isExpression;
exports.isLiteral = isLiteral;
exports.walkAst = walkAst;
exports.UNKNOWN_POSITION = Object.freeze({
    offset: 0,
    line: 0,
    column: 0,
});
exports.UNKNOWN_RANGE = Object.freeze({
    start: exports.UNKNOWN_POSITION,
    end: exports.UNKNOWN_POSITION,
});
function clonePosition(p) {
    return { offset: p.offset, line: p.line, column: p.column };
}
function cloneRange(r) {
    return { start: clonePosition(r.start), end: clonePosition(r.end) };
}
function mergeRanges(a, b) {
    const start = a.start.offset <= b.start.offset ? a.start : b.start;
    const end = a.end.offset >= b.end.offset ? a.end : b.end;
    return { start: clonePosition(start), end: clonePosition(end) };
}
/* =========================================================
   Node kinds
   ========================================================= */
exports.NODE_KINDS = [
    // Program / blocks
    "Program",
    "BlockStatement",
    // Directives
    "DisableDirective",
    "AbleDirective",
    // Statements
    "VarDeclaration",
    "AssignmentStatement",
    "ExpressionStatement",
    "IfStatement",
    "WhileStatement",
    "DoWhileStatement",
    "ForStatement",
    "ForEachStatement",
    "BreakStatement",
    "ContinueStatement",
    "ReturnStatement",
    "ThrowStatement",
    "TryStatement",
    "FunctionDeclaration",
    // Expressions
    "Identifier",
    "NamespacedIdentifier",
    "MemberExpression",
    "CallExpression",
    "UnaryExpression",
    "BinaryExpression",
    "AssignmentExpression",
    "ConditionalExpression",
    "BooleanOpExpression",
    "ArrowFunctionExpression",
    "FunctionExpression",
    "AwaitExpression",
    // Literals
    "StringLiteral",
    "NumberLiteral",
    "BooleanLiteral",
    "NullLiteral",
    "DurationLiteral",
    "ArrayLiteral",
    "ObjectLiteral",
    "TemplateString",
];
function isElifClause(x) {
    return typeof x === "object" && x !== null && x._clause === "ElifClause";
}
function isCatchClause(x) {
    return typeof x === "object" && x !== null && x._clause === "CatchClause";
}
/* =========================================================
   Factory helpers
   ========================================================= */
function node(kind, range, fields) {
    return { kind, range, ...fields };
}
function id(name, range = exports.UNKNOWN_RANGE) {
    return node("Identifier", range, { name });
}
function nsId(namespace, name, range = exports.UNKNOWN_RANGE) {
    return node("NamespacedIdentifier", range, { namespace, name });
}
function strLit(value, quote = "'", range = exports.UNKNOWN_RANGE) {
    return node("StringLiteral", range, { value, quote });
}
function numLit(value, raw = String(value), range = exports.UNKNOWN_RANGE) {
    return node("NumberLiteral", range, { value, raw });
}
function boolLit(value, range = exports.UNKNOWN_RANGE) {
    return node("BooleanLiteral", range, { value });
}
function nullLit(range = exports.UNKNOWN_RANGE) {
    return node("NullLiteral", range, { value: null });
}
function durationLit(value, unit, raw, range = exports.UNKNOWN_RANGE) {
    return node("DurationLiteral", range, { value, unit, raw });
}
function propKey(name, escaped = false, range = exports.UNKNOWN_RANGE) {
    return { name, escaped, range };
}
/* =========================================================
   Type guards
   ========================================================= */
function isNode(x) {
    return typeof x === "object" && x !== null && typeof x.kind === "string" && x.range?.start != null;
}
function isStatement(x) {
    return isNode(x) && exports.NODE_KINDS.includes(x.kind);
}
function isExpression(x) {
    return isNode(x) && exports.NODE_KINDS.includes(x.kind);
}
function isLiteral(x) {
    return (isNode(x) &&
        (x.kind === "StringLiteral" ||
            x.kind === "NumberLiteral" ||
            x.kind === "BooleanLiteral" ||
            x.kind === "NullLiteral" ||
            x.kind === "DurationLiteral" ||
            x.kind === "ArrayLiteral" ||
            x.kind === "ObjectLiteral" ||
            x.kind === "TemplateString"));
}
function walkAst(root, visitor) {
    const visitNode = (node, parent) => {
        visitor.enter?.(node, parent);
        const kindHandler = visitor[node.kind];
        kindHandler?.(node, parent);
        // Recurse
        switch (node.kind) {
            case "Program": {
                const n = node;
                for (const st of n.body)
                    visitNode(st, node);
                break;
            }
            case "BlockStatement": {
                const n = node;
                for (const st of n.body)
                    visitNode(st, node);
                break;
            }
            case "DisableDirective": {
                const n = node;
                visitNode(n.target, node);
                break;
            }
            case "AbleDirective": {
                const n = node;
                for (const m of n.modules)
                    visitNode(m, node);
                break;
            }
            case "VarDeclaration": {
                const n = node;
                visitNode(n.name, node);
                if (n.initializer)
                    visitNode(n.initializer, node);
                break;
            }
            case "AssignmentStatement": {
                const n = node;
                visitNode(n.target, node);
                visitNode(n.value, node);
                break;
            }
            case "ExpressionStatement": {
                const n = node;
                visitNode(n.expression, node);
                break;
            }
            case "IfStatement": {
                const n = node;
                visitNode(n.test, node);
                visitNode(n.consequent, node);
                for (const c of n.elifClauses) {
                    // ElifClause is pseudo-kind; still walk its children
                    if (isElifClause(c)) {
                        visitNode(c.test, node);
                        visitNode(c.consequent, node);
                    }
                }
                if (n.alternate)
                    visitNode(n.alternate, node);
                break;
            }
            case "WhileStatement": {
                const n = node;
                visitNode(n.test, node);
                visitNode(n.body, node);
                break;
            }
            case "DoWhileStatement": {
                const n = node;
                visitNode(n.body, node);
                visitNode(n.test, node);
                break;
            }
            case "ForStatement": {
                const n = node;
                if (n.init)
                    visitNode(n.init, node);
                if (n.test)
                    visitNode(n.test, node);
                if (n.update)
                    visitNode(n.update, node);
                visitNode(n.body, node);
                break;
            }
            case "ForEachStatement": {
                const n = node;
                visitNode(n.item, node);
                visitNode(n.iterable, node);
                visitNode(n.body, node);
                break;
            }
            case "ReturnStatement": {
                const n = node;
                if (n.argument)
                    visitNode(n.argument, node);
                break;
            }
            case "ThrowStatement": {
                const n = node;
                visitNode(n.argument, node);
                break;
            }
            case "TryStatement": {
                const n = node;
                visitNode(n.block, node);
                if (n.handler && isCatchClause(n.handler)) {
                    if (n.handler.param)
                        visitNode(n.handler.param, node);
                    visitNode(n.handler.body, node);
                }
                if (n.finalizer)
                    visitNode(n.finalizer, node);
                break;
            }
            case "FunctionDeclaration": {
                const n = node;
                visitNode(n.name, node);
                for (const p of n.params) {
                    visitNode(p.name, node);
                    if (p.defaultValue)
                        visitNode(p.defaultValue, node);
                }
                visitNode(n.body, node);
                break;
            }
            // Expressions
            case "NamespacedIdentifier": {
                const n = node;
                visitNode(n.name, node);
                break;
            }
            case "MemberExpression": {
                const n = node;
                visitNode(n.object, node);
                break;
            }
            case "CallExpression": {
                const n = node;
                visitNode(n.callee, node);
                for (const a of n.args) {
                    if (a.kind === "PositionalArgument")
                        visitNode(a.value, node);
                    else
                        visitNode(a.name, node), visitNode(a.value, node);
                }
                break;
            }
            case "UnaryExpression": {
                const n = node;
                visitNode(n.argument, node);
                break;
            }
            case "BinaryExpression": {
                const n = node;
                visitNode(n.left, node);
                visitNode(n.right, node);
                break;
            }
            case "AssignmentExpression": {
                const n = node;
                visitNode(n.left, node);
                visitNode(n.right, node);
                break;
            }
            case "ConditionalExpression": {
                const n = node;
                visitNode(n.test, node);
                visitNode(n.consequent, node);
                visitNode(n.alternate, node);
                break;
            }
            case "BooleanOpExpression": {
                const n = node;
                visitNode(n.subject, node);
                break;
            }
            case "ArrowFunctionExpression": {
                const n = node;
                for (const p of n.params) {
                    visitNode(p.name, node);
                    if (p.defaultValue)
                        visitNode(p.defaultValue, node);
                }
                if (isNode(n.body))
                    visitNode(n.body, node);
                break;
            }
            case "FunctionExpression": {
                const n = node;
                if (n.name)
                    visitNode(n.name, node);
                for (const p of n.params) {
                    visitNode(p.name, node);
                    if (p.defaultValue)
                        visitNode(p.defaultValue, node);
                }
                visitNode(n.body, node);
                break;
            }
            case "AwaitExpression": {
                const n = node;
                visitNode(n.argument, node);
                break;
            }
            // Literals: recurse into compound ones
            case "ArrayLiteral": {
                const n = node;
                for (const e of n.elements)
                    visitNode(e, node);
                break;
            }
            case "ObjectLiteral": {
                const n = node;
                for (const p of n.properties)
                    visitNode(p.value, node);
                break;
            }
            case "TemplateString": {
                const n = node;
                for (const part of n.parts) {
                    if (part.kind === "TemplateExprPart")
                        visitNode(part.expression, node);
                }
                break;
            }
            default:
                // Leaf nodes (Identifier, primitives, etc.)
                break;
        }
        visitor.leave?.(node, parent);
    };
    visitNode(root, null);
}
//# sourceMappingURL=ast.js.map