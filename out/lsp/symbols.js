"use strict";
// src/core/symbols.ts
//
// Forge Symbols (Document + Workspace)
// ------------------------------------
// This module provides symbol extraction that VS Code can show in:
// - Outline view
// - Breadcrumbs
// - Go to Symbol in File
// - (future) Workspace symbol search
//
// We keep it simple and robust:
// - Uses AST if available
// - Falls back to semantic symbols when AST is missing
//
// Exported API:
//   - getDocumentSymbols(program, semantic, uri?): ForgeSymbol[]
//   - getWorkspaceSymbols(index): ForgeSymbol[] (optional, for future)
//
// NOTE: VS Code "DocumentSymbol" vs "SymbolInformation":
// - This core returns a generic ForgeSymbol model. extension.ts maps to VS Code types.
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDocumentSymbols = getDocumentSymbols;
/* =========================================================
   Public API
   ========================================================= */
function getDocumentSymbols(program, semantic, uri) {
    const out = [];
    if (program) {
        out.push(...symbolsFromAst(program, uri));
    }
    else if (semantic) {
        out.push(...symbolsFromSemantic(semantic, uri));
    }
    // If semantic exists, augment with l/v/c stores as namespaces + their variables
    if (semantic) {
        out.push(...storeNamespaces(semantic, uri));
    }
    return sortSymbols(out);
}
/* =========================================================
   AST extraction
   ========================================================= */
function symbolsFromAst(program, uri) {
    const out = [];
    // File symbol (optional)
    if (program.range) {
        out.push({
            name: uri ? shortUri(uri) : "Forge File",
            kind: "file",
            range: program.range,
            selectionRange: program.range,
            children: [],
            uri,
        });
    }
    const fileNode = out.length ? out[0] : null;
    for (const st of program.body ?? []) {
        const syms = symbolsFromStatement(st, uri);
        if (fileNode) {
            fileNode.children = (fileNode.children ?? []).concat(syms);
        }
        else {
            out.push(...syms);
        }
    }
    return out;
}
function symbolsFromStatement(st, uri) {
    if (!st)
        return [];
    switch (st.kind) {
        case "VarDeclaration":
            return [symbolFromVarDecl(st, uri)];
        case "FunctionDeclaration":
            return [symbolFromFuncDecl(st, uri)];
        case "DisableDirective":
            return [symbolFromDirective(st, "disable", uri)];
        case "AbleDirective":
            return [symbolFromDirective(st, "able", uri)];
        case "BlockStatement": {
            const out = [];
            for (const s of st.body ?? [])
                out.push(...symbolsFromStatement(s, uri));
            return out;
        }
        case "IfStatement":
        case "ForStatement":
        case "ForEachStatement":
        case "WhileStatement":
        case "DoWhileStatement":
        case "TryStatement": {
            // For these, still walk their nested statements to capture functions/decls
            return symbolsFromControlFlow(st, uri);
        }
        default:
            return [];
    }
}
function symbolsFromControlFlow(node, uri) {
    const out = [];
    // Visit contained statements (best effort)
    if (node.consequent)
        out.push(...symbolsFromStatement(node.consequent, uri));
    if (node.alternate)
        out.push(...symbolsFromStatement(node.alternate, uri));
    if (node.body)
        out.push(...symbolsFromStatement(node.body, uri));
    if (Array.isArray(node.elifClauses)) {
        for (const e of node.elifClauses) {
            if (e?.consequent)
                out.push(...symbolsFromStatement(e.consequent, uri));
        }
    }
    if (node.block)
        out.push(...symbolsFromStatement(node.block, uri));
    if (node.handler?.body)
        out.push(...symbolsFromStatement(node.handler.body, uri));
    if (node.finalizer)
        out.push(...symbolsFromStatement(node.finalizer, uri));
    return out;
}
function symbolFromVarDecl(node, uri) {
    const kind = node.declKind;
    const id = node.name;
    const name = id?.name ?? "var";
    const symKind = kind === "const" ? "constant" : "variable";
    return {
        name,
        kind: symKind,
        range: node.range ?? id.range,
        selectionRange: id.range ?? node.range,
        detail: kind,
        uri,
    };
}
function symbolFromFuncDecl(node, uri) {
    const id = node.name;
    const name = id?.name ?? "func";
    return {
        name,
        kind: "function",
        range: node.range ?? id.range,
        selectionRange: id.range ?? node.range,
        detail: node.isAsync ? "async func" : "func",
        uri,
        children: [], // could add parameters later
    };
}
function symbolFromDirective(node, kind, uri) {
    // We create a synthetic name like: "able Time, Sys"
    const mods = [];
    if (kind === "able") {
        for (const m of node.modules ?? []) {
            const v = m?.value ?? m?.name ?? null;
            if (typeof v === "string")
                mods.push(v);
        }
    }
    else if (kind === "disable") {
        const v = node.target?.value ?? node.target?.name ?? null;
        if (typeof v === "string")
            mods.push(v);
    }
    const title = mods.length ? `${kind} ${mods.join(", ")}` : kind;
    return {
        name: title,
        kind: "module",
        range: node.range,
        selectionRange: node.range,
        detail: "directive",
        uri,
    };
}
/* =========================================================
   Semantic fallback extraction
   ========================================================= */
function symbolsFromSemantic(semantic, uri) {
    const out = [];
    for (const sym of Object.values(semantic.symbols.global)) {
        out.push(symbolFromSymbolInfo(sym, uri));
    }
    return sortSymbols(out);
}
function symbolFromSymbolInfo(sym, uri) {
    const symKind = sym.type.kind === "function"
        ? "function"
        : sym.mutability === "const"
            ? "constant"
            : "variable";
    return {
        name: sym.name,
        kind: symKind,
        range: sym.declaredAt,
        selectionRange: sym.declaredAt,
        detail: `${sym.store} ${sym.mutability}`,
        uri,
    };
}
/* =========================================================
   Store namespaces (l / v / c)
   ========================================================= */
function storeNamespaces(semantic, uri) {
    const out = [];
    const lVars = Object.values(semantic.symbols.l).map((s) => symbolFromSymbolInfo(s, uri));
    const vVars = Object.values(semantic.symbols.v).map((s) => symbolFromSymbolInfo(s, uri));
    const cVars = Object.values(semantic.symbols.c).map((s) => symbolFromSymbolInfo(s, uri));
    if (lVars.length) {
        out.push({
            name: "l",
            kind: "namespace",
            range: lVars[0].range,
            selectionRange: lVars[0].selectionRange,
            detail: "let store",
            uri,
            children: lVars.map((x) => ({
                ...x,
                name: `l.${x.name}`,
            })),
        });
    }
    if (vVars.length) {
        out.push({
            name: "v",
            kind: "namespace",
            range: vVars[0].range,
            selectionRange: vVars[0].selectionRange,
            detail: "var store",
            uri,
            children: vVars.map((x) => ({
                ...x,
                name: `v.${x.name}`,
            })),
        });
    }
    if (cVars.length) {
        out.push({
            name: "c",
            kind: "namespace",
            range: cVars[0].range,
            selectionRange: cVars[0].selectionRange,
            detail: "const store",
            uri,
            children: cVars.map((x) => ({
                ...x,
                name: `c.${x.name}`,
            })),
        });
    }
    return out;
}
/* =========================================================
   Sorting
   ========================================================= */
function sortSymbols(list) {
    return [...list].sort((a, b) => {
        const ao = a.range?.start?.offset ?? 0;
        const bo = b.range?.start?.offset ?? 0;
        if (ao !== bo)
            return ao - bo;
        return a.name.localeCompare(b.name);
    });
}
/* =========================================================
   URI helpers
   ========================================================= */
function shortUri(uri) {
    try {
        // VS Code uses file://... uri
        const parts = uri.split("/");
        return parts[parts.length - 1] || uri;
    }
    catch {
        return uri;
    }
}
//# sourceMappingURL=symbols.js.map