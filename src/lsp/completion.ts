// src/core/completion.ts
//
// Forge Completions Engine
// ------------------------
// VS Code calls this through extension.ts completion provider.
// This module takes:
// - source text
// - cursor position (offset / line / column)
// - semantic result (symbols + modules + inferred types)
// And returns completion items (generic structure, extension.ts maps to VS Code types).
//
// IMPORTANT:
// - This is "smart enough" but still MVP: it avoids heavy parsing at completion-time.
// - If you want super accurate completions, you can pass in the AST node at cursor,
//   but we keep it simple: inspect left-of-cursor text to detect:
//   - member access: Time.| Sys.cpu.| console.text.|
//   - namespace stores: l.| v.| c.|
//   - top-level directives: able '...'; disable '...';
//
// Exports:
//   - getCompletions(...)
import type { ModuleContext, SymbolIndex, ForgeType, TypeMap } from "../core/semantic";

export type CompletionKind =
  | "keyword"
  | "variable"
  | "function"
  | "module"
  | "property"
  | "snippet"
  | "value";

export type CompletionItem = {
  label: string;
  kind: CompletionKind;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
};

export type CompletionRequest = {
  source: string;
  offset: number;
  line?: number;
  column?: number;

  semantic: {
    modules: ModuleContext;
    symbols: SymbolIndex;
    types?: TypeMap;
  };

  // extra tuning
  maxItems?: number;
};

export function getCompletions(req: CompletionRequest): CompletionItem[] {
  const maxItems = req.maxItems ?? 200;

  const left = req.source.slice(0, req.offset);
  const ctx = detectContext(left);

  // Directives completions
  if (ctx.kind === "directiveAble") {
    return limit(
      moduleNameItems(req.semantic.modules).map((m) => ({
        label: m,
        kind: "module",
        insertText: m,
        detail: "Forge module",
      })),
      maxItems
    );
  }

  if (ctx.kind === "directiveDisable") {
    return limit(
      [{ label: "AllInOne", kind: "module", insertText: "AllInOne", detail: "Forge module bundle" }],
      maxItems
    );
  }

  // Namespace stores
  if (ctx.kind === "store" && ctx.store) {
    const items = storeItems(req.semantic.symbols, ctx.store);
    return limit(items, maxItems);
  }

  // Member access
  if (ctx.kind === "member" && ctx.path.length) {
    const items = memberItems(ctx.path, req.semantic);
    return limit(items, maxItems);
  }

  // Otherwise: general scope completions + keywords + modules roots
  const out: CompletionItem[] = [];

  out.push(...keywordItems());
  out.push(...directiveSnippetItems());

  // Module roots
  out.push(
    ...moduleRootItems(req.semantic.modules).map<CompletionItem>((m) => ({
      label: m,
      kind: "module",
      detail: req.semantic.modules.enabled.has(m as any) || req.semantic.modules.allInOneEnabled ? "Module (available)" : "Module (not enabled)",
      insertText: m,
    }))
  );

  // Global symbols
  out.push(...symbolItems(req.semantic.symbols));

  return limit(dedupe(out), maxItems);
}

/* =========================================================
   Context detection
   ========================================================= */

type DetectedContext =
  | { kind: "member"; path: string[] } // e.g. ["Sys","cpu"]
  | { kind: "store"; store: "l" | "v" | "c" }
  | { kind: "directiveAble" }
  | { kind: "directiveDisable" }
  | { kind: "general" };

function detectContext(leftOfCursor: string): DetectedContext {
  // Trim only trailing spaces (keep newlines)
  const left = leftOfCursor.replace(/[ \t]+$/g, "");

  // able '...'
  if (/able\s*'[^']*$/.test(left)) return { kind: "directiveAble" };

  // disable '...'
  if (/disable\s*'[^']*$/.test(left)) return { kind: "directiveDisable" };

  // l. / v. / c.
  if (/\b[lvct]\.\s*$/.test(left)) {
    const m = left.match(/\b([lvc])\.\s*$/);
    if (m) return { kind: "store", store: m[1] as any };
  }

  // Member access: take token-ish chain ending with "."
  // Example:
  //   Sys.cpu.   -> path ["Sys","cpu"]
  //   console.text. -> path ["console","text"]
  //   File.dir. -> ["File","dir"]
  const chainMatch = left.match(/([A-Za-z_][A-Za-z0-9_]*)(\.[A-Za-z_][A-Za-z0-9_]*)*\.\s*$/);
  if (chainMatch) {
    const chain = chainMatch[0].trim().replace(/\.$/, "");
    const parts = chain.split(".").filter(Boolean);
    if (parts.length >= 1) return { kind: "member", path: parts };
  }

  return { kind: "general" };
}

/* =========================================================
   Keywords & snippets
   ========================================================= */

function keywordItems(): CompletionItem[] {
  const keywords = [
    "disable",
    "able",
    "let",
    "var",
    "const",
    "if",
    "elif",
    "else",
    "for",
    "forEach",
    "while",
    "do",
    "try",
    "catch",
    "finally",
    "throw",
    "return",
    "break",
    "continue",
    "func",
    "async",
    "await",
    "True",
    "False",
  ];

  return keywords.map((k) => ({
    label: k,
    kind: "keyword",
    insertText: k,
  }));
}

function directiveSnippetItems(): CompletionItem[] {
  const snippets: CompletionItem[] = [
    {
      label: "able 'Time', 'Sys', 'Math'",
      kind: "snippet",
      insertText: "able 'Time', 'Sys', 'Math'\n",
      detail: "Enable common modules",
    },
    {
      label: "disable 'AllInOne'",
      kind: "snippet",
      insertText: "disable 'AllInOne';\n",
      detail: "Disable AllInOne bundle",
    },
    {
      label: "if / elif / else block",
      kind: "snippet",
      insertText:
        "if (${1:condition}) {\n    ${2:// code}\n} elif (${3:condition}) {\n    ${4:// code}\n} else {\n    ${5:// code}\n}\n",
      detail: "Control flow",
    },
    {
      label: "try / catch / finally",
      kind: "snippet",
      insertText:
        "try {\n    ${1:// code}\n} catch (error) {\n    console.text.var('Error: {error}')\n} finally {\n    ${2:// cleanup}\n}\n",
      detail: "Error handling",
    },
  ];

  return snippets;
}

/* =========================================================
   Module items
   ========================================================= */

function moduleRootItems(mods: ModuleContext): string[] {
  // Always show module roots; if AllInOne enabled, they're effectively available.
  return [
    "Math",
    "Time",
    "Sys",
    "Terminal",
    "File",
    "Net",
    "Crypto",
    "DateTime",
    "Regex",
    "Async",
    "JSON",
    "console",
    "inp",
  ];
}

function moduleNameItems(_mods: ModuleContext): string[] {
  // Modules that can be enabled via able 'X'
  return [
    "Math",
    "Time",
    "Sys",
    "Terminal",
    "File",
    "Net",
    "Crypto",
    "DateTime",
    "Regex",
    "Async",
    "JSON",
    "AllInOne",
  ];
}

/* =========================================================
   Symbols items
   ========================================================= */

function symbolItems(symbols: SymbolIndex): CompletionItem[] {
  const out: CompletionItem[] = [];

  // Global
  for (const s of Object.values(symbols.global)) {
    out.push({
      label: s.name,
      kind: symbolKindFromType(s.type),
      detail: `${s.store} ${s.mutability} • ${fmtTypeBrief(s.type)}`,
      insertText: s.name,
    });
  }

  // Provide namespace stores as "pseudo variables"
  out.push({ label: "l.", kind: "keyword", detail: "let store namespace", insertText: "l." });
  out.push({ label: "v.", kind: "keyword", detail: "var store namespace", insertText: "v." });
  out.push({ label: "c.", kind: "keyword", detail: "const store namespace", insertText: "c." });

  return out;
}

function storeItems(symbols: SymbolIndex, store: "l" | "v" | "c"): CompletionItem[] {
  const map = store === "l" ? symbols.l : store === "v" ? symbols.v : symbols.c;
  const out: CompletionItem[] = [];

  for (const s of Object.values(map)) {
    out.push({
      label: s.name,
      kind: symbolKindFromType(s.type),
      detail: `${store}. ${s.mutability} • ${fmtTypeBrief(s.type)}`,
      insertText: s.name,
    });
  }

  // Some common store usage snippets
  if (store === "l") {
    out.push({
      label: "dog",
      kind: "variable",
      detail: "Example let variable",
      insertText: "dog",
    });
  }

  return out;
}

/* =========================================================
   Member completions (builtins)
   ========================================================= */

type BuiltinFn = { kind: "function"; label: string; detail?: string; insertText?: string; documentation?: string };
type BuiltinVal = { kind: "value"; label: string; detail?: string; insertText?: string; documentation?: string };
type BuiltinNode = BuiltinFn | BuiltinVal | { kind: "namespace"; label: string; children: Record<string, BuiltinNode> };

const BUILTINS: BuiltinNode = {
  kind: "namespace",
  label: "<root>",
  children: {
    console: {
      kind: "namespace",
      label: "console",
      children: {
        text: {
          kind: "namespace",
          label: "text",
          children: {
            var: {
              kind: "function",
              label: "var",
              detail: "Print value",
              insertText: "var",
              documentation: "console.text.var(value) prints a value to terminal output.",
            },
          },
        },
      },
    },

    inp: {
      kind: "function",
      label: "inp",
      detail: "Input string",
      insertText: "inp",
      documentation: "inp('Prompt >> ') reads a line from user input and returns a string.",
    },

    Time: {
      kind: "namespace",
      label: "Time",
      children: {
        wait: { kind: "function", label: "wait", detail: "Sleep for duration", insertText: "wait" },
        set: {
          kind: "namespace",
          label: "set",
          children: {
            fps: { kind: "function", label: "fps", detail: "Set FPS", insertText: "fps" },
          },
        },
      },
    },

    Sys: {
      kind: "namespace",
      label: "Sys",
      children: {
        exec: { kind: "function", label: "exec", detail: "Execute command", insertText: "exec" },
        process: {
          kind: "namespace",
          label: "process",
          children: {
            id: { kind: "value", label: "id", detail: "Current process id", insertText: "id" },
            kill: { kind: "function", label: "kill", detail: "Kill process by PID", insertText: "kill" },
          },
        },
        cpu: {
          kind: "namespace",
          label: "cpu",
          children: {
            cores: { kind: "value", label: "cores", detail: "CPU cores", insertText: "cores" },
            usage: { kind: "value", label: "usage", detail: "CPU usage", insertText: "usage" },
            model: { kind: "value", label: "model", detail: "CPU model", insertText: "model" },
          },
        },
        os: {
          kind: "namespace",
          label: "os",
          children: {
            name: { kind: "value", label: "name", detail: "OS name", insertText: "name" },
            version: { kind: "value", label: "version", detail: "OS version", insertText: "version" },
            arch: { kind: "value", label: "arch", detail: "OS architecture", insertText: "arch" },
          },
        },
      },
    },

    Math: {
      kind: "namespace",
      label: "Math",
      children: {
        pow: { kind: "function", label: "pow", detail: "Power", insertText: "pow" },
        round: { kind: "function", label: "round", detail: "Round", insertText: "round" },
        floor: { kind: "function", label: "floor", detail: "Floor", insertText: "floor" },
        ceil: { kind: "function", label: "ceil", detail: "Ceil", insertText: "ceil" },
        abs: { kind: "function", label: "abs", detail: "Abs", insertText: "abs" },
        min: { kind: "function", label: "min", detail: "Min", insertText: "min" },
        max: { kind: "function", label: "max", detail: "Max", insertText: "max" },
        PI: { kind: "value", label: "PI", detail: "Constant π", insertText: "PI" },
        E: { kind: "value", label: "E", detail: "Euler's number", insertText: "E" },
      },
    },

    File: {
      kind: "namespace",
      label: "File",
      children: {
        read: { kind: "function", label: "read", detail: "Read file", insertText: "read" },
        write: { kind: "function", label: "write", detail: "Write file", insertText: "write" },
        append: { kind: "function", label: "append", detail: "Append file", insertText: "append" },
        delete: { kind: "function", label: "delete", detail: "Delete file", insertText: "delete" },
        exists: { kind: "function", label: "exists", detail: "Check exists", insertText: "exists" },
        info: { kind: "function", label: "info", detail: "File info", insertText: "info" },
        copy: { kind: "function", label: "copy", detail: "Copy file", insertText: "copy" },
        move: { kind: "function", label: "move", detail: "Move file", insertText: "move" },
        dir: {
          kind: "namespace",
          label: "dir",
          children: {
            create: { kind: "function", label: "create", detail: "Create directory", insertText: "create" },
            list: { kind: "function", label: "list", detail: "List directory", insertText: "list" },
          },
        },
      },
    },

    Net: {
      kind: "namespace",
      label: "Net",
      children: {
        get: { kind: "function", label: "get", detail: "HTTP GET", insertText: "get" },
        post: { kind: "function", label: "post", detail: "HTTP POST", insertText: "post" },
        download: { kind: "function", label: "download", detail: "Download file", insertText: "download" },
        isOnline: { kind: "value", label: "isOnline", detail: "Online status", insertText: "isOnline" },
        ping: { kind: "function", label: "ping", detail: "Ping host", insertText: "ping" },
      },
    },

    Crypto: {
      kind: "namespace",
      label: "Crypto",
      children: {
        hash: {
          kind: "namespace",
          label: "hash",
          children: {
            md5: { kind: "function", label: "md5", detail: "MD5", insertText: "md5" },
            sha256: { kind: "function", label: "sha256", detail: "SHA256", insertText: "sha256" },
          },
        },
        base64: {
          kind: "namespace",
          label: "base64",
          children: {
            encode: { kind: "function", label: "encode", detail: "Base64 encode", insertText: "encode" },
            decode: { kind: "function", label: "decode", detail: "Base64 decode", insertText: "decode" },
          },
        },
      },
    },
  },
};

function memberItems(pathParts: string[], sem: CompletionRequest["semantic"]): CompletionItem[] {
  // Navigate builtin tree based on pathParts
  let node: BuiltinNode | null = BUILTINS;
  for (const p of pathParts) {
    if (!node || node.kind !== "namespace") return [];
    node = node.children[p] ?? null;
  }
  if (!node || node.kind !== "namespace") return [];

  const out: CompletionItem[] = [];
  for (const child of Object.values(node.children)) {
    if (child.kind === "namespace") {
      out.push({
        label: child.label,
        kind: "property",
        detail: "namespace",
        insertText: child.label,
      });
    } else if (child.kind === "function") {
      out.push({
        label: child.label,
        kind: "function",
        detail: child.detail ?? "function",
        documentation: child.documentation,
        insertText: child.insertText ?? child.label,
      });
    } else {
      out.push({
        label: child.label,
        kind: "value",
        detail: child.detail ?? "value",
        documentation: child.documentation,
        insertText: child.insertText ?? child.label,
      });
    }
  }

  // Soft hint: if root is a module and not enabled, suggest able 'X'
  const root = pathParts[0];
  if (isModuleRoot(root) && !sem.modules.allInOneEnabled && !sem.modules.enabled.has(root as any)) {
    out.unshift({
      label: `able '${root}'`,
      kind: "snippet",
      detail: "Enable module",
      insertText: `able '${root}'\n`,
      sortText: "0000",
    });
  }

  return out;
}

/* =========================================================
   Utilities
   ========================================================= */

function dedupe(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  const out: CompletionItem[] = [];
  for (const it of items) {
    const key = `${it.kind}|${it.label}|${it.insertText ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function limit(items: CompletionItem[], max: number): CompletionItem[] {
  if (items.length <= max) return items;
  return items.slice(0, max);
}

function symbolKindFromType(t: ForgeType): CompletionKind {
  if (t.kind === "function") return "function";
  if (t.kind === "object") return "variable";
  if (t.kind === "array") return "variable";
  if (t.kind === "string" || t.kind === "number" || t.kind === "boolean" || t.kind === "duration") return "variable";
  return "variable";
}

function fmtTypeBrief(t: ForgeType): string {
  switch (t.kind) {
    case "function":
      return "function";
    case "object":
      return "object";
    case "array":
      return "array";
    default:
      return t.kind;
  }
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
