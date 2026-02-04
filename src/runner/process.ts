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

import type { Program } from "../core/ast";
import type { Diagnostic } from "../diagnostics/errors";
import type { ForgeLanguageOptions, ForgeLanguageResult } from "../language/forge.language";
import type { CompletionItem } from "../lsp/completion";
import type { HoverResult } from "../lsp/hover";
import type { ForgeSymbol } from "../lsp/symbols";

import { analyzeText } from "../language/forge.language";
import { getCompletions } from "../lsp/completion";
import { getHover } from "../lsp/hover";
import { getDocumentSymbols } from "../lsp/symbols";
import { dedupeDiagnostics, sortDiagnostics } from "../diagnostics/errors";

export type ForgeProcessOptions = {
  analysis?: ForgeLanguageOptions;

  // Cache tuning
  maxCachedDocs?: number;
  // if true, keep previous successful semantic results when current parse fails
  keepLastGoodSemantic?: boolean;
};

export type ProcessedDocument = {
  uri: string;
  version: number;

  source: string;

  program: Program | null;
  diagnostics: Diagnostic[];
  semantic: ForgeLanguageResult["semantic"] | null;

  timings: ForgeLanguageResult["timings"];
};

type CacheEntry = {
  doc: ProcessedDocument;
  lastGoodSemantic: ForgeLanguageResult["semantic"] | null;
  lastGoodProgram: Program | null;
};

export class ForgeProcess {
  private readonly opts: Required<ForgeProcessOptions>;
  private cache = new Map<string, CacheEntry>();

  constructor(opts: ForgeProcessOptions = {}) {
    this.opts = {
      analysis: opts.analysis ?? {},
      maxCachedDocs: opts.maxCachedDocs ?? 50,
      keepLastGoodSemantic: opts.keepLastGoodSemantic ?? true,
    };
  }

  /* =========================================================
     Core operations
     ========================================================= */

  public analyze(uri: string, source: string, version: number): ProcessedDocument {
    const prev = this.cache.get(uri);
    if (prev && prev.doc.version === version && prev.doc.source === source) {
      return prev.doc;
    }

    const res = analyzeText(source, this.opts.analysis);

    // Optional: if parse failed but we want stability for completions/hover/symbols
    let semantic = res.semantic;
    let program = res.program;

    if (this.opts.keepLastGoodSemantic && prev) {
      // If the current program is null (parse crash), keep last good program/semantic
      if (!program && prev.lastGoodProgram) program = prev.lastGoodProgram;
      if (!semantic && prev.lastGoodSemantic) semantic = prev.lastGoodSemantic;
    }

    const diags = sortDiagnostics(dedupeDiagnostics(res.diagnostics ?? []));

    const doc: ProcessedDocument = {
      uri,
      version,
      source,
      program,
      diagnostics: diags,
      semantic,
      timings: res.timings,
    };

    const entry: CacheEntry = {
      doc,
      lastGoodSemantic: semantic && diags.every((d) => d.severity !== "error") ? semantic : prev?.lastGoodSemantic ?? semantic,
      lastGoodProgram: program && diags.every((d) => d.severity !== "error") ? program : prev?.lastGoodProgram ?? program,
    };

    this.cache.set(uri, entry);
    this.evictIfNeeded();

    return doc;
  }

  public clear(uri?: string): void {
    if (!uri) this.cache.clear();
    else this.cache.delete(uri);
  }

  public getCached(uri: string): ProcessedDocument | null {
    return this.cache.get(uri)?.doc ?? null;
  }

  /* =========================================================
     Features
     ========================================================= */

  public completions(uri: string, offset: number): CompletionItem[] {
    const doc = this.getCached(uri);
    if (!doc) return [];

    const semantic =
      doc.semantic ??
      ({
        modules: { allInOneEnabled: true, enabled: new Set(["AllInOne"]) },
        symbols: { global: {}, l: {}, v: {}, c: {} },
        types: new Map(),
        diagnostics: [],
      } as any);

    return getCompletions({
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

  public hover(uri: string, offset: number): HoverResult | null {
    const doc = this.getCached(uri);
    if (!doc) return null;

    const semantic =
      doc.semantic ??
      ({
        modules: { allInOneEnabled: true, enabled: new Set(["AllInOne"]) },
        symbols: { global: {}, l: {}, v: {}, c: {} },
        types: new Map(),
        diagnostics: [],
      } as any);

    return getHover({
      source: doc.source,
      offset,
      semantic: {
        modules: semantic.modules,
        symbols: semantic.symbols,
        types: semantic.types,
      },
    });
  }

  public symbols(uri: string): ForgeSymbol[] {
    const doc = this.getCached(uri);
    if (!doc) return [];

    return getDocumentSymbols(doc.program, doc.semantic, uri);
  }

  /* =========================================================
     Internal cache eviction
     ========================================================= */

  private evictIfNeeded(): void {
    const max = this.opts.maxCachedDocs;
    if (this.cache.size <= max) return;

    // Simple eviction: drop oldest inserted.
    // Map preserves insertion order.
    const toRemove = this.cache.size - max;
    const keys = this.cache.keys();

    for (let i = 0; i < toRemove; i++) {
      const k = keys.next().value as string | undefined;
      if (!k) break;
      this.cache.delete(k);
    }
  }
}
