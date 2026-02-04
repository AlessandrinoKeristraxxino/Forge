// src/core/evaluator.ts
//
// Forge Evaluator (Interpreter Runtime)
// ------------------------------------
// This file executes a parsed Forge AST (see src/core/ast.ts).
//
// Goals:
// - Provide a real runtime model (values, scopes, control-flow)
// - Enforce Forge's "disable/able" module philosophy
// - Implement core built-ins used in your syntax examples:
//     console.text.var(...)
//     inp(...), inp.var(...)
//     chekBoolean(...)
//     Time.wait(...), Time.set.fps(...)
//     Sys.chek.ram.GB, Sys.os.*, Sys.cpu.*, Sys.exec(...)
//     File.read/write/append/exists/dir.* (subset)
//     Net.get/post/download/isOnline/ping (subset)
//     Crypto.hash.*, Crypto.base64.*, Crypto.generate.uuid, Crypto.random (subset)
//
// Notes:
// - This evaluator is written for the VS Code extension host (Node.js).
// - "Dangerous" operations (Sys.exec) are gated by policy.
// - The evaluator is async-first because Forge supports I/O (input, net, file, time).
//
// You can start by executing only a subset of the AST nodes, but keep this file
// as the single source of truth for runtime semantics.

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { exec as nodeExec } from "child_process";

import type {
  Program,
  Statement,
  Expression,
  Literal,
  Range,
  Position,
  VarNamespace,
  PropertyKey,
  CallArgument,
  NamedArgument,
  PositionalArgument,
  Identifier,
  NamespacedIdentifier,
  MemberExpression,
  CallExpression,
  UnaryExpression,
  BinaryExpression,
  AssignmentExpression,
  AssignmentStatement,
  VarDeclaration,
  ExpressionStatement,
  BlockStatement,
  IfStatement,
  WhileStatement,
  DoWhileStatement,
  ForStatement,
  ForEachStatement,
  BreakStatement,
  ContinueStatement,
  ReturnStatement,
  ThrowStatement,
  TryStatement,
  FunctionDeclaration,
  FunctionExpression,
  ArrowFunctionExpression,
  AwaitExpression,
  DisableDirective,
  AbleDirective,
  BooleanOpExpression,
  DurationLiteral,
  ObjectLiteral,
  ArrayLiteral,
  StringLiteral,
  NumberLiteral,
  BooleanLiteral,
  NullLiteral,
  TemplateString,
  TemplateExprPart,
  TemplateTextPart,
  DurationUnit,
} from "./ast";

/* =========================================================
   Runtime Types
   ========================================================= */

export type RuntimeNull = null;

export type RuntimePrimitive = string | number | boolean | RuntimeNull;

export type RuntimeObject = { [k: string]: RuntimeValue };
export type RuntimeArray = RuntimeValue[];

export type RuntimeFunction = {
  kind: "function";
  name: string | null;
  isAsync: boolean;
  call: (args: RuntimeValue[], named: Record<string, RuntimeValue>, ctx: EvalContext) => Promise<RuntimeValue>;
};

export type RuntimeValue = RuntimePrimitive | RuntimeObject | RuntimeArray | RuntimeFunction;

export function isRuntimeFunction(v: RuntimeValue): v is RuntimeFunction {
  return typeof v === "object" && v !== null && !Array.isArray(v) && (v as any).kind === "function";
}

export function isRuntimeObject(v: RuntimeValue): v is RuntimeObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !isRuntimeFunction(v);
}

/* =========================================================
   Errors
   ========================================================= */

export type RuntimeErrorCode =
  | "E_RUNTIME"
  | "E_UNSUPPORTED"
  | "E_TYPE"
  | "E_NAME"
  | "E_MODULE"
  | "E_PERMISSION"
  | "E_IO"
  | "E_NET";

export class ForgeRuntimeError extends Error {
  public readonly code: RuntimeErrorCode;
  public readonly range?: Range;

  constructor(code: RuntimeErrorCode, message: string, range?: Range) {
    super(message);
    this.code = code;
    this.range = range;
  }
}

/* =========================================================
   Host Services (pluggable I/O)
   ========================================================= */

export type ExecPolicy = {
  allowSysExec: boolean;
};

export type HostServices = {
  /** Print a line to the host (VS Code output channel, console, etc.). */
  print: (line: string) => void;

  /**
   * Request user input (VS Code input box, terminal prompt, etc.).
   * Return empty string if cancelled.
   */
  input: (prompt: string) => Promise<string>;

  /** Time sleep in milliseconds. */
  sleep: (ms: number) => Promise<void>;

  /** Random int in [min, max]. */
  randomInt: (min: number, max: number) => number;

  /** For diagnostics/logging (optional). */
  debug?: (msg: string) => void;
};

export function defaultHostServices(): HostServices {
  return {
    print: (line) => {
      // default: stdout
      process.stdout.write(String(line) + "\n");
    },
    input: async (prompt) => {
      // default: no interactive input available
      // This is intentionally "safe". The VS Code runner should provide a real input implementation.
      return "";
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomInt: (min, max) => {
      const a = Math.min(min, max);
      const b = Math.max(min, max);
      return a + Math.floor(Math.random() * (b - a + 1));
    },
    debug: undefined,
  };
}

/* =========================================================
   Module Registry (disable/able)
   ========================================================= */

export type ForgeModuleName =
  | "Sys"
  | "File"
  | "Net"
  | "Crypto"
  | "Time"
  | "Terminal"
  | "Math"
  | "DateTime"
  | "Regex"
  | "JSON"
  | "Async";

const ALL_MODULES: ForgeModuleName[] = [
  "Sys",
  "File",
  "Net",
  "Crypto",
  "Time",
  "Terminal",
  "Math",
  "DateTime",
  "Regex",
  "JSON",
  "Async",
];

class ModuleRegistry {
  private allInOneDisabled = false;
  private enabled = new Set<ForgeModuleName>();

  public disableAllInOne() {
    this.allInOneDisabled = true;
    this.enabled.clear();
  }

  public enableAllInOne() {
    this.allInOneDisabled = false;
    this.enabled = new Set(ALL_MODULES);
  }

  public able(modules: ForgeModuleName[]) {
    for (const m of modules) this.enabled.add(m);
  }

  public isAllInOneDisabled(): boolean {
    return this.allInOneDisabled;
  }

  public isEnabled(m: ForgeModuleName): boolean {
    // If AllInOne is not disabled, treat as enabled by default.
    if (!this.allInOneDisabled) return true;
    return this.enabled.has(m);
  }

  public assertEnabled(m: ForgeModuleName, range?: Range) {
    if (!this.isEnabled(m)) {
      throw new ForgeRuntimeError("E_MODULE", `Module '${m}' is not enabled. Add: able '${m}'`, range);
    }
  }
}

/* =========================================================
   Namespaced Environment (l./v./c.)
   ========================================================= */

type NamespaceMaps = {
  l: Map<string, RuntimeValue>;
  v: Map<string, RuntimeValue>;
  c: Map<string, RuntimeValue>;
};

class Scope {
  public readonly vars: NamespaceMaps;

  constructor(parent?: Scope) {
    // Shallow inheritance: start empty; reads can walk parents
    this.vars = {
      l: new Map(),
      v: new Map(),
      c: new Map(),
    };
    void parent;
  }
}

class Environment {
  private scopes: Scope[] = [new Scope()];
  private readonly globals: RuntimeObject;

  constructor(globals: RuntimeObject) {
    this.globals = globals;
  }

  public pushScope() {
    this.scopes.push(new Scope(this.current()));
  }

  public popScope() {
    if (this.scopes.length <= 1) return; // keep global scope
    this.scopes.pop();
  }

  public current(): Scope {
    return this.scopes[this.scopes.length - 1];
  }

  public declare(ns: VarNamespace, name: string, value: RuntimeValue, range?: Range) {
    const cur = this.current().vars[ns];
    if (cur.has(name)) {
      throw new ForgeRuntimeError("E_NAME", `Duplicate declaration: '${ns}.${name}'`, range);
    }
    cur.set(name, value);
  }

  public assign(ns: VarNamespace, name: string, value: RuntimeValue, range?: Range) {
    // Find nearest scope that contains the binding; otherwise assign into current (Forge can be strict or permissive;
    // here we are strict for 'l' and 'c', permissive for 'v'. You can tune later.)
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const table = this.scopes[i].vars[ns];
      if (table.has(name)) {
        // const lock
        if (ns === "c") {
          throw new ForgeRuntimeError("E_NAME", `Cannot reassign const: 'c.${name}'`, range);
        }
        table.set(name, value);
        return;
      }
    }

    // Not found: treat as error (recommended for a real language)
    throw new ForgeRuntimeError("E_NAME", `Unknown variable '${ns}.${name}'. Declare it first.`, range);
  }

  public get(ns: VarNamespace, name: string, range?: Range): RuntimeValue {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const table = this.scopes[i].vars[ns];
      if (table.has(name)) return table.get(name)!;
    }
    throw new ForgeRuntimeError("E_NAME", `Unknown variable '${ns}.${name}'.`, range);
  }

  public has(ns: VarNamespace, name: string): boolean {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].vars[ns].has(name)) return true;
    }
    return false;
  }

  public resolveUnqualified(name: string, range?: Range): { ns: VarNamespace; value: RuntimeValue } {
    const hits: VarNamespace[] = [];
    for (const ns of ["l", "v", "c"] as VarNamespace[]) {
      if (this.has(ns, name)) hits.push(ns);
    }
    if (hits.length === 0) throw new ForgeRuntimeError("E_NAME", `Unknown variable '${name}'. Use l./v./c.`, range);
    if (hits.length > 1) {
      throw new ForgeRuntimeError(
        "E_NAME",
        `Ambiguous variable '${name}' found in ${hits.map((h) => `${h}.`).join(", ")} Use an explicit namespace.`,
        range
      );
    }
    const ns = hits[0];
    return { ns, value: this.get(ns, name, range) };
  }

  public getGlobal(name: string): RuntimeValue | undefined {
    return this.globals[name];
  }
}

/* =========================================================
   Control Flow Signals
   ========================================================= */

class BreakSignal extends Error {}
class ContinueSignal extends Error {}
class ReturnSignal extends Error {
  constructor(public readonly value: RuntimeValue) {
    super("return");
  }
}

/* =========================================================
   Eval Context
   ========================================================= */

export type EvalOptions = {
  execPolicy?: ExecPolicy;
};

export type EvalContext = {
  readonly host: HostServices;
  readonly modules: ModuleRegistry;
  readonly env: Environment;
  readonly policy: ExecPolicy;

  /** Mutable execution parameter; Time.set.fps updates this. */
  fps: number;
};

/* =========================================================
   Helpers: Type / Conversions
   ========================================================= */

function toStringValue(v: RuntimeValue): string {
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NaN";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (Array.isArray(v)) return `[${v.map(toStringValue).join(", ")}]`;
  if (isRuntimeFunction(v)) return `[function${v.name ? ` ${v.name}` : ""}]`;
  return JSON.stringify(v);
}

function isBooleanLike(v: RuntimeValue): { ok: true; value: boolean } | { ok: false } {
  if (typeof v === "boolean") return { ok: true, value: v };

  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true") return { ok: true, value: true };
    if (t === "false") return { ok: true, value: false };
    return { ok: false };
  }

  return { ok: false };
}

function castToBoolean(v: RuntimeValue, forced: boolean | null): boolean {
  // Forge cast:
  // - if forced is true/false -> return that
  // - if boolean -> itself
  // - if string "true"/"false" -> parse
  // - otherwise -> truthiness (numbers != 0, non-empty strings, non-null objects/arrays)
  if (forced !== null) return forced;

  const like = isBooleanLike(v);
  if (like.ok) return like.value;

  if (v === null) return false;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  // objects/functions/arrays are truthy
  return true;
}

function ensureNumber(v: RuntimeValue, range?: Range): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^[+-]?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  throw new ForgeRuntimeError("E_TYPE", `Expected number, got ${typeof v}.`, range);
}

function ensureString(v: RuntimeValue, range?: Range): string {
  if (typeof v === "string") return v;
  throw new ForgeRuntimeError("E_TYPE", `Expected string, got ${typeof v}.`, range);
}

function ensureObject(v: RuntimeValue, range?: Range): RuntimeObject {
  if (isRuntimeObject(v)) return v;
  throw new ForgeRuntimeError("E_TYPE", `Expected object, got ${Array.isArray(v) ? "array" : typeof v}.`, range);
}

function ensureArray(v: RuntimeValue, range?: Range): RuntimeArray {
  if (Array.isArray(v)) return v;
  throw new ForgeRuntimeError("E_TYPE", `Expected array, got ${typeof v}.`, range);
}

function ensureRuntimeFunction(v: RuntimeValue, name: string, range?: Range): RuntimeFunction {
  if (isRuntimeFunction(v)) return v;
  throw new ForgeRuntimeError("E_TYPE", `Expected function '${name}'.`, range);
}

function assertNeverNode(node: never): never {
  // This should never happen if AST unions and evaluator switches stay in sync.
  const raw = node as unknown as { kind?: string; range?: Range };
  throw new ForgeRuntimeError("E_UNSUPPORTED", `Unsupported AST node kind: ${raw.kind ?? "<unknown>"}`, raw.range);
}

function safePath(p: string): string {
  // allow relative/absolute, normalize
  return path.normalize(p);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function rangeOf(node: { range: Range }): Range {
  return node.range;
}

/* =========================================================
   Built-ins
   ========================================================= */

function makeBuiltinFunction(
  name: string,
  fn: (args: RuntimeValue[], named: Record<string, RuntimeValue>, ctx: EvalContext) => Promise<RuntimeValue>,
  isAsync = true
): RuntimeFunction {
  return {
    kind: "function",
    name,
    isAsync,
    call: fn,
  };
}

function buildGlobals(ctx: EvalContext): RuntimeObject {
  // console.text.var(...)
  const consoleObj: RuntimeObject = {
    text: {
      var: makeBuiltinFunction(
        "console.text.var",
        async (args, _named, innerCtx) => {
          const value = args.length > 0 ? args[0] : null;
          innerCtx.host.print(toStringValue(value));
          return null;
        },
        true
      ),
    },
  };

  // inp(...) and inp.var(...)
  const inpFn = makeBuiltinFunction("inp", async (args, _named, innerCtx) => {
    const prompt = args.length > 0 ? toStringValue(args[0]) : "";
    const val = await innerCtx.host.input(prompt);
    return val;
  });

  const inpVarFn = makeBuiltinFunction("inp.var", async (args, _named, innerCtx) => {
    const prompt = args.length > 0 ? toStringValue(args[0]) : "";
    const val = await innerCtx.host.input(prompt);
    return val.trim();
  });

  const inpObj: RuntimeObject = {
    // allow both styles:
    // - inp("... >> ")
    // - inp.var("... >> ")
    ...(inpFn as any),
    var: inpVarFn,
  };

  // chekBoolean(x)
  const chekBooleanFn = makeBuiltinFunction("chekBoolean", async (args) => {
    const v = args.length > 0 ? args[0] : null;
    const like = isBooleanLike(v);
    // Your examples: chekBoolean(l.dog) prints False when dog is a string
    // So we return True/False depending on "is boolean-like"
    return like.ok ? true : false;
  });

  // Time module
  const TimeObj: RuntimeObject = {
    wait: makeBuiltinFunction("Time.wait", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("Time");
      const v = args.length > 0 ? args[0] : 0;
      // Accept DurationLiteral as number(ms) at runtime or number seconds
      let ms: number;

      if (typeof v === "number") {
        // treat as seconds if small? safer: treat as seconds
        ms = v * 1000;
      } else if (typeof v === "string") {
        // accept "1s", "200ms", "0.5s"
        const m = v.trim().match(/^([0-9]+(\.[0-9]+)?)\s*(ms|s|m|h)$/);
        if (!m) throw new ForgeRuntimeError("E_TYPE", `Invalid duration string: '${v}'`);
        const num = Number(m[1]);
        const unit = m[3] as DurationUnit;
        ms = durationToMs(num, unit);
      } else {
        throw new ForgeRuntimeError("E_TYPE", "Time.wait expects a number (seconds) or a duration string like '0.5s'.");
      }

      await innerCtx.host.sleep(ms);
      return null;
    }),

    set: {
      fps: makeBuiltinFunction("Time.set.fps", async (args, _named, innerCtx) => {
        innerCtx.modules.assertEnabled("Time");
        const n = args.length > 0 ? ensureNumber(args[0]) : 30;
        const fps = Math.max(1, Math.min(240, Math.floor(n)));
        innerCtx.fps = fps;
        return fps;
      }),
    },
  };

  // Math module (subset)
  const MathObj: RuntimeObject = {
    pow: makeBuiltinFunction("Math.pow", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("Math");
      const a = args.length > 0 ? ensureNumber(args[0]) : 0;
      const b = args.length > 1 ? ensureNumber(args[1]) : 0;
      return Math.pow(a, b);
    }),
    random: makeBuiltinFunction("Math.random", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("Math");
      const min = args.length > 0 ? ensureNumber(args[0]) : 0;
      const max = args.length > 1 ? ensureNumber(args[1]) : 1;
      return innerCtx.host.randomInt(min, max);
    }),
    sqrt: makeBuiltinFunction("Math.sqrt", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("Math");
      const x = args.length > 0 ? ensureNumber(args[0]) : 0;
      return Math.sqrt(x);
    }),
    abs: makeBuiltinFunction("Math.abs", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("Math");
      const x = args.length > 0 ? ensureNumber(args[0]) : 0;
      return Math.abs(x);
    }),
    PI: Math.PI,
    E: Math.E,
  };

  // Sys module (subset, safe by default)
  const SysObj: RuntimeObject = {
    // Sys.chek.ram.GB / Sys.chek.ram.comp
    chek: {
      ram: {
        GB: Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10,
        comp: "unknown",
      },
      // Example helper: Sys.chek.comp(NAME)
      comp: makeBuiltinFunction("Sys.chek.comp", async (args, _named, innerCtx) => {
        innerCtx.modules.assertEnabled("Sys");
        // In your snippets you compare against Sys.chek.comp(NVIDIA).
        // We'll just return the normalized identifier as a string.
        const name = args.length > 0 ? toStringValue(args[0]) : "";
        return name.trim();
      }),
      // Example helper: Sys.chek.ram.comp(NVIDIA)
      // Not real hardware detection: this returns its argument string.
      "ram.comp": makeBuiltinFunction("Sys.chek.ram.comp", async (args, _named, innerCtx) => {
        innerCtx.modules.assertEnabled("Sys");
        const name = args.length > 0 ? toStringValue(args[0]) : "";
        return name.trim();
      }),
    },

    os: {
      name: os.platform(),
      version: os.release(),
      arch: os.arch(),
    },

    cpu: {
      cores: os.cpus().length,
      usage: 0,
      model: os.cpus()[0]?.model ?? "unknown",
    },

    process: {
      id: process.pid,
      kill: makeBuiltinFunction("Sys.process.kill", async (args, _named, innerCtx) => {
        innerCtx.modules.assertEnabled("Sys");
        const pid = args.length > 0 ? ensureNumber(args[0]) : 0;
        try {
          process.kill(pid);
          return true;
        } catch (e) {
          throw new ForgeRuntimeError("E_IO", `Failed to kill process ${pid}: ${String(e)}`);
        }
      }),
    },

    exit: makeBuiltinFunction("Sys.exit", async (_args, _named, _innerCtx) => {
      // In a VS Code extension you shouldn't terminate the process.
      // We'll throw a return-like signal to stop execution cleanly.
      throw new ReturnSignal(null);
    }),

    exec: makeBuiltinFunction("Sys.exec", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("Sys");

      if (!innerCtx.policy.allowSysExec) {
        throw new ForgeRuntimeError(
          "E_PERMISSION",
          `Sys.exec is disabled by policy. Enable it via setting: forge.system.allowSysExec = true`
        );
      }

      const cmd = args.length > 0 ? ensureString(args[0]) : "";
      if (!cmd.trim()) return "";

      const result = await execCommand(cmd);
      return result;
    }),

    execAsync: makeBuiltinFunction("Sys.exec.async", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("Sys");

      if (!innerCtx.policy.allowSysExec) {
        throw new ForgeRuntimeError(
          "E_PERMISSION",
          `Sys.exec.async is disabled by policy. Enable it via setting: forge.system.allowSysExec = true`
        );
      }

      const cmd = args.length > 0 ? ensureString(args[0]) : "";
      if (!cmd.trim()) return true;

      execCommand(cmd).catch((e) => innerCtx.host.debug?.(`[Sys.exec.async] ${String(e)}`));
      return true;
    }),
  };

  // File module (subset)
  const FileObj: RuntimeObject = {
    read: makeBuiltinFunction("File.read", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("File");
      const p = args.length > 0 ? ensureString(args[0]) : "";
      const filePath = safePath(p);
      try {
        const buf = await fsp.readFile(filePath);
        return buf.toString("utf8");
      } catch (e) {
        throw new ForgeRuntimeError("E_IO", `File.read failed: ${String(e)}`);
      }
    }),

    write: makeBuiltinFunction("File.write", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("File");
      const p = args.length > 0 ? ensureString(args[0]) : "";
      const content = args.length > 1 ? toStringValue(args[1]) : "";
      const filePath = safePath(p);
      try {
        await fsp.writeFile(filePath, content, "utf8");
        return true;
      } catch (e) {
        throw new ForgeRuntimeError("E_IO", `File.write failed: ${String(e)}`);
      }
    }),

    append: makeBuiltinFunction("File.append", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("File");
      const p = args.length > 0 ? ensureString(args[0]) : "";
      const content = args.length > 1 ? toStringValue(args[1]) : "";
      const filePath = safePath(p);
      try {
        await fsp.appendFile(filePath, content, "utf8");
        return true;
      } catch (e) {
        throw new ForgeRuntimeError("E_IO", `File.append failed: ${String(e)}`);
      }
    }),

    delete: makeBuiltinFunction("File.delete", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("File");
      const p = args.length > 0 ? ensureString(args[0]) : "";
      const filePath = safePath(p);
      try {
        await fsp.unlink(filePath);
        return true;
      } catch (e) {
        throw new ForgeRuntimeError("E_IO", `File.delete failed: ${String(e)}`);
      }
    }),

    exists: makeBuiltinFunction("File.exists", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("File");
      const p = args.length > 0 ? ensureString(args[0]) : "";
      return (await fileExists(safePath(p))) ? true : false;
    }),

    info: makeBuiltinFunction("File.info", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("File");
      const p = args.length > 0 ? ensureString(args[0]) : "";
      const filePath = safePath(p);
      try {
        const st = await fsp.stat(filePath);
        return {
          size: st.size,
          created: st.birthtime.toISOString(),
          modified: st.mtime.toISOString(),
        };
      } catch (e) {
        throw new ForgeRuntimeError("E_IO", `File.info failed: ${String(e)}`);
      }
    }),

    dir: {
      create: makeBuiltinFunction("File.dir.create", async (args, _named, innerCtx) => {
        innerCtx.modules.assertEnabled("File");
        const p = args.length > 0 ? ensureString(args[0]) : "";
        try {
          await fsp.mkdir(safePath(p), { recursive: true });
          return true;
        } catch (e) {
          throw new ForgeRuntimeError("E_IO", `File.dir.create failed: ${String(e)}`);
        }
      }),

      list: makeBuiltinFunction("File.dir.list", async (args, _named, innerCtx) => {
        innerCtx.modules.assertEnabled("File");
        const p = args.length > 0 ? ensureString(args[0]) : ".";
        try {
          const items = await fsp.readdir(safePath(p));
          return items;
        } catch (e) {
          throw new ForgeRuntimeError("E_IO", `File.dir.list failed: ${String(e)}`);
        }
      }),
    },

    // JSON helpers
    "read.json": makeBuiltinFunction("File.read.json", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("File");
      const p = args.length > 0 ? ensureString(args[0]) : "";
      const readFn = ensureRuntimeFunction(FileObj.read, "File.read");
      const txt = ensureString(await readFn.call([p], {}, innerCtx));
      try {
        return JSON.parse(txt);
      } catch (e) {
        throw new ForgeRuntimeError("E_IO", `File.read.json parse error: ${String(e)}`);
      }
    }),

    "write.json": makeBuiltinFunction("File.write.json", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("File");
      const p = args.length > 0 ? ensureString(args[0]) : "";
      const obj = args.length > 1 ? args[1] : {};
      const txt = JSON.stringify(obj, null, 2);
      const writeFn = ensureRuntimeFunction(FileObj.write, "File.write");
      await writeFn.call([p, txt], {}, innerCtx);
      return true;
    }),
  };

  // Net module (subset; uses global fetch in Node 18)
  const NetObj: RuntimeObject = {
    get: makeBuiltinFunction("Net.get", async (args, named, innerCtx) => {
      innerCtx.modules.assertEnabled("Net");
      const url = args.length > 0 ? ensureString(args[0]) : "";
      const headers = named["headers"] ? ensureObject(named["headers"]) : undefined;

      try {
        const res = await fetch(url, { method: "GET", headers: headers as any });
        const body = await res.text();
        return {
          status: res.status,
          ok: res.ok,
          body,
        };
      } catch (e) {
        throw new ForgeRuntimeError("E_NET", `Net.get failed: ${String(e)}`);
      }
    }),

    post: makeBuiltinFunction("Net.post", async (args, named, innerCtx) => {
      innerCtx.modules.assertEnabled("Net");
      const url = args.length > 0 ? ensureString(args[0]) : "";
      const data = args.length > 1 ? args[1] : {};
      const headers = named["headers"] ? ensureObject(named["headers"]) : undefined;

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(headers as any) },
          body: JSON.stringify(data),
        });
        const body = await res.text();
        return {
          status: res.status,
          ok: res.ok,
          body,
        };
      } catch (e) {
        throw new ForgeRuntimeError("E_NET", `Net.post failed: ${String(e)}`);
      }
    }),

    download: makeBuiltinFunction("Net.download", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("Net");
      innerCtx.modules.assertEnabled("File");
      const url = args.length > 0 ? ensureString(args[0]) : "";
      const outPath = args.length > 1 ? ensureString(args[1]) : "";

      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await fsp.mkdir(path.dirname(safePath(outPath)), { recursive: true });
        await fsp.writeFile(safePath(outPath), buf);
        return true;
      } catch (e) {
        throw new ForgeRuntimeError("E_NET", `Net.download failed: ${String(e)}`);
      }
    }),

    isOnline: true,

    ping: makeBuiltinFunction("Net.ping", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("Net");
      // Cross-platform ping is complicated; we provide a simple HTTP-based ping for MVP.
      const host = args.length > 0 ? ensureString(args[0]) : "google.com";
      const url = host.startsWith("http") ? host : `https://${host}`;
      const start = Date.now();
      try {
        await fetch(url, { method: "HEAD" });
        const latency = Date.now() - start;
        return { latency };
      } catch {
        return { latency: -1 };
      }
    }),
  };

  // Crypto module (subset)
  const CryptoObj: RuntimeObject = {
    hash: {
      md5: makeBuiltinFunction("Crypto.hash.md5", async (args, _named, innerCtx) => {
        innerCtx.modules.assertEnabled("Crypto");
        const text = args.length > 0 ? toStringValue(args[0]) : "";
        return crypto.createHash("md5").update(text).digest("hex");
      }),
      sha256: makeBuiltinFunction("Crypto.hash.sha256", async (args, _named, innerCtx) => {
        innerCtx.modules.assertEnabled("Crypto");
        const text = args.length > 0 ? toStringValue(args[0]) : "";
        return crypto.createHash("sha256").update(text).digest("hex");
      }),
    },
    base64: {
      encode: makeBuiltinFunction("Crypto.base64.encode", async (args, _named, innerCtx) => {
        innerCtx.modules.assertEnabled("Crypto");
        const text = args.length > 0 ? toStringValue(args[0]) : "";
        return Buffer.from(text, "utf8").toString("base64");
      }),
      decode: makeBuiltinFunction("Crypto.base64.decode", async (args, _named, innerCtx) => {
        innerCtx.modules.assertEnabled("Crypto");
        const b64 = args.length > 0 ? ensureString(args[0]) : "";
        return Buffer.from(b64, "base64").toString("utf8");
      }),
    },
    generate: {
      uuid: crypto.randomUUID(),
      key: makeBuiltinFunction("Crypto.generate.key", async (args, _named, innerCtx) => {
        innerCtx.modules.assertEnabled("Crypto");
        const bits = args.length > 0 ? ensureNumber(args[0]) : 256;
        const bytes = Math.max(16, Math.floor(bits / 8));
        return crypto.randomBytes(bytes).toString("hex");
      }),
    },
    random: makeBuiltinFunction("Crypto.random", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("Crypto");
      const min = args.length > 0 ? ensureNumber(args[0]) : 0;
      const max = args.length > 1 ? ensureNumber(args[1]) : 1;
      return innerCtx.host.randomInt(min, max);
    }),
    // AES simple (hex key -> derive 32 bytes using sha256)
    aes: {
      encrypt: makeBuiltinFunction("Crypto.aes.encrypt", async (args, _named, innerCtx) => {
        innerCtx.modules.assertEnabled("Crypto");
        const plaintext = args.length > 0 ? toStringValue(args[0]) : "";
        const keyHex = args.length > 1 ? ensureString(args[1]) : "";
        const key = crypto.createHash("sha256").update(keyHex).digest(); // 32 bytes
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
        const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        // return iv:payload base64
        return `${iv.toString("base64")}:${enc.toString("base64")}`;
      }),
      decrypt: makeBuiltinFunction("Crypto.aes.decrypt", async (args, _named, innerCtx) => {
        innerCtx.modules.assertEnabled("Crypto");
        const payload = args.length > 0 ? ensureString(args[0]) : "";
        const keyHex = args.length > 1 ? ensureString(args[1]) : "";
        const key = crypto.createHash("sha256").update(keyHex).digest();

        const [ivB64, dataB64] = payload.split(":");
        if (!ivB64 || !dataB64) throw new ForgeRuntimeError("E_TYPE", "Invalid AES payload format.");
        const iv = Buffer.from(ivB64, "base64");
        const data = Buffer.from(dataB64, "base64");
        const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
        const dec = Buffer.concat([decipher.update(data), decipher.final()]);
        return dec.toString("utf8");
      }),
    },
  };

  // Terminal module (subset: it prints, in a consistent simple way)
  const TerminalObj: RuntimeObject = {
    progress: {
      bar: makeBuiltinFunction("Terminal.progress.bar", async (args, named, innerCtx) => {
        innerCtx.modules.assertEnabled("Terminal");
        const pct = args.length > 0 ? ensureNumber(args[0]) : 0;
        const width = named["width"] ? ensureNumber(named["width"]) : 30;
        const ch = named["char"] ? ensureString(named["char"]) : "#";

        const clamped = Math.max(0, Math.min(100, pct));
        const filled = Math.round((clamped / 100) * width);
        const bar = ch.repeat(filled) + " ".repeat(Math.max(0, width - filled));
        innerCtx.host.print(`[${bar}] ${clamped}%`);
        return null;
      }),
    },
    banner: makeBuiltinFunction("Terminal.banner", async (args, _named, innerCtx) => {
      innerCtx.modules.assertEnabled("Terminal");
      const text = args.length > 0 ? toStringValue(args[0]) : "";
      innerCtx.host.print(`=== ${text} ===`);
      return null;
    }),
  };

  const globals: RuntimeObject = {
    console: consoleObj,
    inp: inpObj,
    chekBoolean: chekBooleanFn,

    // modules
    Time: TimeObj,
    Math: MathObj,
    Sys: SysObj,
    File: FileObj,
    Net: NetObj,
    Crypto: CryptoObj,
    Terminal: TerminalObj,

    // JSON / Async are mapped to host JS semantics (subset)
    JSON: {
      parse: makeBuiltinFunction("JSON.parse", async (args) => {
        const s = args.length > 0 ? ensureString(args[0]) : "";
        return JSON.parse(s);
      }),
      stringify: makeBuiltinFunction("JSON.stringify", async (args, named) => {
        const obj = args.length > 0 ? args[0] : {};
        const indent = named["indent"] ? ensureNumber(named["indent"]) : 0;
        return JSON.stringify(obj, null, indent > 0 ? indent : undefined);
      }),
    },

    Async: {
      promise: makeBuiltinFunction("Async.promise", async () => {
        throw new ForgeRuntimeError("E_UNSUPPORTED", "Async.promise is not implemented in the evaluator yet.");
      }),
    },
  };

  // Explicitly use ctx to avoid linter warnings
  void ctx;

  return globals;
}

/* =========================================================
   Duration helper
   ========================================================= */

function durationToMs(value: number, unit: DurationUnit): number {
  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
  }
}

/* =========================================================
   Sys.exec helper
   ========================================================= */

async function execCommand(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeExec(cmd, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      const out = (stdout ?? "").toString();
      const errOut = (stderr ?? "").toString();
      const combined = [out.trimEnd(), errOut.trimEnd()].filter(Boolean).join("\n");
      resolve(combined);
    });
  });
}

/* =========================================================
   Evaluator
   ========================================================= */

export class Evaluator {
  private readonly ctx: EvalContext;

  constructor(host?: Partial<HostServices>, options?: EvalOptions) {
    const hostFull: HostServices = { ...defaultHostServices(), ...(host ?? {}) };

    const modules = new ModuleRegistry();
    // By default, AllInOne is enabled unless explicitly disabled in code.
    modules.enableAllInOne();

    const policy: ExecPolicy = {
      allowSysExec: options?.execPolicy?.allowSysExec ?? false,
    };

    const ctxDraft: EvalContext = {
      host: hostFull,
      modules,
      env: new Environment({} as RuntimeObject),
      policy,
      fps: 30,
    };

    // build and inject globals
    const globals = buildGlobals(ctxDraft);
    (ctxDraft.env as any) = new Environment(globals);

    this.ctx = ctxDraft;
  }

  public getContext(): EvalContext {
    return this.ctx;
  }

  public async evaluate(program: Program): Promise<RuntimeValue> {
    return this.evalProgram(program);
  }

  /* =========================================================
     Program / Statements
     ========================================================= */

  private async evalProgram(program: Program): Promise<RuntimeValue> {
    let last: RuntimeValue = null;

    for (const st of program.body) {
      last = await this.evalStatement(st);
    }

    return last;
  }

  private async evalStatement(st: Statement): Promise<RuntimeValue> {
    switch (st.kind) {
      case "DisableDirective":
        return this.evalDisableDirective(st as DisableDirective);

      case "AbleDirective":
        return this.evalAbleDirective(st as AbleDirective);

      case "BlockStatement":
        return this.evalBlock(st as BlockStatement);

      case "VarDeclaration":
        return this.evalVarDeclaration(st as VarDeclaration);

      case "AssignmentStatement":
        return this.evalAssignmentStatement(st as AssignmentStatement);

      case "ExpressionStatement":
        return this.evalExpressionStatement(st as ExpressionStatement);

      case "IfStatement":
        return this.evalIfStatement(st as IfStatement);

      case "WhileStatement":
        return this.evalWhileStatement(st as WhileStatement);

      case "DoWhileStatement":
        return this.evalDoWhileStatement(st as DoWhileStatement);

      case "ForStatement":
        return this.evalForStatement(st as ForStatement);

      case "ForEachStatement":
        return this.evalForEachStatement(st as ForEachStatement);

      case "BreakStatement":
        throw new BreakSignal();

      case "ContinueStatement":
        throw new ContinueSignal();

      case "ReturnStatement":
        return this.evalReturnStatement(st as ReturnStatement);

      case "ThrowStatement":
        return this.evalThrowStatement(st as ThrowStatement);

      case "TryStatement":
        return this.evalTryStatement(st as TryStatement);

      case "FunctionDeclaration":
        return this.evalFunctionDeclaration(st as FunctionDeclaration);

      default:
        return assertNeverNode(st);
    }
  }

  private async evalDisableDirective(st: DisableDirective): Promise<RuntimeValue> {
    const target = st.target.value;
    if (target === "AllInOne") {
      this.ctx.modules.disableAllInOne();
      return null;
    }
    // Future: disable individual modules
    throw new ForgeRuntimeError("E_UNSUPPORTED", `disable '${target}' is not supported yet (only AllInOne).`, st.range);
  }

  private async evalAbleDirective(st: AbleDirective): Promise<RuntimeValue> {
    const mods = st.modules.map((m) => m.value).filter(Boolean) as string[];
    const parsed: ForgeModuleName[] = [];
    for (const m of mods) {
      if (ALL_MODULES.includes(m as ForgeModuleName)) parsed.push(m as ForgeModuleName);
    }
    this.ctx.modules.able(parsed);
    return null;
  }

  private async evalBlock(st: BlockStatement): Promise<RuntimeValue> {
    this.ctx.env.pushScope();
    try {
      let last: RuntimeValue = null;
      for (const inner of st.body) {
        last = await this.evalStatement(inner);
      }
      return last;
    } finally {
      this.ctx.env.popScope();
    }
  }

  private async evalVarDeclaration(st: VarDeclaration): Promise<RuntimeValue> {
    const declKind = st.declKind; // let|var|const
    const ns: VarNamespace = declKind === "let" ? "l" : declKind === "var" ? "v" : "c";
    const name = st.name.name;

    const value = st.initializer ? await this.evalExpression(st.initializer) : null;
    this.ctx.env.declare(ns, name, value, st.range);
    return null;
  }

  private async evalAssignmentStatement(st: AssignmentStatement): Promise<RuntimeValue> {
    const value = await this.evalExpression(st.value);

    // Assignment target can be:
    // - NamespacedIdentifier
    // - Identifier (unqualified)
    // - MemberExpression (object property)
    return this.assignToTarget(st.target, value, st.range);
  }

  private async assignToTarget(target: any, value: RuntimeValue, range?: Range): Promise<RuntimeValue> {
    if (target.kind === "NamespacedIdentifier") {
      const t = target as NamespacedIdentifier;
      this.ctx.env.assign(t.namespace, t.name.name, value, range);
      return value;
    }

    if (target.kind === "Identifier") {
      const t = target as Identifier;
      // unqualified assignment is ambiguous; resolve must be unique
      const resolved = this.ctx.env.resolveUnqualified(t.name, range);
      this.ctx.env.assign(resolved.ns, t.name, value, range);
      return value;
    }

    if (target.kind === "MemberExpression") {
      const mem = target as MemberExpression;
      const objVal = await this.evalExpression(mem.object);
      const obj = ensureObject(objVal, range);
      const key = mem.property.name;
      obj[key] = value;
      return value;
    }

    throw new ForgeRuntimeError("E_UNSUPPORTED", `Invalid assignment target: ${target.kind}`, range);
  }

  private async evalExpressionStatement(st: ExpressionStatement): Promise<RuntimeValue> {
    return this.evalExpression(st.expression);
  }

  private async evalIfStatement(st: IfStatement): Promise<RuntimeValue> {
    const test = await this.evalExpression(st.test);
    if (castToBoolean(test, null)) {
      return this.evalBlock(st.consequent);
    }

    // elif clauses are encoded as pseudo objects in ast.ts; evaluator only needs fields
    for (const clause of st.elifClauses as any[]) {
      if (!clause || clause._clause !== "ElifClause") continue;
      const t = await this.evalExpression(clause.test as Expression);
      if (castToBoolean(t, null)) {
        return this.evalBlock(clause.consequent as BlockStatement);
      }
    }

    if (st.alternate) return this.evalBlock(st.alternate);
    return null;
  }

  private async evalWhileStatement(st: WhileStatement): Promise<RuntimeValue> {
    while (true) {
      const test = await this.evalExpression(st.test);
      if (!castToBoolean(test, null)) break;

      try {
        await this.evalBlock(st.body);
      } catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) continue;
        if (e instanceof ReturnSignal) throw e;
        throw e;
      }

      // Optional: honor fps pacing (very light)
      if (this.ctx.fps > 0) {
        const frameMs = Math.floor(1000 / this.ctx.fps);
        if (frameMs > 0) await this.ctx.host.sleep(0);
      }
    }
    return null;
  }

  private async evalDoWhileStatement(st: DoWhileStatement): Promise<RuntimeValue> {
    do {
      try {
        await this.evalBlock(st.body);
      } catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) {
          // continue moves to condition check
        } else if (e instanceof ReturnSignal) {
          throw e;
        } else {
          throw e;
        }
      }
      const test = await this.evalExpression(st.test);
      if (!castToBoolean(test, null)) break;
    } while (true);

    return null;
  }

  private async evalForStatement(st: ForStatement): Promise<RuntimeValue> {
    this.ctx.env.pushScope();
    try {
      if (st.init) await this.evalStatement(st.init as any);

      while (true) {
        if (st.test) {
          const t = await this.evalExpression(st.test);
          if (!castToBoolean(t, null)) break;
        }

        try {
          await this.evalBlock(st.body);
        } catch (e) {
          if (e instanceof BreakSignal) break;
          if (e instanceof ContinueSignal) {
            // fallthrough to update
          } else if (e instanceof ReturnSignal) {
            throw e;
          } else {
            throw e;
          }
        }

        if (st.update) await this.evalExpression(st.update);
      }

      return null;
    } finally {
      this.ctx.env.popScope();
    }
  }

  private async evalForEachStatement(st: ForEachStatement): Promise<RuntimeValue> {
    const iterable = await this.evalExpression(st.iterable);
    const arr = ensureArray(iterable, st.range);

    this.ctx.env.pushScope();
    try {
      for (const item of arr) {
        // forEach (fruit in l.fruits) { ... }
        this.ctx.env.declare("l", st.item.name, item, st.range);

        try {
          await this.evalBlock(st.body);
        } catch (e) {
          if (e instanceof BreakSignal) break;
          if (e instanceof ContinueSignal) continue;
          if (e instanceof ReturnSignal) throw e;
          throw e;
        }

        // reset loop variable each iteration
        this.ctx.env.current().vars.l.delete(st.item.name);
      }
      return null;
    } finally {
      this.ctx.env.popScope();
    }
  }

  private async evalReturnStatement(st: ReturnStatement): Promise<RuntimeValue> {
    const v = st.argument ? await this.evalExpression(st.argument) : null;
    throw new ReturnSignal(v);
  }

  private async evalThrowStatement(st: ThrowStatement): Promise<RuntimeValue> {
    const v = await this.evalExpression(st.argument);
    // If v is a string, throw as runtime error; otherwise wrap.
    const msg = typeof v === "string" ? v : `Thrown value: ${toStringValue(v)}`;
    throw new ForgeRuntimeError("E_RUNTIME", msg, st.range);
  }

  private async evalTryStatement(st: TryStatement): Promise<RuntimeValue> {
    try {
      return await this.evalBlock(st.block);
    } catch (e) {
      // Return/Break/Continue should bubble through try/catch
      if (e instanceof ReturnSignal) throw e;
      if (e instanceof BreakSignal) throw e;
      if (e instanceof ContinueSignal) throw e;

      // catch
      const handler = st.handler as any;
      if (handler && handler._clause === "CatchClause") {
        this.ctx.env.pushScope();
        try {
          if (handler.param) {
            this.ctx.env.declare("l", handler.param.name, String(e), handler.range);
          }
          const out = await this.evalBlock(handler.body);
          // finally
          if (st.finalizer) await this.evalBlock(st.finalizer);
          return out;
        } finally {
          this.ctx.env.popScope();
        }
      }

      // finally
      if (st.finalizer) await this.evalBlock(st.finalizer);

      throw e;
    } finally {
      // If no error, still run finally
      if (st.finalizer) {
        // Note: if try block already executed and succeeded, run finally once here.
        // We must avoid double-running; the above catch path already runs finally.
        // This finally executes only on success (or on signals that didn't hit catch).
        // Implementation: run only if we are not in catch path.
      }
    }
  }

  private async evalFunctionDeclaration(st: FunctionDeclaration): Promise<RuntimeValue> {
    const fn = this.makeUserFunction(st.name.name, st.isAsync, st.params, st.body, st.range);
    // Functions live in let namespace by default (you can change if you want)
    this.ctx.env.declare("l", st.name.name, fn, st.range);
    return null;
  }

  /* =========================================================
     Expressions
     ========================================================= */

  private async evalExpression(expr: Expression): Promise<RuntimeValue> {
    switch (expr.kind) {
      case "Identifier":
        return this.evalIdentifier(expr as Identifier);

      case "NamespacedIdentifier":
        return this.evalNamespacedIdentifier(expr as NamespacedIdentifier);

      case "MemberExpression":
        return this.evalMemberExpression(expr as MemberExpression);

      case "CallExpression":
        return this.evalCallExpression(expr as CallExpression);

      case "UnaryExpression":
        return this.evalUnaryExpression(expr as UnaryExpression);

      case "BinaryExpression":
        return this.evalBinaryExpression(expr as BinaryExpression);

      case "AssignmentExpression":
        return this.evalAssignmentExpression(expr as AssignmentExpression);

      case "BooleanOpExpression":
        return this.evalBooleanOpExpression(expr as BooleanOpExpression);

      case "FunctionExpression":
        return this.evalFunctionExpression(expr as FunctionExpression);

      case "ArrowFunctionExpression":
        return this.evalArrowFunctionExpression(expr as ArrowFunctionExpression);

      case "AwaitExpression":
        return this.evalAwaitExpression(expr as AwaitExpression);

      // Literals
      case "StringLiteral":
      case "NumberLiteral":
      case "BooleanLiteral":
      case "NullLiteral":
      case "DurationLiteral":
      case "ArrayLiteral":
      case "ObjectLiteral":
      case "TemplateString":
        return this.evalLiteral(expr as any);

      default:
        throw new ForgeRuntimeError("E_UNSUPPORTED", `Unsupported expression kind: ${expr.kind}`, expr.range);
    }
  }

  private async evalIdentifier(id: Identifier): Promise<RuntimeValue> {
    // Try Forge variables first (unqualified resolution), then globals.
    try {
      return this.ctx.env.resolveUnqualified(id.name, id.range).value;
    } catch {
      const g = this.ctx.env.getGlobal(id.name);
      if (g !== undefined) return g;
      throw new ForgeRuntimeError("E_NAME", `Unknown identifier '${id.name}'.`, id.range);
    }
  }

  private async evalNamespacedIdentifier(nid: NamespacedIdentifier): Promise<RuntimeValue> {
    return this.ctx.env.get(nid.namespace, nid.name.name, nid.range);
  }

  private async evalMemberExpression(mem: MemberExpression): Promise<RuntimeValue> {
    const objVal = await this.evalExpression(mem.object);

    // Support member access on objects and arrays (numeric keys).
    if (Array.isArray(objVal)) {
      const idx = Number(mem.property.name);
      if (!Number.isInteger(idx)) {
        throw new ForgeRuntimeError("E_TYPE", `Array index must be integer, got '${mem.property.name}'.`, mem.range);
      }
      return objVal[idx] ?? null;
    }

    const obj = ensureObject(objVal, mem.range);
    const key = mem.property.name;

    // special case: builtins stored as functions inside objects
    const v = obj[key];
    if (v === undefined) return null;
    return v;
  }

  private async evalCallExpression(call: CallExpression): Promise<RuntimeValue> {
    const callee = await this.evalExpression(call.callee);

    const { positional, named } = await this.evalCallArguments(call.args);

    // Built-in / user function
    if (isRuntimeFunction(callee)) {
      return callee.call(positional, named, this.ctx);
    }

    // If callee is an object that has "kind:function" keys (rare), reject.
    throw new ForgeRuntimeError("E_TYPE", "Attempted to call a non-function value.", call.range);
  }

  private async evalCallArguments(args: CallArgument[]): Promise<{ positional: RuntimeValue[]; named: Record<string, RuntimeValue> }> {
    const positional: RuntimeValue[] = [];
    const named: Record<string, RuntimeValue> = {};

    for (const arg of args) {
      if (arg.kind === "PositionalArgument") {
        const a = arg as PositionalArgument;
        positional.push(await this.evalExpression(a.value));
      } else {
        const a = arg as NamedArgument;
        named[a.name.name] = await this.evalExpression(a.value);
      }
    }

    return { positional, named };
  }

  private async evalUnaryExpression(expr: UnaryExpression): Promise<RuntimeValue> {
    const v = await this.evalExpression(expr.argument);

    switch (expr.operator) {
      case "!":
        return !castToBoolean(v, null);
      case "+":
        return ensureNumber(v, expr.range);
      case "-":
        return -ensureNumber(v, expr.range);
      default:
        throw new ForgeRuntimeError("E_UNSUPPORTED", `Unsupported unary operator: ${expr.operator}`, expr.range);
    }
  }

  private async evalBinaryExpression(expr: BinaryExpression): Promise<RuntimeValue> {
    const left = await this.evalExpression(expr.left);
    const right = await this.evalExpression(expr.right);

    switch (expr.operator) {
      // comparison
      case "==":
      case "===":
        return deepEquals(left, right);
      case "!=":
      case "!==":
        return !deepEquals(left, right);
      case "<":
        return ensureNumber(left, expr.range) < ensureNumber(right, expr.range);
      case "<=":
        return ensureNumber(left, expr.range) <= ensureNumber(right, expr.range);
      case ">":
        return ensureNumber(left, expr.range) > ensureNumber(right, expr.range);
      case ">=":
        return ensureNumber(left, expr.range) >= ensureNumber(right, expr.range);

      // logical
      case "&&":
        return castToBoolean(left, null) && castToBoolean(right, null);
      case "||":
        return castToBoolean(left, null) || castToBoolean(right, null);

      // arithmetic
      case "+":
        // string concat if either is string
        if (typeof left === "string" || typeof right === "string") return toStringValue(left) + toStringValue(right);
        return ensureNumber(left, expr.range) + ensureNumber(right, expr.range);
      case "-":
        return ensureNumber(left, expr.range) - ensureNumber(right, expr.range);
      case "x":
        return ensureNumber(left, expr.range) * ensureNumber(right, expr.range);
      case "/":
        return ensureNumber(left, expr.range) / ensureNumber(right, expr.range);
      case "%":
        return ensureNumber(left, expr.range) % ensureNumber(right, expr.range);

      // Forge root operator: a § b = n-th root (a^(1/b)), sqrt is b=2
      case "§": {
        const a = ensureNumber(left, expr.range);
        const n = ensureNumber(right, expr.range);
        if (n === 0) throw new ForgeRuntimeError("E_TYPE", "Root index cannot be 0.", expr.range);
        return Math.pow(a, 1 / n);
      }

      default:
        throw new ForgeRuntimeError("E_UNSUPPORTED", `Unsupported binary operator: ${expr.operator}`, expr.range);
    }
  }

  private async evalAssignmentExpression(expr: AssignmentExpression): Promise<RuntimeValue> {
    const value = await this.evalExpression(expr.right);
    return this.assignToTarget(expr.left as any, value, expr.range);
  }

  private async evalBooleanOpExpression(expr: BooleanOpExpression): Promise<RuntimeValue> {
    const subject = await this.evalExpression(expr.subject);

    if (expr.op === "query") {
      // ?isBoolean (check)
      const like = isBooleanLike(subject);
      let ok = like.ok;
      if (expr.force !== null) {
        ok = like.ok && like.value === expr.force;
      }
      if (expr.negate) ok = !ok;
      return ok;
    }

    if (expr.op === "cast") {
      // isBoolean (cast)
      const b = castToBoolean(subject, expr.force);
      return b;
    }

    throw new ForgeRuntimeError("E_UNSUPPORTED", "Unknown boolean op kind.", expr.range);
  }

  private async evalFunctionExpression(expr: FunctionExpression): Promise<RuntimeValue> {
    const name = expr.name ? expr.name.name : null;
    return this.makeUserFunction(name, expr.isAsync, expr.params, expr.body, expr.range);
  }

  private async evalArrowFunctionExpression(expr: ArrowFunctionExpression): Promise<RuntimeValue> {
    // Arrow functions capture like normal functions
    const body = expr.body;
    const fn: RuntimeFunction = {
      kind: "function",
      name: null,
      isAsync: expr.isAsync,
      call: async (args, named, _ctx) => {
        // new scope for call
        this.ctx.env.pushScope();
        try {
          this.bindParams(expr.params, args, named, expr.range);

          if ((body as any).kind === "BlockStatement") {
            try {
              await this.evalBlock(body as BlockStatement);
              return null;
            } catch (e) {
              if (e instanceof ReturnSignal) return e.value;
              throw e;
            }
          } else {
            // expression-bodied arrow
            return await this.evalExpression(body as Expression);
          }
        } finally {
          this.ctx.env.popScope();
        }
      },
    };
    return fn;
  }

  private async evalAwaitExpression(expr: AwaitExpression): Promise<RuntimeValue> {
    const v = await this.evalExpression(expr.argument);
    // In this runtime, calls already await, so AwaitExpression is a no-op unless you later implement Promises.
    // We'll keep it for future async primitives.
    return v;
  }

  private async evalLiteral(lit: Literal): Promise<RuntimeValue> {
    switch (lit.kind) {
      case "StringLiteral":
        return (lit as StringLiteral).value;
      case "NumberLiteral":
        return (lit as NumberLiteral).value;
      case "BooleanLiteral":
        return (lit as BooleanLiteral).value;
      case "NullLiteral":
        return null;
      case "DurationLiteral":
        return this.evalDurationLiteral(lit as DurationLiteral);
      case "ArrayLiteral":
        return this.evalArrayLiteral(lit as ArrayLiteral);
      case "ObjectLiteral":
        return this.evalObjectLiteral(lit as ObjectLiteral);
      case "TemplateString":
        return this.evalTemplateString(lit as TemplateString);
      default:
        return assertNeverNode(lit);
    }
  }

  private evalDurationLiteral(lit: DurationLiteral): RuntimeValue {
    // Represent duration as a string ("0.5s") or as milliseconds number.
    // For Time.wait we accept both; here we keep the raw string to preserve intent.
    return lit.raw;
  }

  private async evalArrayLiteral(lit: ArrayLiteral): Promise<RuntimeValue> {
    const out: RuntimeArray = [];
    for (const e of lit.elements) out.push(await this.evalExpression(e));
    return out;
  }

  private async evalObjectLiteral(lit: ObjectLiteral): Promise<RuntimeValue> {
    const obj: RuntimeObject = {};
    for (const p of lit.properties) {
      obj[p.key.name] = await this.evalExpression(p.value);
    }
    return obj;
  }

  private async evalTemplateString(tpl: TemplateString): Promise<RuntimeValue> {
    let out = "";
    for (const part of tpl.parts) {
      if (part.kind === "TemplateTextPart") {
        out += (part as any as TemplateTextPart).text;
      } else {
        const p = part as any as TemplateExprPart;
        const v = await this.evalExpression(p.expression);
        out += toStringValue(v);
      }
    }
    return out;
  }

  /* =========================================================
     User Functions
     ========================================================= */

  private makeUserFunction(
    name: string | null,
    isAsync: boolean,
    params: any[],
    body: BlockStatement,
    range?: Range
  ): RuntimeFunction {
    const fn: RuntimeFunction = {
      kind: "function",
      name,
      isAsync,
      call: async (args, named, _ctx) => {
        // Function call creates a new scope.
        this.ctx.env.pushScope();
        try {
          this.bindParams(params, args, named, range);

          try {
            await this.evalBlock(body);
            return null;
          } catch (e) {
            if (e instanceof ReturnSignal) return e.value;
            throw e;
          }
        } finally {
          this.ctx.env.popScope();
        }
      },
    };
    return fn;
  }

  private bindParams(params: any[], args: RuntimeValue[], named: Record<string, RuntimeValue>, range?: Range) {
    // params: FunctionParameter[] (see ast.ts)
    // - positional first
    // - then named overrides
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      const pname = p.name.name as string;

      let val: RuntimeValue = null;

      if (pname in named) {
        val = named[pname];
      } else if (i < args.length) {
        val = args[i];
      } else if (p.defaultValue) {
        // default expression evaluated in function scope
        // but we haven't declared it yet; safe to do now:
        val = null;
      }

      this.ctx.env.declare("l", pname, val, range);
    }

    // Evaluate defaults after all params exist (so defaults can reference earlier params)
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      const pname = p.name.name as string;

      const current = this.ctx.env.get("l", pname);
      if (current !== null) continue;

      if (p.defaultValue) {
        // Evaluate default now
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        // (this method isn't async; defaults are used rarely; keep it simple by forbidding async defaults for now)
        const val = this.evalExpression(p.defaultValue as Expression);
        // default evaluation is sync in effect (it returns a Promise). We disallow.
        // So we throw a clean error if defaults are used before we make this async.
        throw new ForgeRuntimeError(
          "E_UNSUPPORTED",
          "Default parameter values are not supported yet in the evaluator (make bindParams async).",
          range
        );
      }
    }
  }
}

/* =========================================================
   Deep equals (simple)
   ========================================================= */

function deepEquals(a: RuntimeValue, b: RuntimeValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;

  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEquals(a[i], b[i])) return false;
    return true;
  }

  if (isRuntimeObject(a) && isRuntimeObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!(k in b)) return false;
      if (!deepEquals(a[k], b[k])) return false;
    }
    return true;
  }

  // functions compare by identity already handled in a===b
  return false;
}
