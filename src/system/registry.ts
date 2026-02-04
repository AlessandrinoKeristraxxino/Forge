// src/core/registry.ts
//
// Forge Builtins Registry
// -----------------------
// This file defines a *single source of truth* for Forge builtins:
// - Module names
// - Namespace trees (e.g. Sys.cpu.model)
// - Function signatures (for hover / completion / semantic checks)
// - Availability conditions (AllInOne vs able 'X')
//
// This solves a big problem:
// - completion.ts and hover.ts shouldn't duplicate lists of builtins
// - semantic.ts can validate "module gating" via the same registry
//
// Exported API:
//   - FORGE_MODULES
//   - BUILTIN_REGISTRY (tree)
//   - resolveBuiltin(pathParts): BuiltinEntry | null
//   - listChildren(pathParts): BuiltinEntry[]
//   - isModuleEnabled(modCtx, moduleName): boolean
//
// NOTE:
// - The runtime implementation lives in run.ts (or runtime/* modules).
// - This file is editor-side: types, signatures, docs.

import type { ModuleContext } from "../core/semantic";

export type BuiltinKind = "namespace" | "function" | "value";

export type BuiltinEntryBase = {
  kind: BuiltinKind;
  name: string;

  // Which module provides this builtin? If null -> always available.
  module?: ForgeModuleName | null;

  // Documentation for hover
  doc?: string;

  // Optional type-ish signature string for hover
  signature?: string;

  // Sort key for completions
  sortText?: string;
};

export type BuiltinNamespace = BuiltinEntryBase & {
  kind: "namespace";
  children: Record<string, BuiltinEntry>;
};

export type BuiltinFunction = BuiltinEntryBase & {
  kind: "function";
  // Optional: parameter names for snippet completion
  params?: string[];
  // Optional: return type string (display)
  returns?: string;
};

export type BuiltinValue = BuiltinEntryBase & {
  kind: "value";
  // Optional: value type string (display)
  valueType?: string;
};

export type BuiltinEntry = BuiltinNamespace | BuiltinFunction | BuiltinValue;

/* =========================================================
   Modules
   ========================================================= */

export type ForgeModuleName =
  | "AllInOne"
  | "Math"
  | "Time"
  | "Sys"
  | "Terminal"
  | "File"
  | "Net"
  | "Crypto"
  | "DateTime"
  | "Regex"
  | "Async"
  | "JSON";

export const FORGE_MODULES: ForgeModuleName[] = [
  "AllInOne",
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
];

/* =========================================================
   Registry tree
   ========================================================= */

export const BUILTIN_REGISTRY: BuiltinNamespace = ns("<root>", null, {
  // Root functions / namespaces (always present conceptually)
  console: ns("console", null, {
    text: ns("text", null, {
      var: fn("var", null, {
        signature: "console.text.var(value: any): void",
        doc: "Print a value to terminal output.",
        params: ["value"],
        returns: "void",
      }),
    }),
  }),

  inp: fn("inp", null, {
    signature: "inp(prompt: string): string",
    doc: "Read a line from user input and return it as string.",
    params: ["prompt"],
    returns: "string",
  }),

  // inp.var is a special namespace-like property (you used it)
  // We'll model it as namespace with a function named "call".
  // completion/hover can treat this fine.
  // But to match usage `inp.var(...)`, we define it as a function on inp namespace:
  // we'll expose it under "inp" namespace as child "var".
  // To support both, keep inp as namespace too:
  // (TS-wise, we model it in registry as namespace and also allow direct call hover through resolveBuiltin)
  // For simplicity, we mirror inp in a namespace wrapper:
  _inp: ns("inp", null, {
    var: fn("var", null, {
      signature: "inp.var(prompt: string): string",
      doc: "Read a line (explicit variable input helper).",
      params: ["prompt"],
      returns: "string",
    }),
  }),

  chekBoolean: fn("chekBoolean", null, {
    signature: "chekBoolean(value: any): boolean",
    doc: "Returns True if the value is a boolean, otherwise False.",
    params: ["value"],
    returns: "boolean",
  }),

  // Modules as root namespaces
  Time: ns("Time", "Time", {
    wait: fn("wait", "Time", {
      signature: "Time.wait(duration: duration): void",
      doc: "Sleep/pause execution for a duration (e.g., 1s, 0.5s).",
      params: ["duration"],
      returns: "void",
    }),
    set: ns("set", "Time", {
      fps: fn("fps", "Time", {
        signature: "Time.set.fps(fps: number): void",
        doc: "Set the target FPS for time-based terminal animations.",
        params: ["fps"],
        returns: "void",
      }),
    }),
  }),

  Sys: ns("Sys", "Sys", {
    exec: fn("exec", "Sys", {
      signature: "Sys.exec(cmd: string): string",
      doc: "Execute a command and return stdout as a string.",
      params: ["cmd"],
      returns: "string",
    }),
    exec_async: fn("exec.async", "Sys", {
      signature: "Sys.exec.async(cmd: string): void",
      doc: "Execute a command in background (fire-and-forget).",
      params: ["cmd"],
      returns: "void",
    }),

    process: ns("process", "Sys", {
      id: val("id", "Sys", {
        signature: "Sys.process.id: number",
        doc: "Current process id (PID).",
        valueType: "number",
      }),
      kill: fn("kill", "Sys", {
        signature: "Sys.process.kill(pid: number): void",
        doc: "Terminate a process by PID.",
        params: ["pid"],
        returns: "void",
      }),
    }),

    cpu: ns("cpu", "Sys", {
      cores: val("cores", "Sys", { signature: "Sys.cpu.cores: number", doc: "CPU core count.", valueType: "number" }),
      usage: val("usage", "Sys", { signature: "Sys.cpu.usage: number", doc: "Approx CPU usage % (best effort).", valueType: "number" }),
      model: val("model", "Sys", { signature: "Sys.cpu.model: string", doc: "CPU model identifier.", valueType: "string" }),
    }),

    os: ns("os", "Sys", {
      name: val("name", "Sys", { signature: "Sys.os.name: string", doc: "OS name.", valueType: "string" }),
      version: val("version", "Sys", { signature: "Sys.os.version: string", doc: "OS version/release.", valueType: "string" }),
      arch: val("arch", "Sys", { signature: "Sys.os.arch: string", doc: "OS architecture.", valueType: "string" }),
      platform: val("platform", "Sys", { signature: "Sys.os.platform: string", doc: "OS platform.", valueType: "string" }),
    }),

    chek: ns("chek", "Sys", {
      ram: ns("ram", "Sys", {
        GB: val("GB", "Sys", {
          signature: "Sys.chek.ram.GB: number",
          doc: "Total RAM in gigabytes (rounded).",
          valueType: "number",
        }),
        comp: val("comp", "Sys", {
          signature: "Sys.chek.ram.comp: string",
          doc: "RAM vendor/company string (best effort).",
          valueType: "string",
        }),
        compFn: fn("comp", "Sys", {
          signature: "Sys.chek.ram.comp(name: string): string",
          doc: "Helper to normalize vendor string comparisons.",
          params: ["name"],
          returns: "string",
        }),
      }),
      comp: fn("comp", "Sys", {
        signature: "Sys.chek.comp(name: string): string",
        doc: "Normalize a hardware vendor string for comparisons.",
        params: ["name"],
        returns: "string",
      }),
    }),
  }),

  Math: ns("Math", "Math", {
    pow: fn("pow", "Math", {
      signature: "Math.pow(base: number, exp: number): number",
      doc: "Exponentiation (base^exp).",
      params: ["base", "exp"],
      returns: "number",
    }),
    log: fn("log", "Math", { signature: "Math.log(x: number): number", doc: "Natural log.", params: ["x"], returns: "number" }),
    log10: fn("log10", "Math", { signature: "Math.log10(x: number): number", doc: "Log base 10.", params: ["x"], returns: "number" }),
    sin: fn("sin", "Math", { signature: "Math.sin(x: number): number", doc: "Sine.", params: ["x"], returns: "number" }),
    cos: fn("cos", "Math", { signature: "Math.cos(x: number): number", doc: "Cosine.", params: ["x"], returns: "number" }),
    tan: fn("tan", "Math", { signature: "Math.tan(x: number): number", doc: "Tangent.", params: ["x"], returns: "number" }),
    round: fn("round", "Math", { signature: "Math.round(x: number): number", doc: "Round.", params: ["x"], returns: "number" }),
    floor: fn("floor", "Math", { signature: "Math.floor(x: number): number", doc: "Floor.", params: ["x"], returns: "number" }),
    ceil: fn("ceil", "Math", { signature: "Math.ceil(x: number): number", doc: "Ceil.", params: ["x"], returns: "number" }),
    abs: fn("abs", "Math", { signature: "Math.abs(x: number): number", doc: "Absolute value.", params: ["x"], returns: "number" }),
    min: fn("min", "Math", { signature: "Math.min(arr: array<number>): number", doc: "Minimum.", params: ["arr"], returns: "number" }),
    max: fn("max", "Math", { signature: "Math.max(arr: array<number>): number", doc: "Maximum.", params: ["arr"], returns: "number" }),
    avg: fn("avg", "Math", { signature: "Math.avg(arr: array<number>): number", doc: "Average.", params: ["arr"], returns: "number" }),
    sum: fn("sum", "Math", { signature: "Math.sum(arr: array<number>): number", doc: "Sum.", params: ["arr"], returns: "number" }),
    factorial: fn("factorial", "Math", { signature: "Math.factorial(n: number): number", doc: "Factorial.", params: ["n"], returns: "number" }),
    PI: val("PI", "Math", { signature: "Math.PI: number", doc: "Pi constant.", valueType: "number" }),
    E: val("E", "Math", { signature: "Math.E: number", doc: "Euler constant.", valueType: "number" }),
  }),

  File: ns("File", "File", {
    read: fn("read", "File", { signature: "File.read(path: string): string", doc: "Read UTF-8 file.", params: ["path"], returns: "string" }),
    write: fn("write", "File", { signature: "File.write(path: string, data: string): void", doc: "Write UTF-8 file.", params: ["path", "data"], returns: "void" }),
    append: fn("append", "File", { signature: "File.append(path: string, data: string): void", doc: "Append UTF-8 file.", params: ["path", "data"], returns: "void" }),
    delete: fn("delete", "File", { signature: "File.delete(path: string): void", doc: "Delete a file.", params: ["path"], returns: "void" }),
    exists: fn("exists", "File", { signature: "File.exists(path: string): boolean", doc: "Check if file exists.", params: ["path"], returns: "boolean" }),
    info: fn("info", "File", { signature: "File.info(path: string): object", doc: "File stats (size/created/modified).", params: ["path"], returns: "object" }),
    copy: fn("copy", "File", { signature: "File.copy(src: string, dst: string): void", doc: "Copy file.", params: ["src", "dst"], returns: "void" }),
    move: fn("move", "File", { signature: "File.move(src: string, dst: string): void", doc: "Move/rename file.", params: ["src", "dst"], returns: "void" }),
    dir: ns("dir", "File", {
      create: fn("create", "File", { signature: "File.dir.create(path: string): void", doc: "Create directory.", params: ["path"], returns: "void" }),
      list: fn("list", "File", { signature: "File.dir.list(path: string): array<string>", doc: "List directory entries.", params: ["path"], returns: "array<string>" }),
    }),
    read_json: fn("read.json", "File", { signature: "File.read.json(path: string): any", doc: "Read JSON file.", params: ["path"], returns: "any" }),
    write_json: fn("write.json", "File", { signature: "File.write.json(path: string, obj: any): void", doc: "Write JSON file.", params: ["path", "obj"], returns: "void" }),
    read_csv: fn("read.csv", "File", { signature: "File.read.csv(path: string): array<array<string>>", doc: "Read CSV (simple).", params: ["path"], returns: "array<array<string>>" }),
  }),

  Net: ns("Net", "Net", {
    get: fn("get", "Net", { signature: "Net.get(url: string): object", doc: "HTTP GET request.", params: ["url"], returns: "object" }),
    post: fn("post", "Net", { signature: "Net.post(url: string, body: any): object", doc: "HTTP POST request.", params: ["url", "body"], returns: "object" }),
    download: fn("download", "Net", { signature: "Net.download(url: string, outPath: string): void", doc: "Download file.", params: ["url", "outPath"], returns: "void" }),
    isOnline: val("isOnline", "Net", { signature: "Net.isOnline: boolean", doc: "Whether the network is reachable (best effort).", valueType: "boolean" }),
    ping: fn("ping", "Net", { signature: "Net.ping(host: string): object", doc: "Approximate latency via HEAD request timing.", params: ["host"], returns: "object" }),
  }),

  Crypto: ns("Crypto", "Crypto", {
    hash: ns("hash", "Crypto", {
      md5: fn("md5", "Crypto", { signature: "Crypto.hash.md5(text: string): string", doc: "MD5 hash.", params: ["text"], returns: "string" }),
      sha256: fn("sha256", "Crypto", { signature: "Crypto.hash.sha256(text: string): string", doc: "SHA256 hash.", params: ["text"], returns: "string" }),
    }),
    base64: ns("base64", "Crypto", {
      encode: fn("encode", "Crypto", { signature: "Crypto.base64.encode(text: string): string", doc: "Base64 encode.", params: ["text"], returns: "string" }),
      decode: fn("decode", "Crypto", { signature: "Crypto.base64.decode(text: string): string", doc: "Base64 decode.", params: ["text"], returns: "string" }),
    }),
    generate: ns("generate", "Crypto", {
      key: fn("key", "Crypto", { signature: "Crypto.generate.key(bits: number): string", doc: "Generate random key (hex).", params: ["bits"], returns: "string" }),
      uuid: val("uuid", "Crypto", { signature: "Crypto.generate.uuid: string", doc: "Generate UUID.", valueType: "string" }),
    }),
    aes: ns("aes", "Crypto", {
      encrypt: fn("encrypt", "Crypto", { signature: "Crypto.aes.encrypt(text: string, key: string): string", doc: "AES-256-GCM encrypt.", params: ["text", "key"], returns: "string" }),
      decrypt: fn("decrypt", "Crypto", { signature: "Crypto.aes.decrypt(cipher: string, key: string): string", doc: "AES-256-GCM decrypt.", params: ["cipher", "key"], returns: "string" }),
    }),
    random: fn("random", "Crypto", { signature: "Crypto.random(min: number, max: number): number", doc: "Secure random integer.", params: ["min", "max"], returns: "number" }),
  }),

  Terminal: ns("Terminal", "Terminal", {
    progress: ns("progress", "Terminal", {
      bar: fn("bar", "Terminal", {
        signature: "Terminal.progress.bar(percent: number, width?: number, char?: string): void",
        doc: "Render a progress bar.",
        params: ["percent", "width", "char"],
        returns: "void",
      }),
    }),
    spinner: ns("spinner", "Terminal", {
      custom: fn("custom", "Terminal", {
        signature: "Terminal.spinner.custom(frames: array<string>): void",
        doc: "Render spinner frames (runtime decides timing).",
        params: ["frames"],
        returns: "void",
      }),
    }),
    table: ns("table", "Terminal", {
      styled: fn("styled", "Terminal", {
        signature: "Terminal.table.styled(rows: array<array<string>>): void",
        doc: "Render a styled table (grid/plain).",
        params: ["rows"],
        returns: "void",
      }),
    }),
    banner: fn("banner", "Terminal", {
      signature: "Terminal.banner(text: string): void",
      doc: "Render an ASCII banner.",
      params: ["text"],
      returns: "void",
    }),
    tree: fn("tree", "Terminal", {
      signature: "Terminal.tree(obj: any): void",
      doc: "Render an ASCII tree view.",
      params: ["obj"],
      returns: "void",
    }),
    form: fn("form", "Terminal", {
      signature: "Terminal.form(schema: array<object>): object",
      doc: "Interactive form (runtime prompts).",
      params: ["schema"],
      returns: "object",
    }),
  }),
});

/* =========================================================
   Public helpers
   ========================================================= */

export function resolveBuiltin(pathParts: string[]): BuiltinEntry | null {
  if (!pathParts.length) return BUILTIN_REGISTRY;

  // Special case: treat "inp.var" as if it's in registry under "_inp"
  // (because inp is a function but we also want members).
  const normalized = normalizePathParts(pathParts);

  let node: BuiltinEntry = BUILTIN_REGISTRY;
  for (const p of normalized) {
    if (node.kind !== "namespace") return null;
    node = node.children[p] ?? null;
    if (!node) return null;
  }
  return node;
}

export function listChildren(pathParts: string[]): BuiltinEntry[] {
  const node = resolveBuiltin(pathParts);
  if (!node || node.kind !== "namespace") return [];
  return Object.values(node.children);
}

export function isModuleEnabled(modCtx: ModuleContext, moduleName: ForgeModuleName): boolean {
  if (modCtx.allInOneEnabled) return true;
  return modCtx.enabled.has(moduleName);
}

/* =========================================================
   Builders
   ========================================================= */

function ns(name: string, module: ForgeModuleName | null, children: Record<string, BuiltinEntry>): BuiltinNamespace {
  return { kind: "namespace", name, module, children };
}

function fn(
  name: string,
  module: ForgeModuleName | null,
  meta: { signature?: string; doc?: string; params?: string[]; returns?: string; sortText?: string }
): BuiltinFunction {
  return {
    kind: "function",
    name,
    module,
    signature: meta.signature,
    doc: meta.doc,
    params: meta.params,
    returns: meta.returns,
    sortText: meta.sortText,
  };
}

function val(
  name: string,
  module: ForgeModuleName | null,
  meta: { signature?: string; doc?: string; valueType?: string; sortText?: string }
): BuiltinValue {
  return {
    kind: "value",
    name,
    module,
    signature: meta.signature,
    doc: meta.doc,
    valueType: meta.valueType,
    sortText: meta.sortText,
  };
}

/* =========================================================
   Path normalization
   ========================================================= */

function normalizePathParts(parts: string[]): string[] {
  // inp.var -> _inp.var in our registry
  if (parts[0] === "inp" && parts.length >= 2) {
    return ["_inp", ...parts.slice(1)];
  }
  return parts;
}
