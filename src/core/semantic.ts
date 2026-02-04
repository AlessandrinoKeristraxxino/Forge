// src/core/semantic.ts
//
// Forge Semantic Analyzer
// ----------------------
// This is the "brain" for editor features (errors, warnings, symbol resolution, basic type checks).
// It does NOT execute code; it analyzes the AST and produces diagnostics + a symbol table.
//
// Goals (MVP for VS Code extension):
// - Undefined variables / unknown identifiers
// - Const reassignment + basic assignment validity
// - Module gating: using Time.* requires able 'Time' (if AllInOne disabled)
// - Basic type inference: string/number/boolean/duration/object/array/function/unknown
// - Member access checks for object literals (best-effort)
// - Function scopes (block scope for let/const, function/global for var)
//
// Notes:
// - Forge has "namespaces" l./v./c. as *variable stores* in your examples.
//   Here we treat them as "stores" with separate symbol tables.
// - This file intentionally uses defensive coding, so the language can evolve without breaking everything.
// - You can expand builtins and module APIs in BUILTIN_APIS below.

import type {
  Program,
  Statement,
  Expression,
  Range,
  Position,
  Identifier,
  NamespacedIdentifier,
  MemberExpression,
  CallExpression,
  VarDeclaration,
  BlockStatement,
  IfStatement,
  WhileStatement,
  DoWhileStatement,
  ForStatement,
  ForEachStatement,
  TryStatement,
  FunctionDeclaration,
  FunctionExpression,
  ArrowFunctionExpression,
  ReturnStatement,
  ThrowStatement,
  AssignmentStatement,
  AssignmentExpression,
  ObjectLiteral,
  ArrayLiteral,
  PropertyKey,
  DisableDirective,
  AbleDirective,
  BooleanOpExpression,
} from "./ast";

/* =========================================================
   Diagnostics
   ========================================================= */

export type DiagnosticSeverity = "error" | "warning" | "info";

export type Diagnostic = {
  severity: DiagnosticSeverity;
  message: string;
  range: Range;
  code?: string; // stable ID for rules
};

export type SemanticOptions = {
  // If true, treat unknown members as warnings rather than errors.
  relaxedMemberAccess?: boolean;

  // If true, allow using module symbols even if AllInOne disabled and module not enabled.
  // (Useful while building language; in production, keep false.)
  ignoreModuleGating?: boolean;
};

export type SemanticResult = {
  diagnostics: Diagnostic[];
  // flattened symbol table view, helpful for completion
  symbols: SymbolIndex;
  // active module context
  modules: ModuleContext;
  // inferred type per node (best-effort)
  types: TypeMap;
};

export function analyzeProgram(program: Program, opts: SemanticOptions = {}): SemanticResult {
  const analyzer = new SemanticAnalyzer(opts);
  analyzer.analyze(program);
  return analyzer.result();
}

/* =========================================================
   Types (best-effort inference)
   ========================================================= */

export type TypeKind =
  | "unknown"
  | "any"
  | "never"
  | "void"
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "duration"
  | "object"
  | "array"
  | "function";

export type ForgeType =
  | { kind: "unknown" }
  | { kind: "any" }
  | { kind: "never" }
  | { kind: "void" }
  | { kind: "null" }
  | { kind: "boolean" }
  | { kind: "number" }
  | { kind: "string" }
  | { kind: "duration" }
  | { kind: "array"; element: ForgeType }
  | { kind: "object"; props: Record<string, ForgeType>; open: boolean }
  | { kind: "function"; params: ForgeType[]; returns: ForgeType; isAsync: boolean };

const T = {
  unknown(): ForgeType {
    return { kind: "unknown" };
  },
  any(): ForgeType {
    return { kind: "any" };
  },
  never(): ForgeType {
    return { kind: "never" };
  },
  void(): ForgeType {
    return { kind: "void" };
  },
  null(): ForgeType {
    return { kind: "null" };
  },
  boolean(): ForgeType {
    return { kind: "boolean" };
  },
  number(): ForgeType {
    return { kind: "number" };
  },
  string(): ForgeType {
    return { kind: "string" };
  },
  duration(): ForgeType {
    return { kind: "duration" };
  },
  array(element: ForgeType): ForgeType {
    return { kind: "array", element };
  },
  object(props: Record<string, ForgeType> = {}, open = true): ForgeType {
    return { kind: "object", props, open };
  },
  func(params: ForgeType[], returns: ForgeType, isAsync = false): ForgeType {
    return { kind: "function", params, returns, isAsync };
  },
};

function isAssignableTo(a: ForgeType, b: ForgeType): boolean {
  // "a" can be assigned to "b" ?
  if (b.kind === "any" || b.kind === "unknown") return true;
  if (a.kind === "any") return true;

  if (a.kind === b.kind) {
    if (a.kind === "array") return isAssignableTo(a.element, (b as any).element);
    if (a.kind === "object") {
      const ob = b as any as { props: Record<string, ForgeType>; open: boolean };
      for (const [k, tv] of Object.entries(ob.props)) {
        const av = (a as any).props?.[k] ?? T.unknown();
        if (!isAssignableTo(av, tv)) return false;
      }
      return true;
    }
    if (a.kind === "function") {
      const fb = b as any as { params: ForgeType[]; returns: ForgeType; isAsync: boolean };
      const fa = a as any as { params: ForgeType[]; returns: ForgeType; isAsync: boolean };
      // contravariant params is complex; keep it simple for MVP:
      if (fa.params.length !== fb.params.length) return false;
      for (let i = 0; i < fa.params.length; i++) {
        if (!isAssignableTo(fa.params[i], fb.params[i])) return false;
      }
      return isAssignableTo(fa.returns, fb.returns);
    }
    return true;
  }

  // number -> duration? no
  // duration -> number? no
  // null -> object? no (unless open design later)
  return false;
}

function unify(a: ForgeType, b: ForgeType): ForgeType {
  if (a.kind === "any" || b.kind === "any") return T.any();
  if (a.kind === "unknown") return b;
  if (b.kind === "unknown") return a;
  if (a.kind === b.kind) {
    if (a.kind === "array") return T.array(unify((a as any).element, (b as any).element));
    if (a.kind === "object") {
      const pa = (a as any).props ?? {};
      const pb = (b as any).props ?? {};
      const out: Record<string, ForgeType> = {};
      const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
      for (const k of keys) out[k] = unify(pa[k] ?? T.unknown(), pb[k] ?? T.unknown());
      return T.object(out, (a as any).open || (b as any).open);
    }
    if (a.kind === "function") {
      const fa = a as any;
      const fb = b as any;
      const n = Math.min(fa.params.length, fb.params.length);
      const params: ForgeType[] = [];
      for (let i = 0; i < n; i++) params.push(unify(fa.params[i], fb.params[i]));
      return T.func(params, unify(fa.returns, fb.returns), fa.isAsync || fb.isAsync);
    }
    return a;
  }

  // Different primitive kinds -> unknown for MVP
  return T.unknown();
}

export type TypeMap = Map<number, ForgeType>; // key: nodeStartOffset (stable enough for editor)

function typeKey(n: any): number {
  return n?.range?.start?.offset ?? -1;
}

/* =========================================================
   Symbol model & scoping
   ========================================================= */

export type Mutability = "const" | "let" | "var";

export type SymbolInfo = {
  name: string;
  declaredAt: Range;
  mutability: Mutability;
  type: ForgeType;
  // store: global | function | block | namespaced store
  store: "global" | "function" | "block" | "l" | "v" | "c";
};

class Scope {
  public readonly kind: "global" | "function" | "block";
  private readonly parent: Scope | null;
  private readonly symbols = new Map<string, SymbolInfo>();

  constructor(kind: "global" | "function" | "block", parent: Scope | null) {
    this.kind = kind;
    this.parent = parent;
  }

  define(sym: SymbolInfo): boolean {
    if (this.symbols.has(sym.name)) return false;
    this.symbols.set(sym.name, sym);
    return true;
  }

  getLocal(name: string): SymbolInfo | null {
    return this.symbols.get(name) ?? null;
  }

  resolve(name: string): SymbolInfo | null {
    const local = this.getLocal(name);
    if (local) return local;
    return this.parent?.resolve(name) ?? null;
  }

  allLocal(): SymbolInfo[] {
    return [...this.symbols.values()];
  }
}

export type SymbolIndex = {
  global: Record<string, SymbolInfo>;
  l: Record<string, SymbolInfo>;
  v: Record<string, SymbolInfo>;
  c: Record<string, SymbolInfo>;
};

/* =========================================================
   Module gating (disable / able)
   ========================================================= */

export type ModuleName =
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

export type ModuleContext = {
  allInOneEnabled: boolean;
  enabled: Set<ModuleName>;
};

function defaultModules(): ModuleContext {
  // Default assumption: AllInOne is enabled unless explicitly disabled.
  return {
    allInOneEnabled: true,
    enabled: new Set<ModuleName>(["AllInOne"]),
  };
}

/* =========================================================
   Builtin APIs (expand whenever you want)
   ========================================================= */

type BuiltinFn = {
  name: string;
  params: ForgeType[];
  returns: ForgeType;
  module?: ModuleName; // required module if AllInOne disabled
};

type BuiltinValue = {
  name: string;
  type: ForgeType;
  module?: ModuleName;
};

type BuiltinNamespace = {
  name: string;
  members: Record<string, BuiltinNamespace | BuiltinFn | BuiltinValue>;
  module?: ModuleName;
};

function fn(name: string, params: ForgeType[], returns: ForgeType, module?: ModuleName): BuiltinFn {
  return { name, params, returns, module };
}

function val(name: string, type: ForgeType, module?: ModuleName): BuiltinValue {
  return { name, type, module };
}

// A minimal-but-useful built-in surface to power diagnostics/completions.
const BUILTIN_APIS: BuiltinNamespace = {
  name: "<root>",
  members: {
    console: {
      name: "console",
      members: {
        text: {
          name: "text",
          members: {
            var: fn("console.text.var", [T.any()], T.void()),
          },
        },
      },
    },

    inp: {
      name: "inp",
      members: {
        // inp("prompt") -> string
        // inp(Hello >> ) -> string (bare template, still string)
        __call__: fn("inp", [T.string()], T.string()),
        var: fn("inp.var", [T.string()], T.string()),
      },
    },

    // Modules (namespaces)
    Time: {
      name: "Time",
      module: "Time",
      members: {
        wait: fn("Time.wait", [T.duration()], T.void(), "Time"),
        set: {
          name: "set",
          module: "Time",
          members: {
            fps: fn("Time.set.fps", [T.number()], T.void(), "Time"),
          },
        },
      },
    },

    Sys: {
      name: "Sys",
      module: "Sys",
      members: {
        exec: fn("Sys.exec", [T.string()], T.string(), "Sys"),
        process: {
          name: "process",
          module: "Sys",
          members: {
            id: val("Sys.process.id", T.number(), "Sys"),
            kill: fn("Sys.process.kill", [T.number()], T.void(), "Sys"),
          },
        },
        cpu: {
          name: "cpu",
          module: "Sys",
          members: {
            cores: val("Sys.cpu.cores", T.number(), "Sys"),
            usage: val("Sys.cpu.usage", T.number(), "Sys"),
            model: val("Sys.cpu.model", T.string(), "Sys"),
          },
        },
        os: {
          name: "os",
          module: "Sys",
          members: {
            name: val("Sys.os.name", T.string(), "Sys"),
            version: val("Sys.os.version", T.string(), "Sys"),
            arch: val("Sys.os.arch", T.string(), "Sys"),
          },
        },
        chek: {
          name: "chek",
          module: "Sys",
          members: {
            ram: {
              name: "ram",
              module: "Sys",
              members: {
                GB: val("Sys.chek.ram.GB", T.number(), "Sys"),
                comp: val("Sys.chek.ram.comp", T.string(), "Sys"),
              },
            },
            comp: fn("Sys.chek.comp", [T.string()], T.string(), "Sys"),
          },
        },
      },
    },

    Math: {
      name: "Math",
      module: "Math",
      members: {
        pow: fn("Math.pow", [T.number(), T.number()], T.number(), "Math"),
        log: fn("Math.log", [T.number()], T.number(), "Math"),
        log10: fn("Math.log10", [T.number()], T.number(), "Math"),
        sin: fn("Math.sin", [T.number()], T.number(), "Math"),
        cos: fn("Math.cos", [T.number()], T.number(), "Math"),
        tan: fn("Math.tan", [T.number()], T.number(), "Math"),
        round: fn("Math.round", [T.number()], T.number(), "Math"),
        floor: fn("Math.floor", [T.number()], T.number(), "Math"),
        ceil: fn("Math.ceil", [T.number()], T.number(), "Math"),
        abs: fn("Math.abs", [T.number()], T.number(), "Math"),
        min: fn("Math.min", [T.array(T.number())], T.number(), "Math"),
        max: fn("Math.max", [T.array(T.number())], T.number(), "Math"),
        avg: fn("Math.avg", [T.array(T.number())], T.number(), "Math"),
        sum: fn("Math.sum", [T.array(T.number())], T.number(), "Math"),
        factorial: fn("Math.factorial", [T.number()], T.number(), "Math"),
        PI: val("Math.PI", T.number(), "Math"),
        E: val("Math.E", T.number(), "Math"),
      },
    },

    File: {
      name: "File",
      module: "File",
      members: {
        read: fn("File.read", [T.string()], T.string(), "File"),
        write: fn("File.write", [T.string(), T.string()], T.void(), "File"),
        append: fn("File.append", [T.string(), T.string()], T.void(), "File"),
        delete: fn("File.delete", [T.string()], T.void(), "File"),
        exists: fn("File.exists", [T.string()], T.boolean(), "File"),
        info: fn("File.info", [T.string()], T.object({ size: T.number(), created: T.string(), modified: T.string() }, true), "File"),
        copy: fn("File.copy", [T.string(), T.string()], T.void(), "File"),
        move: fn("File.move", [T.string(), T.string()], T.void(), "File"),
        dir: {
          name: "dir",
          module: "File",
          members: {
            create: fn("File.dir.create", [T.string()], T.void(), "File"),
            list: fn("File.dir.list", [T.string()], T.array(T.string()), "File"),
          },
        },
        readJson: fn("File.read.json", [T.string()], T.any(), "File"),
        writeJson: fn("File.write.json", [T.string(), T.any()], T.void(), "File"),
        readCsv: fn("File.read.csv", [T.string()], T.array(T.array(T.string())), "File"),
      },
    },

    Net: {
      name: "Net",
      module: "Net",
      members: {
        get: fn("Net.get", [T.string(), T.any()], T.object({ body: T.any() }, true), "Net"),
        post: fn("Net.post", [T.string(), T.any()], T.object({ body: T.any() }, true), "Net"),
        download: fn("Net.download", [T.string(), T.string()], T.void(), "Net"),
        isOnline: val("Net.isOnline", T.boolean(), "Net"),
        ping: fn("Net.ping", [T.string()], T.object({ latency: T.number() }, true), "Net"),
      },
    },

    Crypto: {
      name: "Crypto",
      module: "Crypto",
      members: {
        hash: {
          name: "hash",
          module: "Crypto",
          members: {
            md5: fn("Crypto.hash.md5", [T.string()], T.string(), "Crypto"),
            sha256: fn("Crypto.hash.sha256", [T.string()], T.string(), "Crypto"),
          },
        },
        base64: {
          name: "base64",
          module: "Crypto",
          members: {
            encode: fn("Crypto.base64.encode", [T.string()], T.string(), "Crypto"),
            decode: fn("Crypto.base64.decode", [T.string()], T.string(), "Crypto"),
          },
        },
        aes: {
          name: "aes",
          module: "Crypto",
          members: {
            encrypt: fn("Crypto.aes.encrypt", [T.string(), T.string()], T.string(), "Crypto"),
            decrypt: fn("Crypto.aes.decrypt", [T.string(), T.string()], T.string(), "Crypto"),
          },
        },
        generate: {
          name: "generate",
          module: "Crypto",
          members: {
            key: fn("Crypto.generate.key", [T.number()], T.string(), "Crypto"),
            uuid: val("Crypto.generate.uuid", T.string(), "Crypto"),
          },
        },
        random: fn("Crypto.random", [T.number(), T.number()], T.number(), "Crypto"),
      },
    },

    DateTime: {
      name: "DateTime",
      module: "DateTime",
      members: {
        now: val("DateTime.now", T.string(), "DateTime"),
        format: fn("DateTime.format", [T.any(), T.string()], T.string(), "DateTime"),
        create: fn("DateTime.create", [T.number(), T.number(), T.number()], T.string(), "DateTime"),
        add: fn("DateTime.add", [T.any(), T.number(), T.string()], T.any(), "DateTime"),
        subtract: fn("DateTime.subtract", [T.any(), T.number(), T.string()], T.any(), "DateTime"),
        diff: fn("DateTime.diff", [T.any(), T.any(), T.string()], T.number(), "DateTime"),
        timestamp: val("DateTime.timestamp", T.number(), "DateTime"),
        fromTimestamp: fn("DateTime.fromTimestamp", [T.number()], T.any(), "DateTime"),
      },
    },

    Regex: {
      name: "Regex",
      module: "Regex",
      members: {
        match: fn("Regex.match", [T.string(), T.string()], T.boolean(), "Regex"),
        extract: fn("Regex.extract", [T.string(), T.string()], T.array(T.string()), "Regex"),
        replace: fn("Regex.replace", [T.string(), T.string(), T.string()], T.string(), "Regex"),
      },
    },

    JSON: {
      name: "JSON",
      module: "JSON",
      members: {
        parse: fn("JSON.parse", [T.string()], T.any(), "JSON"),
        stringify: fn("JSON.stringify", [T.any(), T.any()], T.string(), "JSON"),
      },
    },

    Terminal: {
      name: "Terminal",
      module: "Terminal",
      members: {
        progress: {
          name: "progress",
          module: "Terminal",
          members: {
            bar: fn("Terminal.progress.bar", [T.number(), T.any()], T.void(), "Terminal"),
          },
        },
        spinner: {
          name: "spinner",
          module: "Terminal",
          members: {
            custom: fn("Terminal.spinner.custom", [T.array(T.string())], T.void(), "Terminal"),
          },
        },
        table: {
          name: "table",
          module: "Terminal",
          members: {
            styled: fn("Terminal.table.styled", [T.array(T.array(T.string())), T.any()], T.void(), "Terminal"),
          },
        },
        banner: fn("Terminal.banner", [T.string(), T.any()], T.void(), "Terminal"),
        tree: fn("Terminal.tree", [T.any()], T.void(), "Terminal"),
        form: fn("Terminal.form", [T.array(T.any())], T.any(), "Terminal"),
      },
    },
  },
};

/* =========================================================
   Semantic Analyzer
   ========================================================= */

class SemanticAnalyzer {
  private readonly opts: Required<SemanticOptions>;
  private readonly diags: Diagnostic[] = [];
  private readonly types: TypeMap = new Map();

  // Normal lexical scopes (un-namespaced)
  private globalScope = new Scope("global", null);
  private scope: Scope = this.globalScope;

  // Namespaced stores (l/v/c)
  private storeL = new Map<string, SymbolInfo>();
  private storeV = new Map<string, SymbolInfo>();
  private storeC = new Map<string, SymbolInfo>();

  // directives
  private modules: ModuleContext = defaultModules();

  // builtin shadowing rules
  private readonly reserved = new Set(["l", "v", "c"]);

  constructor(opts: SemanticOptions) {
    this.opts = {
      relaxedMemberAccess: opts.relaxedMemberAccess ?? true,
      ignoreModuleGating: opts.ignoreModuleGating ?? false,
    };

    // Predefine known global names that behave like builtins.
    // This reduces noise in diagnostics.
    this.defineBuiltinGlobals();
  }

  public result(): SemanticResult {
    return {
      diagnostics: this.diags,
      symbols: this.makeIndex(),
      modules: this.modules,
      types: this.types,
    };
  }

  public analyze(program: Program): void {
    // First pass: apply directives at top-level in order (Forge style).
    for (const st of program.body ?? []) {
      if (st?.kind === "DisableDirective") this.applyDisable(st as any);
      if (st?.kind === "AbleDirective") this.applyAble(st as any);
    }

    // Second pass: full analysis
    this.visitProgram(program);
  }

  /* =========================================================
     Directives
     ========================================================= */

  private applyDisable(node: DisableDirective): void {
    const target = this.readStringValue((node as any).target);
    if (!target) return;

    if (target === "AllInOne") {
      this.modules.allInOneEnabled = false;
      this.modules.enabled.delete("AllInOne");
    }
  }

  private applyAble(node: AbleDirective): void {
    const mods = (node as any).modules ?? [];
    for (const s of mods) {
      const name = this.readStringValue(s);
      if (!name) continue;
      this.modules.enabled.add(name as ModuleName);
    }
  }

  /* =========================================================
     Builtins
     ========================================================= */

  private defineBuiltinGlobals(): void {
    // Let builtins exist as global symbols of type any/function-ish.
    // We still check module gating based on namespace root in call/member resolution.
    const builtinNames = Object.keys(BUILTIN_APIS.members);
    for (const n of builtinNames) {
      this.globalScope.define({
        name: n,
        declaredAt: fakeRange0(),
        mutability: "const",
        type: T.any(),
        store: "global",
      });
    }

    // Also define True/False if your grammar treats them as identifiers sometimes.
    this.globalScope.define({
      name: "True",
      declaredAt: fakeRange0(),
      mutability: "const",
      type: T.boolean(),
      store: "global",
    });
    this.globalScope.define({
      name: "False",
      declaredAt: fakeRange0(),
      mutability: "const",
      type: T.boolean(),
      store: "global",
    });
  }

  /* =========================================================
     Program / Statements
     ========================================================= */

  private visitProgram(node: Program): void {
    for (const st of node.body ?? []) this.visitStatement(st);
  }

  private visitStatement(node: Statement): void {
    if (!node) return;

    switch (node.kind) {
      case "DisableDirective":
        // already applied; keep for completeness
        this.applyDisable(node as any);
        return;

      case "AbleDirective":
        this.applyAble(node as any);
        return;

      case "VarDeclaration":
        this.visitVarDeclaration(node as any);
        return;

      case "AssignmentStatement":
        this.visitAssignmentStatement(node as any);
        return;

      case "ExpressionStatement":
        this.visitExpression((node as any).expression);
        return;

      case "BlockStatement":
        this.withBlockScope(() => this.visitBlock(node as any));
        return;

      case "IfStatement":
        this.visitIf(node as any);
        return;

      case "WhileStatement":
        this.visitWhile(node as any);
        return;

      case "DoWhileStatement":
        this.visitDoWhile(node as any);
        return;

      case "ForStatement":
        this.visitFor(node as any);
        return;

      case "ForEachStatement":
        this.visitForEach(node as any);
        return;

      case "TryStatement":
        this.visitTry(node as any);
        return;

      case "FunctionDeclaration":
        this.visitFunctionDeclaration(node as any);
        return;

      case "ReturnStatement":
        this.visitReturn(node as any);
        return;

      case "ThrowStatement":
        this.visitThrow(node as any);
        return;

      case "BreakStatement":
      case "ContinueStatement":
        return;

      default:
        // Unknown statement node kinds shouldn’t crash analysis
        this.warn((node as any).range ?? fakeRange0(), `Unknown statement kind '${(node as any).kind}'.`, "SEM_UNKNOWN_STMT");
        return;
    }
  }

  private visitBlock(node: BlockStatement): void {
    for (const st of node.body ?? []) this.visitStatement(st);
  }

  private visitVarDeclaration(node: VarDeclaration): void {
    const declKind = (node as any).declKind as "let" | "var" | "const";
    const name = (node as any).name?.name ?? (node as any).name?.value ?? "";
    const r = node.range ?? (node as any).name?.range ?? fakeRange0();

    if (!name) {
      this.error(r, "Missing variable name.", "SEM_VAR_NO_NAME");
      return;
    }

    if (this.reserved.has(name)) {
      this.warn(r, `Avoid naming a variable '${name}' because it's a namespace store prefix.`, "SEM_VAR_RESERVED");
    }

    // infer initializer type
    let initType = T.unknown();
    if ((node as any).initializer) initType = this.visitExpression((node as any).initializer);

    const sym: SymbolInfo = {
      name,
      declaredAt: (node as any).name?.range ?? r,
      mutability: declKind,
      type: initType,
      store: this.scope.kind,
    };

    // Forge store mapping:
    // - let   -> l.
    // - var   -> v.
    // - const -> c.
    const ns = declKind === "let" ? "l" : declKind === "var" ? "v" : "c";
    const existingInStore = this.resolveStore(ns, name);
    if (existingInStore) {
      this.error(sym.declaredAt, `Variable '${ns}.${name}' is already declared.`, "SEM_REDECL");
      return;
    }
    this.defineStore(ns, name, declKind, sym.declaredAt, initType);

    // var is function-scoped: define in nearest function/global
    if (declKind === "var") {
      const targetScope = this.findFunctionOrGlobalScope();
      const ok = targetScope.define(sym);
      if (!ok) this.error(sym.declaredAt, `Variable '${name}' is already declared in this scope.`, "SEM_REDECL");
      return;
    }

    const ok = this.scope.define(sym);
    if (!ok) this.error(sym.declaredAt, `Variable '${name}' is already declared in this scope.`, "SEM_REDECL");
  }

  private visitAssignmentStatement(node: AssignmentStatement): void {
    const target = (node as any).target;
    const value = (node as any).value;

    const tType = this.resolveAssignableType(target, /*write*/ true);
    const vType = this.visitExpression(value);

    // const reassignment check
    this.checkConstReassignment(target);

    // type check (best-effort)
    if (tType && !isAssignableTo(vType, tType)) {
      this.warn(
        node.range,
        `Type mismatch: cannot assign ${fmtType(vType)} to ${fmtType(tType)}.`,
        "SEM_TYPE_ASSIGN"
      );
    }

    this.setType(node, T.void());
  }

  private visitIf(node: IfStatement): void {
    const test = (node as any).test;
    const cons = (node as any).consequent;
    const elifs = (node as any).elifClauses ?? [];
    const alt = (node as any).alternate;

    const t = this.visitExpression(test);
    if (t.kind !== "boolean" && t.kind !== "unknown" && t.kind !== "any") {
      this.warn(test.range, `Condition should be boolean, got ${fmtType(t)}.`, "SEM_COND_BOOL");
    }

    this.withBlockScope(() => this.visitStatement(cons));
    for (const e of elifs) {
      const et = this.visitExpression((e as any).test);
      if (et.kind !== "boolean" && et.kind !== "unknown" && et.kind !== "any") {
        this.warn((e as any).test.range, `Condition should be boolean, got ${fmtType(et)}.`, "SEM_COND_BOOL");
      }
      this.withBlockScope(() => this.visitStatement((e as any).consequent));
    }

    if (alt) this.withBlockScope(() => this.visitStatement(alt));
  }

  private visitWhile(node: WhileStatement): void {
    const test = (node as any).test;
    const body = (node as any).body;
    const t = this.visitExpression(test);
    if (t.kind !== "boolean" && t.kind !== "unknown" && t.kind !== "any") {
      this.warn(test.range, `Condition should be boolean, got ${fmtType(t)}.`, "SEM_COND_BOOL");
    }
    this.withBlockScope(() => this.visitStatement(body));
  }

  private visitDoWhile(node: DoWhileStatement): void {
    const body = (node as any).body;
    const test = (node as any).test;
    this.withBlockScope(() => this.visitStatement(body));
    const t = this.visitExpression(test);
    if (t.kind !== "boolean" && t.kind !== "unknown" && t.kind !== "any") {
      this.warn(test.range, `Condition should be boolean, got ${fmtType(t)}.`, "SEM_COND_BOOL");
    }
  }

  private visitFor(node: ForStatement): void {
    this.withBlockScope(() => {
      const init = (node as any).init;
      const test = (node as any).test;
      const update = (node as any).update;
      const body = (node as any).body;

      if (init) this.visitStatement(init);
      if (test) {
        const t = this.visitExpression(test);
        if (t.kind !== "boolean" && t.kind !== "unknown" && t.kind !== "any") {
          this.warn(test.range, `For-test should be boolean, got ${fmtType(t)}.`, "SEM_COND_BOOL");
        }
      }
      if (update) this.visitExpression(update);

      this.withBlockScope(() => this.visitStatement(body));
    });
  }

  private visitForEach(node: ForEachStatement): void {
    this.withBlockScope(() => {
      const item = (node as any).item;
      const iterable = (node as any).iterable;
      const body = (node as any).body;

      // item declared as let by default (block scoped)
      const name = item?.name ?? "";
      if (name) {
        const sym: SymbolInfo = {
          name,
          declaredAt: item.range ?? node.range,
          mutability: "let",
          type: T.unknown(),
          store: "block",
        };
        const ok = this.scope.define(sym);
        if (!ok) this.error(sym.declaredAt, `Loop variable '${name}' is already declared in this scope.`, "SEM_REDECL");
      }

      const itType = this.visitExpression(iterable);
      if (itType.kind !== "array" && itType.kind !== "unknown" && itType.kind !== "any") {
        this.warn(iterable.range, `forEach expects an array-like iterable, got ${fmtType(itType)}.`, "SEM_FOREACH_IT");
      }

      this.withBlockScope(() => this.visitStatement(body));
    });
  }

  private visitTry(node: TryStatement): void {
    const block = (node as any).block;
    const handler = (node as any).handler;
    const finalizer = (node as any).finalizer;

    this.withBlockScope(() => this.visitStatement(block));

    if (handler) {
      this.withBlockScope(() => {
        const param = (handler as any).param;
        if (param?.name) {
          const ok = this.scope.define({
            name: param.name,
            declaredAt: param.range ?? handler.range,
            mutability: "let",
            type: T.any(), // error object
            store: "block",
          });
          if (!ok) this.error(param.range, `Catch parameter '${param.name}' is already declared.`, "SEM_REDECL");
        }
        this.visitStatement((handler as any).body);
      });
    }

    if (finalizer) this.withBlockScope(() => this.visitStatement(finalizer));
  }

  private visitFunctionDeclaration(node: FunctionDeclaration): void {
    // Define function symbol in current scope
    const name = (node as any).name?.name ?? "";
    if (name) {
      const fnType = T.func(
        ((node as any).params ?? []).map(() => T.unknown()),
        T.unknown(),
        !!(node as any).isAsync
      );
      const ok = this.scope.define({
        name,
        declaredAt: (node as any).name?.range ?? node.range,
        mutability: "const",
        type: fnType,
        store: this.scope.kind,
      });
      if (!ok) this.error((node as any).name?.range ?? node.range, `Function '${name}' is already declared.`, "SEM_REDECL");
    }

    // Analyze body in function scope
    this.withFunctionScope(() => {
      this.defineParams((node as any).params ?? []);
      this.visitStatement((node as any).body);

      // TODO: collect return types -> set fn returns
    });
  }

  private visitReturn(node: ReturnStatement): void {
    if ((node as any).argument) this.visitExpression((node as any).argument);
  }

  private visitThrow(node: ThrowStatement): void {
    if ((node as any).argument) this.visitExpression((node as any).argument);
  }

  /* =========================================================
     Expressions
   ========================================================= */

  private visitExpression(node: Expression): ForgeType {
    if (!node) return T.unknown();

    switch ((node as any).kind) {
      case "Identifier":
        return this.visitIdentifier(node as any);

      case "NamespacedIdentifier":
        return this.visitNamespacedIdentifier(node as any);

      case "MemberExpression":
        return this.visitMemberExpression(node as any);

      case "CallExpression":
        return this.visitCallExpression(node as any);

      case "AssignmentExpression":
        return this.visitAssignmentExpression(node as any);

      case "UnaryExpression":
        return this.visitUnaryExpression(node as any);

      case "BinaryExpression":
        return this.visitBinaryExpression(node as any);

      case "BooleanOpExpression":
        return this.visitBooleanOp(node as any);

      case "AwaitExpression":
        return this.visitAwait(node as any);

      case "NumberLiteral":
        this.setType(node, T.number());
        return T.number();

      case "StringLiteral":
        this.setType(node, T.string());
        return T.string();

      case "BooleanLiteral":
        this.setType(node, T.boolean());
        return T.boolean();

      case "NullLiteral":
        this.setType(node, T.null());
        return T.null();

      case "DurationLiteral":
        this.setType(node, T.duration());
        return T.duration();

      case "ObjectLiteral":
        return this.visitObjectLiteral(node as any);

      case "ArrayLiteral":
        return this.visitArrayLiteral(node as any);

      case "FunctionExpression":
        return this.visitFunctionExpression(node as any);

      case "ArrowFunctionExpression":
        return this.visitArrowFunction(node as any);

      case "TemplateString":
        // template string result is string
        // still visit embedded expressions
        for (const part of (node as any).parts ?? []) {
          if (part?.kind === "TemplateExprPart") this.visitExpression(part.expression);
        }
        this.setType(node, T.string());
        return T.string();

      default:
        this.warn(node.range, `Unknown expression kind '${(node as any).kind}'.`, "SEM_UNKNOWN_EXPR");
        this.setType(node, T.unknown());
        return T.unknown();
    }
  }

  private visitIdentifier(node: Identifier): ForgeType {
    const name = (node as any).name ?? "";
    const sym = this.scope.resolve(name);

    if (!sym) {
      // Could still be builtin (already declared), but if not:
      this.error(node.range, `Undefined identifier '${name}'.`, "SEM_UNDEF");
      this.setType(node, T.unknown());
      return T.unknown();
    }

    this.setType(node, sym.type);
    return sym.type;
  }

  private visitNamespacedIdentifier(node: NamespacedIdentifier): ForgeType {
    const ns = (node as any).namespace as "l" | "v" | "c";
    const name = (node as any).name?.name ?? (node as any).name?.value ?? "";

    if (!name) {
      this.error(node.range, "Missing namespaced identifier name.", "SEM_NS_NO_NAME");
      this.setType(node, T.unknown());
      return T.unknown();
    }

    const sym = this.resolveStore(ns, name);
    if (!sym) {
      this.error(node.range, `Undefined ${ns}. variable '${name}'.`, "SEM_UNDEF_NS");
      this.setType(node, T.unknown());
      return T.unknown();
    }

    this.setType(node, sym.type);
    return sym.type;
  }

  private visitMemberExpression(node: MemberExpression): ForgeType {
    const objT = this.visitExpression((node as any).object);
    const prop = (node as any).property as PropertyKey;
    const key = prop?.name ?? "";

    // Gate modules if member chain begins with module root (Time, Sys, ...)
    this.checkModuleGatingForMember(node);

    if (objT.kind === "object") {
      const hit = objT.props[key];
      if (hit) {
        this.setType(node, hit);
        return hit;
      }

      if (!objT.open) {
        if (!this.opts.relaxedMemberAccess) {
          this.error(node.range, `Property '${key}' does not exist on this object.`, "SEM_NO_PROP");
        } else {
          this.warn(node.range, `Unknown property '${key}' on object.`, "SEM_NO_PROP");
        }
        this.setType(node, T.unknown());
        return T.unknown();
      }

      // open object: unknown member type
      this.setType(node, T.unknown());
      return T.unknown();
    }

    // Unknown / any
    if (objT.kind === "any" || objT.kind === "unknown") {
      this.setType(node, T.unknown());
      return T.unknown();
    }

    // Member on non-object
    if (!this.opts.relaxedMemberAccess) {
      this.error(node.range, `Cannot access property '${key}' on ${fmtType(objT)}.`, "SEM_MEMBER_PRIM");
    } else {
      this.warn(node.range, `Property access on ${fmtType(objT)} is probably invalid.`, "SEM_MEMBER_PRIM");
    }

    this.setType(node, T.unknown());
    return T.unknown();
  }

  private visitCallExpression(node: CallExpression): ForgeType {
    // Analyze callee and args
    const callee = (node as any).callee as Expression;
    const args = (node as any).args ?? [];

    // Special-case: inp(...) behaves like a function even if modeled as namespace
    // We still do resolution through builtin API map.
    const callSig = this.resolveCallSignature(callee);

    // Visit args, and validate types if we have signature
    const argTypes: ForgeType[] = [];
    for (const a of args) {
      const v = a?.kind === "NamedArgument" ? a.value : a?.value;
      argTypes.push(this.visitExpression(v));
    }

    // Module gating check (based on root of callee chain)
    this.checkModuleGatingForCall(node);

    if (callSig) {
      // check arity loosely (named args makes this tricky; keep simple)
      // Validate positional args only
      const expected = callSig.params ?? [];
      const count = Math.min(expected.length, argTypes.length);

      for (let i = 0; i < count; i++) {
        if (!isAssignableTo(argTypes[i], expected[i])) {
          this.warn(
            args[i]?.range ?? node.range,
            `Argument ${i + 1} expects ${fmtType(expected[i])}, got ${fmtType(argTypes[i])}.`,
            "SEM_ARG_TYPE"
          );
        }
      }

      this.setType(node, callSig.returns);
      return callSig.returns;
    }

    // If we can infer callee type as function, use it
    const calleeT = this.visitExpression(callee);
    if (calleeT.kind === "function") {
      const ret = (calleeT as any).returns ?? T.unknown();
      this.setType(node, ret);
      return ret;
    }

    // Unknown call
    this.setType(node, T.unknown());
    return T.unknown();
  }

  private visitAssignmentExpression(node: AssignmentExpression): ForgeType {
    const left = (node as any).left;
    const right = (node as any).right;

    const lt = this.resolveAssignableType(left, /*write*/ true);
    const rt = this.visitExpression(right);

    this.checkConstReassignment(left);

    if (lt && !isAssignableTo(rt, lt)) {
      this.warn(node.range, `Type mismatch: cannot assign ${fmtType(rt)} to ${fmtType(lt)}.`, "SEM_TYPE_ASSIGN");
    }

    this.setType(node, rt);
    return rt;
  }

  private visitUnaryExpression(node: any): ForgeType {
    const op = node.operator;
    const argT = this.visitExpression(node.argument);

    if (op === "!") {
      this.setType(node, T.boolean());
      return T.boolean();
    }

    if (op === "+" || op === "-") {
      if (argT.kind !== "number" && argT.kind !== "unknown" && argT.kind !== "any") {
        this.warn(node.range, `Unary '${op}' expects number, got ${fmtType(argT)}.`, "SEM_UNARY_NUM");
      }
      this.setType(node, T.number());
      return T.number();
    }

    this.setType(node, T.unknown());
    return T.unknown();
  }

  private visitBinaryExpression(node: any): ForgeType {
    const op = node.operator as string;
    const l = this.visitExpression(node.left);
    const r = this.visitExpression(node.right);

    // Boolean operators
    if (op === "&&" || op === "||") {
      this.setType(node, T.boolean());
      return T.boolean();
    }

    // Comparisons
    if (op === "==" || op === "!=" || op === "===" || op === "!==" || op === "<" || op === "<=" || op === ">" || op === ">=") {
      this.setType(node, T.boolean());
      return T.boolean();
    }

    // Arithmetic
    if (op === "+" || op === "-" || op === "x" || op === "/" || op === "%" || op === "§") {
      // string concatenation for '+'
      if (op === "+" && (l.kind === "string" || r.kind === "string")) {
        this.setType(node, T.string());
        return T.string();
      }

      // duration rules (MVP): duration +/- duration => duration, duration +/- number => duration
      if (l.kind === "duration" || r.kind === "duration") {
        if (op === "+" || op === "-") {
          // duration +/- duration -> duration
          // duration +/- number -> duration
          if (
            (l.kind === "duration" && (r.kind === "duration" || r.kind === "number" || r.kind === "unknown" || r.kind === "any")) ||
            (r.kind === "duration" && (l.kind === "duration" || l.kind === "number" || l.kind === "unknown" || l.kind === "any"))
          ) {
            this.setType(node, T.duration());
            return T.duration();
          }
        }
        // other ops with duration are suspicious
        this.warn(node.range, `Operator '${op}' on duration is not supported (yet).`, "SEM_DUR_OP");
        this.setType(node, T.unknown());
        return T.unknown();
      }

      // numeric
      if (
        (l.kind !== "number" && l.kind !== "unknown" && l.kind !== "any") ||
        (r.kind !== "number" && r.kind !== "unknown" && r.kind !== "any")
      ) {
        this.warn(node.range, `Operator '${op}' expects numbers, got ${fmtType(l)} and ${fmtType(r)}.`, "SEM_BIN_NUM");
      }

      this.setType(node, T.number());
      return T.number();
    }

    this.setType(node, T.unknown());
    return T.unknown();
  }

  private visitBooleanOp(node: BooleanOpExpression): ForgeType {
    // subject already visited by parser for postfix; still analyze
    const subT = this.visitExpression((node as any).subject);
    // query/cast => boolean
    void subT;
    this.setType(node, T.boolean());
    return T.boolean();
  }

  private visitAwait(node: any): ForgeType {
    const argT = this.visitExpression(node.argument);
    // If function returns promise-like, unwrap later. For MVP: return unknown/any passthrough.
    this.setType(node, argT.kind === "function" ? (argT as any).returns ?? T.unknown() : T.unknown());
    return T.unknown();
  }

  private visitObjectLiteral(node: ObjectLiteral): ForgeType {
    const props: Record<string, ForgeType> = {};
    const list = (node as any).properties ?? [];

    for (const p of list) {
      const k = p?.key?.name ?? "";
      const v = p?.value;
      const t = v ? this.visitExpression(v) : T.unknown();
      if (k) props[k] = t;
    }

    const objT = T.object(props, true);
    this.setType(node, objT);
    return objT;
  }

  private visitArrayLiteral(node: ArrayLiteral): ForgeType {
    const elts = (node as any).elements ?? [];
    let elementT = T.unknown();
    for (const e of elts) {
      const t = this.visitExpression(e);
      elementT = unify(elementT, t);
    }
    const arrT = T.array(elementT);
    this.setType(node, arrT);
    return arrT;
  }

  private visitFunctionExpression(node: FunctionExpression): ForgeType {
    const params = ((node as any).params ?? []).map(() => T.unknown());
    const isAsync = !!(node as any).isAsync;

    // Analyze body in function scope (but don't leak symbols)
    this.withFunctionScope(() => {
      this.defineParams((node as any).params ?? []);
      this.visitStatement((node as any).body);
    });

    const fnT = T.func(params, T.unknown(), isAsync);
    this.setType(node, fnT);
    return fnT;
  }

  private visitArrowFunction(node: ArrowFunctionExpression): ForgeType {
    const params = ((node as any).params ?? []).map(() => T.unknown());
    const isAsync = !!(node as any).isAsync;

    this.withFunctionScope(() => {
      this.defineParams((node as any).params ?? []);
      const body = (node as any).body;
      if (body?.kind === "BlockStatement") this.visitStatement(body);
      else this.visitExpression(body);
    });

    const fnT = T.func(params, T.unknown(), isAsync);
    this.setType(node, fnT);
    return fnT;
  }

  /* =========================================================
     Assignables & stores (l/v/c)
     ========================================================= */

  private resolveAssignableType(target: any, write: boolean): ForgeType | null {
    if (!target) return null;

    if (target.kind === "Identifier") {
      const name = target.name ?? "";
      const sym = this.scope.resolve(name);
      if (!sym) {
        // on write, auto-declare? (NO). keep as error, but return unknown.
        if (write) this.error(target.range, `Cannot assign to undeclared variable '${name}'.`, "SEM_ASSIGN_UNDECL");
        return T.unknown();
      }
      return sym.type;
    }

    if (target.kind === "NamespacedIdentifier") {
      const ns = target.namespace as "l" | "v" | "c";
      const name = target.name?.name ?? "";
      let sym = this.resolveStore(ns, name);

      if (!sym) {
        if (write) {
          // For your language, writing l.x should create it if missing (common DSL behavior).
          // We'll create as let in that store.
          sym = this.defineStore(ns, name, "let", target.range, T.unknown());
        } else {
          this.error(target.range, `Undefined ${ns}. variable '${name}'.`, "SEM_UNDEF_NS");
          return T.unknown();
        }
      }

      return sym.type;
    }

    if (target.kind === "MemberExpression") {
      // Resolve object type and member key; for object literal variables we can track props
      const obj = target.object;
      const key = target.property?.name ?? "";
      const objT = this.visitExpression(obj);

      if (objT.kind === "object") {
        const current = objT.props[key] ?? T.unknown();
        // On write, widen property type to unknown if missing (open objects)
        if (write && !objT.props[key]) objT.props[key] = T.unknown();
        return current;
      }

      return T.unknown();
    }

    return T.unknown();
  }

  private checkConstReassignment(target: any): void {
    // Identifier const?
    if (target?.kind === "Identifier") {
      const name = target.name ?? "";
      const sym = this.scope.resolve(name);
      if (sym && sym.mutability === "const") {
        this.error(target.range, `Cannot assign to const '${name}'.`, "SEM_CONST_REASSIGN");
      }
    }

    // Namespaced const? (c.* store is const-like)
    if (target?.kind === "NamespacedIdentifier") {
      const ns = target.namespace as "l" | "v" | "c";
      const name = target.name?.name ?? "";
      const sym = this.resolveStore(ns, name);
      if (sym && sym.mutability === "const") {
        this.error(target.range, `Cannot assign to const '${ns}.${name}'.`, "SEM_CONST_REASSIGN");
      }
      // special: c.* is const store by convention
      if (ns === "c") {
        this.error(target.range, `Cannot assign to 'c.' store (const store).`, "SEM_CONST_STORE");
      }
    }
  }

  private resolveStore(ns: "l" | "v" | "c", name: string): SymbolInfo | null {
    if (ns === "l") return this.storeL.get(name) ?? null;
    if (ns === "v") return this.storeV.get(name) ?? null;
    return this.storeC.get(name) ?? null;
  }

  private defineStore(
    ns: "l" | "v" | "c",
    name: string,
    mutability: Mutability,
    declaredAt: Range,
    type: ForgeType
  ): SymbolInfo {
    const sym: SymbolInfo = {
      name,
      declaredAt,
      mutability: ns === "c" ? "const" : mutability,
      type,
      store: ns,
    };

    const map = ns === "l" ? this.storeL : ns === "v" ? this.storeV : this.storeC;
    map.set(name, sym);
    return sym;
  }

  /* =========================================================
     Builtin resolution & module gating
     ========================================================= */

  private resolveCallSignature(callee: Expression): BuiltinFn | null {
    // Try resolve through BUILTIN_APIS by walking member chain.
    const path = this.getCalleePath(callee);
    if (!path.length) return null;

    // inp(...) is stored as inp.__call__ in builtins
    const attemptCall = (members: any, parts: string[]): BuiltinFn | null => {
      let cur: any = members;
      for (const p of parts) {
        const next = cur?.[p];
        if (!next) return null;
        if (isBuiltinNamespace(next)) cur = next.members;
        else if (isBuiltinFn(next)) cur = next; // leaf can be fn
        else if (isBuiltinValue(next)) cur = next; // leaf is value
      }

      if (isBuiltinFn(cur)) return cur;
      if (isBuiltinNamespace(cur)) {
        const call = cur.members["__call__"];
        if (call && isBuiltinFn(call)) return call;
      }
      return null;
    };

    // Walk root
    const root = path[0];
    const rootNode = (BUILTIN_APIS.members as any)[root];
    if (!rootNode) return null;

    // Build from that root
    if (isBuiltinNamespace(rootNode)) {
      const fnNode = attemptCall(rootNode.members, path.slice(1));
      if (fnNode) return fnNode;

      // Direct call on namespace root: inp(...)
      const call = rootNode.members["__call__"];
      if (call && isBuiltinFn(call) && path.length === 1) return call;
      return null;
    }

    // root itself is fn or value (rare)
    if (isBuiltinFn(rootNode) && path.length === 1) return rootNode;
    return null;
  }

  private checkModuleGatingForCall(node: CallExpression): void {
    if (this.opts.ignoreModuleGating) return;
    if (this.modules.allInOneEnabled) return;

    const callee = (node as any).callee as Expression;
    const path = this.getCalleePath(callee);
    const root = path[0];

    // If root is a known module namespace, require it enabled
    const required = root as ModuleName;

    // If builtins says a module is required, use that too
    const sig = this.resolveCallSignature(callee);
    const reqFromSig = sig?.module;

    const need = (reqFromSig ?? required) as ModuleName;

    if (isModuleRoot(root) || reqFromSig) {
      if (!this.modules.enabled.has(need)) {
        this.error(
          node.range,
          `Module '${need}' is not enabled. Add: able '${need}' (or remove disable 'AllInOne').`,
          "SEM_MODULE_DISABLED"
        );
      }
    }
  }

  private checkModuleGatingForMember(node: MemberExpression): void {
    if (this.opts.ignoreModuleGating) return;
    if (this.modules.allInOneEnabled) return;

    const path = this.getMemberPath(node);
    const root = path[0];

    if (isModuleRoot(root)) {
      const need = root as ModuleName;
      if (!this.modules.enabled.has(need)) {
        this.error(
          node.range,
          `Module '${need}' is not enabled. Add: able '${need}' (or remove disable 'AllInOne').`,
          "SEM_MODULE_DISABLED"
        );
      }
    }
  }

  private getCalleePath(expr: Expression): string[] {
    // Identifier -> ["name"]
    // MemberExpression -> ["root","sub","leaf"]
    // NamespacedIdentifier is NOT treated as builtin path
    if (!expr) return [];

    if ((expr as any).kind === "Identifier") return [(expr as any).name ?? ""].filter(Boolean);

    if ((expr as any).kind === "MemberExpression") return this.getMemberPath(expr as any);

    return [];
  }

  private getMemberPath(expr: MemberExpression): string[] {
    const parts: string[] = [];
    let cur: any = expr;

    while (cur && cur.kind === "MemberExpression") {
      const prop = cur.property?.name ?? "";
      if (prop) parts.unshift(prop);
      cur = cur.object;
    }

    if (cur?.kind === "Identifier") {
      const root = cur.name ?? "";
      if (root) parts.unshift(root);
    }

    return parts.filter(Boolean);
  }

  /* =========================================================
     Scopes helpers
     ========================================================= */

  private withBlockScope<T>(fn: () => T): T {
    const prev = this.scope;
    this.scope = new Scope("block", prev);
    try {
      return fn();
    } finally {
      this.scope = prev;
    }
  }

  private withFunctionScope<T>(fn: () => T): T {
    const prev = this.scope;
    this.scope = new Scope("function", prev);
    try {
      return fn();
    } finally {
      this.scope = prev;
    }
  }

  private findFunctionOrGlobalScope(): Scope {
    let s: Scope | null = this.scope;
    while (s) {
      if (s.kind === "function" || s.kind === "global") return s;
      // @ts-ignore private parent isn't accessible; we keep parent in closure by resolving through a helper
      s = (s as any).parent ?? null;
    }
    return this.globalScope;
  }

  private defineParams(params: any[]): void {
    for (const p of params) {
      const name = p?.name?.name ?? "";
      if (!name) continue;

      const ok = this.scope.define({
        name,
        declaredAt: p?.name?.range ?? p?.range ?? fakeRange0(),
        mutability: "let",
        type: T.unknown(),
        store: "function",
      });

      if (!ok) this.error(p?.name?.range ?? p?.range ?? fakeRange0(), `Parameter '${name}' is already declared.`, "SEM_REDECL");
    }
  }

  /* =========================================================
     Type tracking
     ========================================================= */

  private setType(node: any, t: ForgeType): void {
    const k = typeKey(node);
    if (k >= 0) this.types.set(k, t);
  }

  /* =========================================================
     Output / indexing
     ========================================================= */

  private makeIndex(): SymbolIndex {
    const global: Record<string, SymbolInfo> = {};
    for (const s of this.globalScope.allLocal()) global[s.name] = s;

    const l: Record<string, SymbolInfo> = {};
    const v: Record<string, SymbolInfo> = {};
    const c: Record<string, SymbolInfo> = {};

    for (const [k, s] of this.storeL.entries()) l[k] = s;
    for (const [k, s] of this.storeV.entries()) v[k] = s;
    for (const [k, s] of this.storeC.entries()) c[k] = s;

    return { global, l, v, c };
  }

  /* =========================================================
     Diagnostics helpers
     ========================================================= */

  private error(range: Range, message: string, code?: string): void {
    this.diags.push({ severity: "error", message, range, code });
  }

  private warn(range: Range, message: string, code?: string): void {
    this.diags.push({ severity: "warning", message, range, code });
  }

  /* =========================================================
     Small utilities
     ========================================================= */

  private readStringValue(node: any): string | null {
    if (!node) return null;
    if (node.kind === "StringLiteral") return node.value ?? null;
    // parser may keep raw strings differently; be defensive
    if (typeof node.value === "string") return node.value;
    return null;
  }
}

/* =========================================================
   Builtin helper guards
   ========================================================= */

function isBuiltinNamespace(x: any): x is BuiltinNamespace {
  return x && typeof x === "object" && x.members && typeof x.name === "string";
}
function isBuiltinFn(x: any): x is BuiltinFn {
  return x && typeof x === "object" && Array.isArray(x.params) && x.returns;
}
function isBuiltinValue(x: any): x is BuiltinValue {
  return x && typeof x === "object" && x.type && typeof x.name === "string" && !Array.isArray(x.params);
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

/* =========================================================
   Formatting helpers
   ========================================================= */

function fmtType(t: ForgeType): string {
  switch (t.kind) {
    case "unknown":
      return "unknown";
    case "any":
      return "any";
    case "never":
      return "never";
    case "void":
      return "void";
    case "null":
      return "null";
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

/* =========================================================
   Fake range for builtins
   ========================================================= */

function fakeRange0(): Range {
  return {
    start: { offset: 0, line: 0, column: 0 },
    end: { offset: 0, line: 0, column: 0 },
  };
}
