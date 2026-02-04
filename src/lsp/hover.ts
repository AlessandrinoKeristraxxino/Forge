// src/core/hover.ts
//
// Forge Hover Provider (language core)
// -----------------------------------
// Given source + offset and semantic info, return hover text.
// The VS Code extension maps this into vscode.Hover.
//
// MVP behavior:
// - Hover on Identifier: show symbol info (store, mutability, inferred type)
// - Hover on l./v./c. namespaced identifier: show store + type
// - Hover on module/builtin member chain: show signature / short docs
//
// NOTE: This module does NOT parse the AST at hover-time (cheap heuristic).
// For perfect results you can pass an "AST node at cursor" later.
// For now, we use token-ish extraction around the cursor offset.
//
// Exports:
//   - getHover(source, offset, semantic): HoverResult | null

import type { ModuleContext, SymbolIndex, ForgeType, TypeMap } from "../core/semantic";

export type HoverResult = {
  markdown: string; // markdown string
};

export type HoverRequest = {
  source: string;
  offset: number;

  semantic: {
    modules: ModuleContext;
    symbols: SymbolIndex;
    types?: TypeMap;
  };
};

export function getHover(req: HoverRequest): HoverResult | null {
  const word = extractWordAt(req.source, req.offset);
  if (!word) return null;

  // If cursor is on member chain, extract full chain:
  // e.g. "Sys.cpu.model" or "console.text.var"
  const chain = extractMemberChainAt(req.source, req.offset) ?? word;

  // Namespaced store: l.dog / v.dog / c.name
  const ns = parseNamespaced(chain);
  if (ns) {
    const sym = resolveStore(req.semantic.symbols, ns.store, ns.name);
    if (!sym) {
      return {
        markdown: [
          `### ${ns.store}.${ns.name}`,
          ``,
          `**Store:** \`${ns.store}\``,
          `**Status:** undefined`,
        ].join("\n"),
      };
    }

    return {
      markdown: [
        `### ${ns.store}.${ns.name}`,
        ``,
        `**Store:** \`${ns.store}\``,
        `**Mutability:** \`${sym.mutability}\``,
        `**Type:** \`${fmtType(sym.type)}\``,
      ].join("\n"),
    };
  }

  // Member chain builtins/module docs
  const builtin = builtinHover(chain, req.semantic.modules);
  if (builtin) return builtin;

  // Plain identifier hover
  const plain = resolvePlain(req.semantic.symbols, chain);
  if (plain) {
    return {
      markdown: [
        `### ${plain.name}`,
        ``,
        `**Scope:** \`${plain.store}\``,
        `**Mutability:** \`${plain.mutability}\``,
        `**Type:** \`${fmtType(plain.type)}\``,
      ].join("\n"),
    };
  }

  // If hovering "True/False"
  if (chain === "True" || chain === "False") {
    return { markdown: `\`${chain}\` — boolean literal.` };
  }

  return null;
}

/* =========================================================
   Symbol resolution helpers
   ========================================================= */

function resolvePlain(symbols: SymbolIndex, name: string) {
  return symbols.global[name] ?? null;
}

function resolveStore(symbols: SymbolIndex, store: "l" | "v" | "c", name: string) {
  const map = store === "l" ? symbols.l : store === "v" ? symbols.v : symbols.c;
  return map[name] ?? null;
}

function parseNamespaced(text: string): { store: "l" | "v" | "c"; name: string } | null {
  const m = text.match(/\b([lvc])\.([A-Za-z_][A-Za-z0-9_]*)\b/);
  if (!m) return null;
  return { store: m[1] as any, name: m[2] };
}

/* =========================================================
   Builtin hover docs
   ========================================================= */

type BuiltinDoc = {
  signature?: string;
  doc?: string;
  module?: string;
};

const BUILTIN_DOCS: Record<string, BuiltinDoc> = {
  "console.text.var": {
    signature: "console.text.var(value: any): void",
    doc: "Print a value to the Forge terminal output.",
  },
  inp: {
    signature: "inp(prompt: string): string",
    doc: "Read a line from user input and return it as a string.",
  },
  "inp.var": {
    signature: "inp.var(prompt: string): string",
    doc: "Read a line from user input, but typically used when storing into a variable explicitly.",
  },

  "Time.wait": {
    signature: "Time.wait(duration: duration): void",
    doc: "Sleep/pause execution for a duration (e.g., 1s, 0.5s).",
    module: "Time",
  },
  "Time.set.fps": {
    signature: "Time.set.fps(fps: number): void",
    doc: "Set the target FPS for time-based terminal animations.",
    module: "Time",
  },

  "Sys.exec": {
    signature: "Sys.exec(cmd: string): string",
    doc: "Execute a shell command and return its stdout as a string.",
    module: "Sys",
  },
  "Sys.process.id": {
    signature: "Sys.process.id: number",
    doc: "Current process id.",
    module: "Sys",
  },
  "Sys.process.kill": {
    signature: "Sys.process.kill(pid: number): void",
    doc: "Terminate a process by PID.",
    module: "Sys",
  },
  "Sys.cpu.cores": {
    signature: "Sys.cpu.cores: number",
    doc: "Number of CPU cores.",
    module: "Sys",
  },
  "Sys.cpu.usage": {
    signature: "Sys.cpu.usage: number",
    doc: "Approximate CPU usage percentage.",
    module: "Sys",
  },
  "Sys.cpu.model": {
    signature: "Sys.cpu.model: string",
    doc: "CPU model identifier.",
    module: "Sys",
  },

  "Math.pow": {
    signature: "Math.pow(base: number, exp: number): number",
    doc: "Exponentiation (base^exp).",
    module: "Math",
  },
  "Math.PI": {
    signature: "Math.PI: number",
    doc: "Pi constant.",
    module: "Math",
  },

  "File.read": {
    signature: "File.read(path: string): string",
    doc: "Read a file as UTF-8 text.",
    module: "File",
  },
  "File.write": {
    signature: "File.write(path: string, data: string): void",
    doc: "Write UTF-8 text to a file (overwrite).",
    module: "File",
  },
  "Net.get": {
    signature: "Net.get(url: string, options?: any): { body: any }",
    doc: "HTTP GET request.",
    module: "Net",
  },
  "Crypto.hash.sha256": {
    signature: "Crypto.hash.sha256(text: string): string",
    doc: "SHA256 hash of a string.",
    module: "Crypto",
  },
};

function builtinHover(chain: string, modules: ModuleContext): HoverResult | null {
  // Normalize chain:
  // - accept partial chains like "Sys.cpu" or "Time.set"
  // - try find the most specific doc by progressively shortening
  const candidates = makeCandidates(chain);

  for (const key of candidates) {
    const doc = BUILTIN_DOCS[key];
    if (!doc) continue;

    const lines: string[] = [];
    lines.push(`### ${key}`);
    lines.push("");
    if (doc.signature) lines.push("```forge\n" + doc.signature + "\n```");
    if (doc.doc) lines.push(doc.doc);

    if (doc.module) {
      const enabled = modules.allInOneEnabled || modules.enabled.has(doc.module as any);
      lines.push("");
      lines.push(`**Module:** \`${doc.module}\` • ${enabled ? "enabled" : "not enabled"}`);

      if (!enabled && !modules.allInOneEnabled) {
        lines.push("");
        lines.push(`> Add at top: \`able '${doc.module}'\``);
      }
    }

    return { markdown: lines.join("\n") };
  }

  return null;
}

function makeCandidates(chain: string): string[] {
  // If chain is "Sys.cpu.model", candidates:
  // ["Sys.cpu.model", "Sys.cpu", "Sys"]
  const parts = chain.split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = parts.length; i >= 1; i--) {
    out.push(parts.slice(0, i).join("."));
  }
  return out;
}

/* =========================================================
   Text extraction utilities
   ========================================================= */

function extractWordAt(src: string, offset: number): string | null {
  if (offset < 0 || offset > src.length) return null;

  // Expand around offset for [A-Za-z0-9_]
  let s = offset;
  let e = offset;

  while (s > 0 && isWordChar(src.charCodeAt(s - 1))) s--;
  while (e < src.length && isWordChar(src.charCodeAt(e))) e++;

  if (e <= s) return null;
  return src.slice(s, e);
}

function extractMemberChainAt(src: string, offset: number): string | null {
  // Look for a member chain like A.B.C around the cursor.
  // We'll expand left/right on allowed characters [A-Za-z0-9_.]
  if (offset < 0 || offset > src.length) return null;

  let s = offset;
  let e = offset;

  while (s > 0 && isChainChar(src.charCodeAt(s - 1))) s--;
  while (e < src.length && isChainChar(src.charCodeAt(e))) e++;

  const chunk = src.slice(s, e);

  // Validate chain shape: starts with ident, can have ".ident"
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(chunk)) return null;
  return chunk;
}

function isWordChar(c: number): boolean {
  // A-Z a-z 0-9 _
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    (c >= 48 && c <= 57) ||
    c === 95
  );
}

function isChainChar(c: number): boolean {
  return isWordChar(c) || c === 46; // '.'
}

/* =========================================================
   Type formatting
   ========================================================= */

function fmtType(t: ForgeType): string {
  switch (t.kind) {
    case "unknown":
    case "any":
    case "never":
    case "void":
    case "null":
    case "boolean":
    case "number":
    case "string":
    case "duration":
      return t.kind;
    case "array":
      return `array<${fmtType(t.element)}>`;
    case "object":
      return "object";
    case "function":
      return `func(${t.params.map(fmtType).join(", ")}) -> ${fmtType(t.returns)}`;
    default:
      return "unknown";
  }
}
