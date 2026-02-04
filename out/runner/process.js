"use strict";
// src/core/process.ts
//
// Forge Process Orchestrator (Editor-side)
// ---------------------------------------
// This module is the "glue" between:
// - Forge language analysis (lexer/parser/semantic/lint)
// - Editor features (diagnostics, completion, hover, symbols)
//
// It also provides a document cache with incremental invalidation.
// If you later add formatting, code actions, rename, go-to-definition,
// you can extend this module in one place.
//
// VS Code extension layer can use either:
// - LSP server (src/server/server.ts), which has its own caching, OR
// - Direct VS Code providers (extension.ts) calling this module.
//
// Exported API:
//   - ForgeProcess (class)
//   - ForgeProcessOptions
//   - ProcessedDocument type
//
// This file is pure TS/Node and safe to run in extension host.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ForgeProcess = void 0;
const forge_language_1 = require("../language/forge.language");
const completion_1 = require("../lsp/completion");
const hover_1 = require("../lsp/hover");
const symbols_1 = require("../lsp/symbols");
const errors_1 = require("../diagnostics/errors");
class ForgeProcess {
    opts;
    cache = new Map();
    constructor(opts = {}) {
        this.opts = {
            analysis: opts.analysis ?? {},
            maxCachedDocs: opts.maxCachedDocs ?? 50,
            keepLastGoodSemantic: opts.keepLastGoodSemantic ?? true,
        };
    }
    /* =========================================================
       Core operations
       ========================================================= */
    analyze(uri, source, version) {
        const prev = this.cache.get(uri);
        if (prev && prev.doc.version === version && prev.doc.source === source) {
            return prev.doc;
        }
        const res = (0, forge_language_1.analyzeText)(source, this.opts.analysis);
        // Optional: if parse failed but we want stability for completions/hover/symbols
        let semantic = res.semantic;
        let program = res.program;
        if (this.opts.keepLastGoodSemantic && prev) {
            // If the current program is null (parse crash), keep last good program/semantic
            if (!program && prev.lastGoodProgram)
                program = prev.lastGoodProgram;
            if (!semantic && prev.lastGoodSemantic)
                semantic = prev.lastGoodSemantic;
        }
        const diags = (0, errors_1.sortDiagnostics)((0, errors_1.dedupeDiagnostics)(res.diagnostics ?? []));
        const doc = {
            uri,
            version,
            source,
            program,
            diagnostics: diags,
            semantic,
            timings: res.timings,
        };
        const entry = {
            doc,
            lastGoodSemantic: semantic && diags.every((d) => d.severity !== "error") ? semantic : prev?.lastGoodSemantic ?? semantic,
            lastGoodProgram: program && diags.every((d) => d.severity !== "error") ? program : prev?.lastGoodProgram ?? program,
        };
        this.cache.set(uri, entry);
        this.evictIfNeeded();
        return doc;
    }
    clear(uri) {
        if (!uri)
            this.cache.clear();
        else
            this.cache.delete(uri);
    }
    getCached(uri) {
        return this.cache.get(uri)?.doc ?? null;
    }
    /* =========================================================
       Features
       ========================================================= */
    completions(uri, offset) {
        const doc = this.getCached(uri);
        if (!doc)
            return [];
        const semantic = doc.semantic ??
            {
                modules: { allInOneEnabled: true, enabled: new Set(["AllInOne"]) },
                symbols: { global: {}, l: {}, v: {}, c: {} },
                types: new Map(),
                diagnostics: [],
            };
        return (0, completion_1.getCompletions)({
            source: doc.source,
            offset,
            semantic: {
                modules: semantic.modules,
                symbols: semantic.symbols,
                types: semantic.types,
            },
            maxItems: 250,
        });
    }
    hover(uri, offset) {
        const doc = this.getCached(uri);
        if (!doc)
            return null;
        const semantic = doc.semantic ??
            {
                modules: { allInOneEnabled: true, enabled: new Set(["AllInOne"]) },
                symbols: { global: {}, l: {}, v: {}, c: {} },
                types: new Map(),
                diagnostics: [],
            };
        return (0, hover_1.getHover)({
            source: doc.source,
            offset,
            semantic: {
                modules: semantic.modules,
                symbols: semantic.symbols,
                types: semantic.types,
            },
        });
    }
    symbols(uri) {
        const doc = this.getCached(uri);
        if (!doc)
            return [];
        return (0, symbols_1.getDocumentSymbols)(doc.program, doc.semantic, uri);
    }
    /* =========================================================
       Internal cache eviction
       ========================================================= */
    evictIfNeeded() {
        const max = this.opts.maxCachedDocs;
        if (this.cache.size <= max)
            return;
        // Simple eviction: drop oldest inserted.
        // Map preserves insertion order.
        const toRemove = this.cache.size - max;
        const keys = this.cache.keys();
        for (let i = 0; i < toRemove; i++) {
            const k = keys.next().value;
            if (!k)
                break;
            this.cache.delete(k);
        }
    }
}
exports.ForgeProcess = ForgeProcess;
//# sourceMappingURL=process.js.map