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

export type Integer = number;

/* =========================================================
   Source locations
   ========================================================= */

export type Position = {
  /** Absolute offset from file start (0-based). */
  offset: Integer;
  /** Line index (0-based). */
  line: Integer;
  /** Column index (0-based). */
  column: Integer;
};

export type Range = {
  start: Position;
  end: Position;
};

export const UNKNOWN_POSITION: Position = Object.freeze({
  offset: 0,
  line: 0,
  column: 0,
});

export const UNKNOWN_RANGE: Range = Object.freeze({
  start: UNKNOWN_POSITION,
  end: UNKNOWN_POSITION,
});

export function clonePosition(p: Position): Position {
  return { offset: p.offset, line: p.line, column: p.column };
}

export function cloneRange(r: Range): Range {
  return { start: clonePosition(r.start), end: clonePosition(r.end) };
}

export function mergeRanges(a: Range, b: Range): Range {
  const start = a.start.offset <= b.start.offset ? a.start : b.start;
  const end = a.end.offset >= b.end.offset ? a.end : b.end;
  return { start: clonePosition(start), end: clonePosition(end) };
}

/* =========================================================
   Node kinds
   ========================================================= */

export const NODE_KINDS = [
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
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export type NodeBase = {
  kind: NodeKind;
  range: Range;
};

/* =========================================================
   Program / Statements / Expressions unions
   ========================================================= */

export type Program = NodeBase & {
  kind: "Program";
  body: Statement[];
};

export type Statement =
  | DisableDirective
  | AbleDirective
  | VarDeclaration
  | AssignmentStatement
  | ExpressionStatement
  | BlockStatement
  | IfStatement
  | WhileStatement
  | DoWhileStatement
  | ForStatement
  | ForEachStatement
  | BreakStatement
  | ContinueStatement
  | ReturnStatement
  | ThrowStatement
  | TryStatement
  | FunctionDeclaration;

export type Expression =
  | Identifier
  | NamespacedIdentifier
  | MemberExpression
  | CallExpression
  | UnaryExpression
  | BinaryExpression
  | AssignmentExpression
  | ConditionalExpression
  | BooleanOpExpression
  | ArrowFunctionExpression
  | FunctionExpression
  | AwaitExpression
  | Literal;

export type Literal =
  | StringLiteral
  | NumberLiteral
  | BooleanLiteral
  | NullLiteral
  | DurationLiteral
  | ArrayLiteral
  | ObjectLiteral
  | TemplateString;

/* =========================================================
   Directives
   ========================================================= */

export type DisableDirective = NodeBase & {
  kind: "DisableDirective";
  /** e.g. 'AllInOne' */
  target: StringLiteral;
};

export type AbleDirective = NodeBase & {
  kind: "AbleDirective";
  /** e.g. ['Math','Time','Sys'] */
  modules: StringLiteral[];
};

/* =========================================================
   Blocks
   ========================================================= */

export type BlockStatement = NodeBase & {
  kind: "BlockStatement";
  body: Statement[];
};

/* =========================================================
   Variables / Declarations
   ========================================================= */

export type VarNamespace = "l" | "v" | "c";

export type VarDeclaration = NodeBase & {
  kind: "VarDeclaration";
  declKind: "let" | "var" | "const";
  name: Identifier;
  initializer: Expression | null;
};

export type AssignmentStatement = NodeBase & {
  kind: "AssignmentStatement";
  target: Assignable;
  value: Expression;
};

export type ExpressionStatement = NodeBase & {
  kind: "ExpressionStatement";
  expression: Expression;
};

export type Assignable = NamespacedIdentifier | MemberExpression | Identifier;

/* =========================================================
   Control flow statements
   ========================================================= */

export type IfStatement = NodeBase & {
  kind: "IfStatement";
  /** Forge supports if (...) { ... } and also if expr { ... } */
  test: Expression;
  consequent: BlockStatement;
  elifClauses: ElifClause[];
  alternate: BlockStatement | null;
};

export type ElifClause = NodeBase & {
  kind: "IfStatement"; // represented as an If-like clause; same kind would be confusing
  // To avoid kind collision, we store this as a plain object-like node:
  // but we keep it strongly typed by embedding NodeBase with a unique pseudo-kind.
} & {
  // Pseudo-kind marker:
  _clause: "ElifClause";
  test: Expression;
  consequent: BlockStatement;
};

export function isElifClause(x: unknown): x is ElifClause {
  return typeof x === "object" && x !== null && (x as any)._clause === "ElifClause";
}

export type WhileStatement = NodeBase & {
  kind: "WhileStatement";
  test: Expression;
  body: BlockStatement;
};

export type DoWhileStatement = NodeBase & {
  kind: "DoWhileStatement";
  body: BlockStatement;
  test: Expression;
};

export type ForStatement = NodeBase & {
  kind: "ForStatement";
  init: Statement | null; // usually VarDeclaration or AssignmentStatement
  test: Expression | null;
  update: Expression | null; // typically AssignmentExpression
  body: BlockStatement;
};

export type ForEachStatement = NodeBase & {
  kind: "ForEachStatement";
  item: Identifier;
  iterable: Expression;
  body: BlockStatement;
};

export type BreakStatement = NodeBase & {
  kind: "BreakStatement";
};

export type ContinueStatement = NodeBase & {
  kind: "ContinueStatement";
};

export type ReturnStatement = NodeBase & {
  kind: "ReturnStatement";
  argument: Expression | null;
};

export type ThrowStatement = NodeBase & {
  kind: "ThrowStatement";
  argument: Expression;
};

export type TryStatement = NodeBase & {
  kind: "TryStatement";
  block: BlockStatement;
  handler: CatchClause | null;
  finalizer: BlockStatement | null;
};

export type CatchClause = NodeBase & {
  kind: "TryStatement"; // pseudo-kind approach again (see ElifClause)
} & {
  _clause: "CatchClause";
  param: Identifier | null;
  body: BlockStatement;
};

export function isCatchClause(x: unknown): x is CatchClause {
  return typeof x === "object" && x !== null && (x as any)._clause === "CatchClause";
}

/* =========================================================
   Functions
   ========================================================= */

export type FunctionParameter = {
  name: Identifier;
  defaultValue: Expression | null;
  isRest: boolean;
};

export type FunctionDeclaration = NodeBase & {
  kind: "FunctionDeclaration";
  name: Identifier;
  params: FunctionParameter[];
  body: BlockStatement;
  isAsync: boolean;
};

export type FunctionExpression = NodeBase & {
  kind: "FunctionExpression";
  name: Identifier | null;
  params: FunctionParameter[];
  body: BlockStatement;
  isAsync: boolean;
};

export type ArrowFunctionExpression = NodeBase & {
  kind: "ArrowFunctionExpression";
  params: FunctionParameter[];
  body: BlockStatement | Expression; // allow expression-bodied arrows
  isAsync: boolean;
};

/* =========================================================
   Expressions
   ========================================================= */

export type Identifier = NodeBase & {
  kind: "Identifier";
  name: string;
};

export type NamespacedIdentifier = NodeBase & {
  kind: "NamespacedIdentifier";
  namespace: VarNamespace;
  name: Identifier;
};

/**
 * Property keys can be escaped (e.g. v.\v.dog) to allow
 * reserved words or namespace letters as literal keys.
 */
export type PropertyKey = {
  name: string;
  escaped: boolean;
  range: Range;
};

export type MemberExpression = NodeBase & {
  kind: "MemberExpression";
  object: Expression;
  property: PropertyKey;
  computed: boolean; // reserved for future: obj[expr]
};

export type CallExpression = NodeBase & {
  kind: "CallExpression";
  callee: Expression;
  args: CallArgument[];
};

export type CallArgument = PositionalArgument | NamedArgument;

export type PositionalArgument = {
  kind: "PositionalArgument";
  value: Expression;
  range: Range;
};

export type NamedArgument = {
  kind: "NamedArgument";
  name: Identifier;
  value: Expression;
  range: Range;
};

export type UnaryOperator = "!" | "-" | "+";

export type UnaryExpression = NodeBase & {
  kind: "UnaryExpression";
  operator: UnaryOperator;
  argument: Expression;
};

export type BinaryOperator =
  | "=="
  | "!="
  | "==="
  | "!=="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "x"
  | "/"
  | "%"
  | "§"
  | "&&"
  | "||";

export type BinaryExpression = NodeBase & {
  kind: "BinaryExpression";
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
};

export type AssignmentOperator = "=";

export type AssignmentExpression = NodeBase & {
  kind: "AssignmentExpression";
  operator: AssignmentOperator;
  left: Assignable;
  right: Expression;
};

export type ConditionalExpression = NodeBase & {
  kind: "ConditionalExpression";
  test: Expression;
  consequent: Expression;
  alternate: Expression;
};

export type AwaitExpression = NodeBase & {
  kind: "AwaitExpression";
  argument: Expression;
};

/* =========================================================
   Forge-specific boolean ops
   ========================================================= */

/**
 * Represents Forge boolean special operators:
 *   - postfix/infix checks:   expr ?isBoolean    | expr !isBoolean
 *   - forced checks:          expr ?isBoolean.t  | expr ?isBoolean.f
 *   - casts:                  expr isBoolean     | expr isBoolean.t | expr isBoolean.f
 *
 * In some legacy snippets, you may see assignments like:
 *   l.dog = ?isBoolean
 * which can be interpreted as "apply a boolean query to the LHS current value".
 * The parser can encode that either as:
 *   BooleanOpExpression { subject: NamespacedIdentifier('l.dog'), ... }
 * or as a special-case lowering in parser/semantic.
 */
export type BooleanOpKind = "query" | "cast";

export type BooleanOpExpression = NodeBase & {
  kind: "BooleanOpExpression";
  subject: Expression;
  op: BooleanOpKind;
  /** query: negate the check ( !isBoolean ) */
  negate: boolean;
  /** For .t or .f suffix: force/compare against a value. */
  force: boolean | null;
};

/* =========================================================
   Literals
   ========================================================= */

export type StringLiteral = NodeBase & {
  kind: "StringLiteral";
  value: string;
  quote: "'" | '"';
};

export type NumberLiteral = NodeBase & {
  kind: "NumberLiteral";
  value: number;
  raw: string;
};

export type BooleanLiteral = NodeBase & {
  kind: "BooleanLiteral";
  value: boolean;
};

export type NullLiteral = NodeBase & {
  kind: "NullLiteral";
  value: null;
};

export type DurationUnit = "ms" | "s" | "m" | "h";

export type DurationLiteral = NodeBase & {
  kind: "DurationLiteral";
  value: number; // supports float
  unit: DurationUnit;
  raw: string; // e.g. "0.5s"
};

export type ArrayLiteral = NodeBase & {
  kind: "ArrayLiteral";
  elements: Expression[];
};

export type ObjectLiteral = NodeBase & {
  kind: "ObjectLiteral";
  properties: ObjectProperty[];
};

export type ObjectProperty = {
  key: PropertyKey;
  value: Expression;
  range: Range;
};

/**
 * Template string / interpolation:
 * - Plain text segments + embedded expressions (e.g. "Hello {l.name}")
 * - This is useful for Terminal/UI printing patterns.
 */
export type TemplateString = NodeBase & {
  kind: "TemplateString";
  quote: "'" | '"';
  parts: TemplatePart[];
};

export type TemplatePart = TemplateTextPart | TemplateExprPart;

export type TemplateTextPart = {
  kind: "TemplateTextPart";
  text: string;
  range: Range;
};

export type TemplateExprPart = {
  kind: "TemplateExprPart";
  expression: Expression;
  range: Range;
};

/* =========================================================
   Factory helpers
   ========================================================= */

export function node<T extends NodeBase>(kind: T["kind"], range: Range, fields: Omit<T, "kind" | "range">): T {
  return { kind, range, ...(fields as any) } as T;
}

export function id(name: string, range: Range = UNKNOWN_RANGE): Identifier {
  return node("Identifier", range, { name });
}

export function nsId(namespace: VarNamespace, name: Identifier, range: Range = UNKNOWN_RANGE): NamespacedIdentifier {
  return node("NamespacedIdentifier", range, { namespace, name });
}

export function strLit(value: string, quote: "'" | '"' = "'", range: Range = UNKNOWN_RANGE): StringLiteral {
  return node("StringLiteral", range, { value, quote });
}

export function numLit(value: number, raw: string = String(value), range: Range = UNKNOWN_RANGE): NumberLiteral {
  return node("NumberLiteral", range, { value, raw });
}

export function boolLit(value: boolean, range: Range = UNKNOWN_RANGE): BooleanLiteral {
  return node("BooleanLiteral", range, { value });
}

export function nullLit(range: Range = UNKNOWN_RANGE): NullLiteral {
  return node("NullLiteral", range, { value: null });
}

export function durationLit(value: number, unit: DurationUnit, raw: string, range: Range = UNKNOWN_RANGE): DurationLiteral {
  return node("DurationLiteral", range, { value, unit, raw });
}

export function propKey(name: string, escaped = false, range: Range = UNKNOWN_RANGE): PropertyKey {
  return { name, escaped, range };
}

/* =========================================================
   Type guards
   ========================================================= */

export function isNode(x: unknown): x is NodeBase {
  return typeof x === "object" && x !== null && typeof (x as any).kind === "string" && (x as any).range?.start != null;
}

export function isStatement(x: unknown): x is Statement {
  return isNode(x) && (NODE_KINDS as readonly string[]).includes((x as any).kind);
}

export function isExpression(x: unknown): x is Expression {
  return isNode(x) && (NODE_KINDS as readonly string[]).includes((x as any).kind);
}

export function isLiteral(x: unknown): x is Literal {
  return (
    isNode(x) &&
    ((x as any).kind === "StringLiteral" ||
      (x as any).kind === "NumberLiteral" ||
      (x as any).kind === "BooleanLiteral" ||
      (x as any).kind === "NullLiteral" ||
      (x as any).kind === "DurationLiteral" ||
      (x as any).kind === "ArrayLiteral" ||
      (x as any).kind === "ObjectLiteral" ||
      (x as any).kind === "TemplateString")
  );
}

/* =========================================================
   AST Walker (visitor pattern)
   ========================================================= */

export type Visitor = Partial<{
  enter(node: NodeBase, parent: NodeBase | null): void;
  leave(node: NodeBase, parent: NodeBase | null): void;

  Program(node: Program, parent: NodeBase | null): void;
  BlockStatement(node: BlockStatement, parent: NodeBase | null): void;

  DisableDirective(node: DisableDirective, parent: NodeBase | null): void;
  AbleDirective(node: AbleDirective, parent: NodeBase | null): void;

  VarDeclaration(node: VarDeclaration, parent: NodeBase | null): void;
  AssignmentStatement(node: AssignmentStatement, parent: NodeBase | null): void;
  ExpressionStatement(node: ExpressionStatement, parent: NodeBase | null): void;

  IfStatement(node: IfStatement, parent: NodeBase | null): void;
  WhileStatement(node: WhileStatement, parent: NodeBase | null): void;
  DoWhileStatement(node: DoWhileStatement, parent: NodeBase | null): void;
  ForStatement(node: ForStatement, parent: NodeBase | null): void;
  ForEachStatement(node: ForEachStatement, parent: NodeBase | null): void;

  BreakStatement(node: BreakStatement, parent: NodeBase | null): void;
  ContinueStatement(node: ContinueStatement, parent: NodeBase | null): void;
  ReturnStatement(node: ReturnStatement, parent: NodeBase | null): void;
  ThrowStatement(node: ThrowStatement, parent: NodeBase | null): void;
  TryStatement(node: TryStatement, parent: NodeBase | null): void;

  FunctionDeclaration(node: FunctionDeclaration, parent: NodeBase | null): void;

  Identifier(node: Identifier, parent: NodeBase | null): void;
  NamespacedIdentifier(node: NamespacedIdentifier, parent: NodeBase | null): void;
  MemberExpression(node: MemberExpression, parent: NodeBase | null): void;
  CallExpression(node: CallExpression, parent: NodeBase | null): void;
  UnaryExpression(node: UnaryExpression, parent: NodeBase | null): void;
  BinaryExpression(node: BinaryExpression, parent: NodeBase | null): void;
  AssignmentExpression(node: AssignmentExpression, parent: NodeBase | null): void;
  ConditionalExpression(node: ConditionalExpression, parent: NodeBase | null): void;
  BooleanOpExpression(node: BooleanOpExpression, parent: NodeBase | null): void;
  ArrowFunctionExpression(node: ArrowFunctionExpression, parent: NodeBase | null): void;
  FunctionExpression(node: FunctionExpression, parent: NodeBase | null): void;
  AwaitExpression(node: AwaitExpression, parent: NodeBase | null): void;

  StringLiteral(node: StringLiteral, parent: NodeBase | null): void;
  NumberLiteral(node: NumberLiteral, parent: NodeBase | null): void;
  BooleanLiteral(node: BooleanLiteral, parent: NodeBase | null): void;
  NullLiteral(node: NullLiteral, parent: NodeBase | null): void;
  DurationLiteral(node: DurationLiteral, parent: NodeBase | null): void;
  ArrayLiteral(node: ArrayLiteral, parent: NodeBase | null): void;
  ObjectLiteral(node: ObjectLiteral, parent: NodeBase | null): void;
  TemplateString(node: TemplateString, parent: NodeBase | null): void;
}>;

export function walkAst(root: NodeBase, visitor: Visitor): void {
  const visitNode = (node: NodeBase, parent: NodeBase | null) => {
    visitor.enter?.(node, parent);

    const kindHandler = (visitor as any)[node.kind] as ((n: any, p: any) => void) | undefined;
    kindHandler?.(node as any, parent);

    // Recurse
    switch (node.kind) {
      case "Program": {
        const n = node as Program;
        for (const st of n.body) visitNode(st, node);
        break;
      }
      case "BlockStatement": {
        const n = node as BlockStatement;
        for (const st of n.body) visitNode(st, node);
        break;
      }
      case "DisableDirective": {
        const n = node as DisableDirective;
        visitNode(n.target, node);
        break;
      }
      case "AbleDirective": {
        const n = node as AbleDirective;
        for (const m of n.modules) visitNode(m, node);
        break;
      }
      case "VarDeclaration": {
        const n = node as VarDeclaration;
        visitNode(n.name, node);
        if (n.initializer) visitNode(n.initializer, node);
        break;
      }
      case "AssignmentStatement": {
        const n = node as AssignmentStatement;
        visitNode(n.target, node);
        visitNode(n.value, node);
        break;
      }
      case "ExpressionStatement": {
        const n = node as ExpressionStatement;
        visitNode(n.expression, node);
        break;
      }
      case "IfStatement": {
        const n = node as IfStatement;
        visitNode(n.test, node);
        visitNode(n.consequent, node);
        for (const c of n.elifClauses) {
          // ElifClause is pseudo-kind; still walk its children
          if (isElifClause(c)) {
            visitNode(c.test, node);
            visitNode(c.consequent, node);
          }
        }
        if (n.alternate) visitNode(n.alternate, node);
        break;
      }
      case "WhileStatement": {
        const n = node as WhileStatement;
        visitNode(n.test, node);
        visitNode(n.body, node);
        break;
      }
      case "DoWhileStatement": {
        const n = node as DoWhileStatement;
        visitNode(n.body, node);
        visitNode(n.test, node);
        break;
      }
      case "ForStatement": {
        const n = node as ForStatement;
        if (n.init) visitNode(n.init, node);
        if (n.test) visitNode(n.test, node);
        if (n.update) visitNode(n.update, node);
        visitNode(n.body, node);
        break;
      }
      case "ForEachStatement": {
        const n = node as ForEachStatement;
        visitNode(n.item, node);
        visitNode(n.iterable, node);
        visitNode(n.body, node);
        break;
      }
      case "ReturnStatement": {
        const n = node as ReturnStatement;
        if (n.argument) visitNode(n.argument, node);
        break;
      }
      case "ThrowStatement": {
        const n = node as ThrowStatement;
        visitNode(n.argument, node);
        break;
      }
      case "TryStatement": {
        const n = node as TryStatement;
        visitNode(n.block, node);
        if (n.handler && isCatchClause(n.handler)) {
          if (n.handler.param) visitNode(n.handler.param, node);
          visitNode(n.handler.body, node);
        }
        if (n.finalizer) visitNode(n.finalizer, node);
        break;
      }
      case "FunctionDeclaration": {
        const n = node as FunctionDeclaration;
        visitNode(n.name, node);
        for (const p of n.params) {
          visitNode(p.name, node);
          if (p.defaultValue) visitNode(p.defaultValue, node);
        }
        visitNode(n.body, node);
        break;
      }

      // Expressions
      case "NamespacedIdentifier": {
        const n = node as NamespacedIdentifier;
        visitNode(n.name, node);
        break;
      }
      case "MemberExpression": {
        const n = node as MemberExpression;
        visitNode(n.object, node);
        break;
      }
      case "CallExpression": {
        const n = node as CallExpression;
        visitNode(n.callee, node);
        for (const a of n.args) {
          if (a.kind === "PositionalArgument") visitNode(a.value, node);
          else visitNode(a.name, node), visitNode(a.value, node);
        }
        break;
      }
      case "UnaryExpression": {
        const n = node as UnaryExpression;
        visitNode(n.argument, node);
        break;
      }
      case "BinaryExpression": {
        const n = node as BinaryExpression;
        visitNode(n.left, node);
        visitNode(n.right, node);
        break;
      }
      case "AssignmentExpression": {
        const n = node as AssignmentExpression;
        visitNode(n.left, node);
        visitNode(n.right, node);
        break;
      }
      case "ConditionalExpression": {
        const n = node as ConditionalExpression;
        visitNode(n.test, node);
        visitNode(n.consequent, node);
        visitNode(n.alternate, node);
        break;
      }
      case "BooleanOpExpression": {
        const n = node as BooleanOpExpression;
        visitNode(n.subject, node);
        break;
      }
      case "ArrowFunctionExpression": {
        const n = node as ArrowFunctionExpression;
        for (const p of n.params) {
          visitNode(p.name, node);
          if (p.defaultValue) visitNode(p.defaultValue, node);
        }
        if (isNode(n.body)) visitNode(n.body as any, node);
        break;
      }
      case "FunctionExpression": {
        const n = node as FunctionExpression;
        if (n.name) visitNode(n.name, node);
        for (const p of n.params) {
          visitNode(p.name, node);
          if (p.defaultValue) visitNode(p.defaultValue, node);
        }
        visitNode(n.body, node);
        break;
      }
      case "AwaitExpression": {
        const n = node as AwaitExpression;
        visitNode(n.argument, node);
        break;
      }

      // Literals: recurse into compound ones
      case "ArrayLiteral": {
        const n = node as ArrayLiteral;
        for (const e of n.elements) visitNode(e, node);
        break;
      }
      case "ObjectLiteral": {
        const n = node as ObjectLiteral;
        for (const p of n.properties) visitNode(p.value, node);
        break;
      }
      case "TemplateString": {
        const n = node as TemplateString;
        for (const part of n.parts) {
          if (part.kind === "TemplateExprPart") visitNode(part.expression, node);
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
