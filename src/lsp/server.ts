// src/server/server.ts
//
// Forge Language Server (LSP)
// --------------------------
// This file runs in a Node.js process (the extension host spawns it).
// It provides:
// - Diagnostics (lexer + parser + semantic + lint)
// - Completions (keywords, modules, symbols, member completions)
// - Hover (symbol info + builtin docs)
//
// It uses the Forge core pipeline in:
// - src/core/forge.language.ts
// - src/core/completion.ts
// - src/core/hover.ts
//
// Expected companion files (typically):
// - src/client/client.ts (VS Code LanguageClient wiring)
// - extension.ts registers the client
//
// If you are not using LSP and instead use vscode APIs directly in extension.ts,
// you can still keep this server for later scalability.

import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  DiagnosticSeverity,
  CompletionItemKind,
  InitializeParams,
  InitializeResult,
  Hover,
  CompletionItem,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";

import { analyzeText, type ForgeLanguageOptions, type ForgeLanguageResult } from "../language/forge.language";
import { getCompletions, type CompletionItem as CoreCompletionItem } from "./completion";
import { getHover } from "./hover";

import type { Diagnostic as CoreDiagnostic } from "../diagnostics/errors";
import { loadForgeConfig, type ResolvedForgeConfig } from "../language/configuration";

/* =========================================================
   Connection & Documents
   ========================================================= */

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

/* =========================================================
   Settings
   ========================================================= */

type ServerSettings = {
  maxNumberOfProblems: number;

  diagnostics: {
    enabled: boolean;
    softModuleGating: boolean;
    relaxedMemberAccess: boolean;
  };

  lint: {
    enabled: boolean;
    preferQuotedPrompts: boolean;
  };

  // If true, try to load forge.config.json from project root (filesystem).
  useProjectConfig: boolean;
};

const DEFAULT_SETTINGS: ServerSettings = {
  maxNumberOfProblems: 200,
  diagnostics: {
    enabled: true,
    softModuleGating: false,
    relaxedMemberAccess: true,
  },
  lint: {
    enabled: true,
    preferQuotedPrompts: true,
  },
  useProjectConfig: true,
};

let globalSettings: ServerSettings = { ...DEFAULT_SETTINGS };
let hasConfigurationCapability = false;

/* =========================================================
   Cache per document
   ========================================================= */

type DocCache = {
  version: number;
  result: ForgeLanguageResult;
  // resolved config, optional
  config?: ResolvedForgeConfig | null;
};

const cache = new Map<string, DocCache>();

/* =========================================================
   Initialize
   ========================================================= */

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const capabilities = params.capabilities;

  hasConfigurationCapability = !!capabilities.workspace?.configuration;

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: [".", "'", "{", " "],
      },
      hoverProvider: true,
    },
  };

  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // The client normally handles this capability automatically.
    // Keeping initialization side effects minimal avoids API-version drift.
  }
});

/* =========================================================
   Configuration changes
   ========================================================= */

connection.onDidChangeConfiguration(async (change) => {
  if (hasConfigurationCapability) {
    globalSettings = (change.settings?.forge as ServerSettings) ?? DEFAULT_SETTINGS;
  } else {
    globalSettings = DEFAULT_SETTINGS;
  }

  // Clear cache because settings may change diagnostics behavior
  cache.clear();

  // Revalidate all open documents
  const all = documents.all();
  for (const doc of all) {
    await validateTextDocument(doc);
  }
});

/* =========================================================
   Document lifecycle
   ========================================================= */

documents.onDidClose((e) => {
  cache.delete(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

documents.onDidChangeContent(async (change) => {
  await validateTextDocument(change.document);
});

documents.onDidOpen(async (e) => {
  await validateTextDocument(e.document);
});

/* =========================================================
   Diagnostics pipeline
   ========================================================= */

async function validateTextDocument(doc: TextDocument): Promise<void> {
  try {
    // If disabled, clear diagnostics and skip.
    if (!globalSettings.diagnostics.enabled) {
      connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
      return;
    }

    const result = await analyzeWithCache(doc);
    const coreDiags = result.diagnostics ?? [];

    const limited = coreDiags.slice(0, Math.max(0, globalSettings.maxNumberOfProblems));
    const lspDiags = limited.map((d) => toLspDiagnostic(d, doc));

    connection.sendDiagnostics({ uri: doc.uri, diagnostics: lspDiags });
  } catch (err: any) {
    connection.console.error(`[Forge] validateTextDocument failed: ${String(err?.message ?? err)}`);
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
  }
}

/* =========================================================
   Completion provider
   ========================================================= */

connection.onCompletion(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const offset = doc.offsetAt(params.position);

  const analysis = await analyzeWithCache(doc);

  const semantic =
    analysis.semantic ??
    ({
      modules: { allInOneEnabled: true, enabled: new Set(["AllInOne"]) },
      symbols: { global: {}, l: {}, v: {}, c: {} },
      types: new Map(),
    } as any);

  const items = getCompletions({
    source: doc.getText(),
    offset,
    semantic: {
      modules: semantic.modules,
      symbols: semantic.symbols,
      types: semantic.types,
    },
    maxItems: 250,
  });

  return items.map(toLspCompletionItem);
});

/* =========================================================
   Hover provider
   ========================================================= */

connection.onHover(async (params): Promise<Hover | null> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const offset = doc.offsetAt(params.position);

  const analysis = await analyzeWithCache(doc);
  const semantic =
    analysis.semantic ??
    ({
      modules: { allInOneEnabled: true, enabled: new Set(["AllInOne"]) },
      symbols: { global: {}, l: {}, v: {}, c: {} },
      types: new Map(),
    } as any);

  const h = getHover({
    source: doc.getText(),
    offset,
    semantic: {
      modules: semantic.modules,
      symbols: semantic.symbols,
      types: semantic.types,
    },
  });

  if (!h) return null;

  return {
    contents: {
      kind: "markdown",
      value: h.markdown,
    },
  };
});

/* =========================================================
   Core analysis + optional project config
   ========================================================= */

async function analyzeWithCache(doc: TextDocument): Promise<ForgeLanguageResult> {
  const existing = cache.get(doc.uri);
  if (existing && existing.version === doc.version) return existing.result;

  const text = doc.getText();

  // Build options from global settings + optional project config file
  const opts: ForgeLanguageOptions = {
    semantic: {
      relaxedMemberAccess: globalSettings.diagnostics.relaxedMemberAccess,
      // If you want module gating ignoring, add a setting; keeping strict by default.
      ignoreModuleGating: false,
    },
    lint: {
      enabled: globalSettings.lint.enabled,
      preferQuotedPrompts: globalSettings.lint.preferQuotedPrompts,
    },
    features: {
      semantic: true,
      lint: globalSettings.lint.enabled,
    },
  };

  // If enabled, load forge.config.json from project root to override options.
  let resolvedConfig: ResolvedForgeConfig | null = null;

  if (globalSettings.useProjectConfig) {
    try {
      const fsPath = uriToFsPath(doc.uri);
      // Passing workspaceRoot is optional; we just use document path as start.
      resolvedConfig = await loadForgeConfig(fsPath);

      // Apply config overrides to options
      if (resolvedConfig) {
        // Diagnostics
        opts.semantic = opts.semantic ?? {};
        opts.semantic.relaxedMemberAccess = resolvedConfig.diagnostics.relaxedMemberAccess;

        // Lint
        opts.lint = opts.lint ?? {};
        opts.lint.enabled = resolvedConfig.lint.enabled;
        opts.lint.preferQuotedPrompts = resolvedConfig.lint.preferQuotedPrompts;

        // Features
        opts.features = opts.features ?? {};
        opts.features.lint = resolvedConfig.lint.enabled;

        // Parser heuristic (if you wire it later): allowBareTemplates
        // Currently this is owned by parser.ts; you can pass it when you add a parser option surface.
      }
    } catch (e: any) {
      // Ignore config failures; keep defaults
      connection.console.warn(`[Forge] Config load failed: ${String(e?.message ?? e)}`);
    }
  }

  const result = analyzeText(text, opts);

  // Optional: if config wants soft module gating, downgrade those error codes.
  if (globalSettings.diagnostics.softModuleGating || resolvedConfig?.diagnostics.softModuleGating) {
    softenModuleGatingDiagnostics(result);
  }

  cache.set(doc.uri, {
    version: doc.version,
    result,
    config: resolvedConfig,
  });

  return result;
}

function softenModuleGatingDiagnostics(res: ForgeLanguageResult): void {
  // If core emits code "SEM_MODULE_DISABLED" as error, downgrade to warning.
  // This keeps the pipeline unchanged while allowing a "soft" project mode.
  for (const d of res.diagnostics ?? []) {
    if (d.code === "SEM_MODULE_DISABLED" && d.severity === "error") {
      (d as any).severity = "warning";
    }
  }
}

/* =========================================================
   Converters
   ========================================================= */

function toLspDiagnostic(d: CoreDiagnostic, doc: TextDocument) {
  const r = clampRangeToDoc(d.range, doc);

  return {
    severity: toLspSeverity(d.severity),
    range: {
      start: { line: r.start.line, character: r.start.column },
      end: { line: r.end.line, character: r.end.column },
    },
    message: d.hint ? `${d.message}\nHint: ${d.hint}` : d.message,
    code: d.code,
    source: d.source ?? "forge",
  };
}

function toLspSeverity(sev: CoreDiagnostic["severity"]): DiagnosticSeverity {
  switch (sev) {
    case "error":
      return DiagnosticSeverity.Error;
    case "warning":
      return DiagnosticSeverity.Warning;
    case "info":
      return DiagnosticSeverity.Information;
    default:
      return DiagnosticSeverity.Information;
  }
}

function toLspCompletionItem(item: CoreCompletionItem): CompletionItem {
  return {
    label: item.label,
    kind: toLspCompletionKind(item.kind),
    detail: item.detail,
    documentation: item.documentation,
    insertText: item.insertText ?? item.label,
    sortText: item.sortText,
  };
}

function toLspCompletionKind(kind: CoreCompletionItem["kind"]): CompletionItemKind {
  switch (kind) {
    case "keyword":
      return CompletionItemKind.Keyword;
    case "module":
      return CompletionItemKind.Module;
    case "function":
      return CompletionItemKind.Function;
    case "property":
      return CompletionItemKind.Property;
    case "snippet":
      return CompletionItemKind.Snippet;
    case "value":
      return CompletionItemKind.Value;
    case "variable":
    default:
      return CompletionItemKind.Variable;
  }
}

/* =========================================================
   URI / FS helpers
   ========================================================= */

function uriToFsPath(uri: string): string {
  try {
    return URI.parse(uri).fsPath;
  } catch {
    // Fallback: treat as plain path
    return uri;
  }
}

/* =========================================================
   Range safety (avoid crashing on bad ranges)
   ========================================================= */

function clampRangeToDoc(r: any, doc: TextDocument) {
  // Best effort clamp using line count and line lengths.
  // TextDocument doesn't expose direct line lengths easily, so we clamp offsets by using offsetAt/positionAt.
  // We trust line/column but ensure they're not negative.
  const startLine = Math.max(0, r?.start?.line ?? 0);
  const startCol = Math.max(0, r?.start?.column ?? 0);
  const endLine = Math.max(0, r?.end?.line ?? startLine);
  const endCol = Math.max(0, r?.end?.column ?? startCol);

  // Convert to offsets via doc.offsetAt, then back to normalized positions via doc.positionAt
  const start = doc.positionAt(doc.offsetAt({ line: startLine, character: startCol }));
  const end = doc.positionAt(doc.offsetAt({ line: endLine, character: endCol }));

  return {
    start: { line: start.line, column: start.character },
    end: { line: end.line, column: end.character },
  };
}

/* =========================================================
   Start listening
   ========================================================= */

documents.listen(connection);
connection.listen();
