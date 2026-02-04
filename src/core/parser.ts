// src/core/parser.ts
//
// Forge Parser
// ------------
// Turns tokens (from src/core/lexer.ts) into an AST (src/core/ast.ts) + parse errors.
//
// This parser is intentionally pragmatic for an MVP VS Code extension:
// - Good diagnostics + error recovery (so highlighting/diagnostics keep working)
// - Handles the Forge syntax you’ve been designing (disable/able, namespaces l/v/c,
//   comments, object blocks, if/elif/else, loops, try/catch/finally, functions,
//   member access with backslash escape, named call args, duration literals, etc.)
// - Includes a "bare template argument" heuristic so calls like:
//
//     inp(Quale è il tuo nome? >> )
//     console.text.var(Errore: {l.error.message})
//
//   can still parse even without quotes. (Recommended: use quotes in real code.)
//
// NOTE:
// - Some “language design” quirks (like assignment to isBoolean / ?isBoolean without subject)
//   are implemented as small statement-level rewrites, matching your examples.
//
// Exports:
//   - parseSource(source: string): ParseResult
//   - parseTokens(tokens, source?): ParseResult
//   - Parser class (advanced usage)

import type {
  Program,
  Statement,
  Expression,
  Literal,
  Range,
  Position,
  VarNamespace,
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
  TemplateTextPart,
  TemplateExprPart,
  CallArgument,
  PositionalArgument,
  NamedArgument,
  FunctionParameter,
  PropertyKey,
  DurationUnit,
} from "./ast";

import { tokenize, TokenKind } from "./lexer";
import type {
  Token,
  TokenBase,
  IdentifierToken,
  StringToken,
  NumberToken,
  DurationToken,
} from "./lexer";

/* =========================================================
   Parse result & diagnostics
   ========================================================= */

export type ParseError = {
  message: string;
  range: Range;
};

export type ParseResult = {
  program: Program;
  errors: ParseError[];
};

/* =========================================================
   Public helpers
   ========================================================= */

export function parseSource(source: string): ParseResult {
  const lex = tokenize(source, {
    includeComments: false,
    includeWhitespace: false,
    emitNewlines: true,
    stopOnError: false,
  });

  const parser = new Parser(lex.tokens, source);
  const program = parser.parseProgram();

  // merge lexer and parser errors
  const errors: ParseError[] = [
    ...lex.errors.map((e) => ({ message: e.message, range: e.range })),
    ...parser.errors,
  ];

  return { program, errors };
}

export function parseTokens(tokens: Token[], source = ""): ParseResult {
  const parser = new Parser(tokens, source);
  const program = parser.parseProgram();
  return { program, errors: parser.errors };
}

/* =========================================================
   Parser
   ========================================================= */

type Assoc = "left" | "right";

type BinOpInfo = {
  precedence: number;
  assoc: Assoc;
  op:
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
};

const BIN_OP_TABLE: Partial<Record<TokenKind, BinOpInfo>> = {
  [TokenKind.OR]: { precedence: 1, assoc: "left", op: "||" },
  [TokenKind.AND]: { precedence: 2, assoc: "left", op: "&&" },

  [TokenKind.EQ]: { precedence: 3, assoc: "left", op: "==" },
  [TokenKind.NEQ]: { precedence: 3, assoc: "left", op: "!=" },
  [TokenKind.SEQ]: { precedence: 3, assoc: "left", op: "===" },
  [TokenKind.SNEQ]: { precedence: 3, assoc: "left", op: "!==" },

  [TokenKind.LT]: { precedence: 4, assoc: "left", op: "<" },
  [TokenKind.LTE]: { precedence: 4, assoc: "left", op: "<=" },
  [TokenKind.GT]: { precedence: 4, assoc: "left", op: ">" },
  [TokenKind.GTE]: { precedence: 4, assoc: "left", op: ">=" },

  [TokenKind.PLUS]: { precedence: 5, assoc: "left", op: "+" },
  [TokenKind.MINUS]: { precedence: 5, assoc: "left", op: "-" },

  [TokenKind.DIV]: { precedence: 6, assoc: "left", op: "/" },
  [TokenKind.MOD]: { precedence: 6, assoc: "left", op: "%" },
  [TokenKind.ROOT]: { precedence: 6, assoc: "left", op: "§" },
  [TokenKind.MUL_X]: { precedence: 6, assoc: "left", op: "x" },
};

export class Parser {
  private readonly tokens: Token[];
  private readonly source: string;
  private idx = 0;

  public readonly errors: ParseError[] = [];

  constructor(tokens: Token[], source = "") {
    this.tokens = tokens ?? [];
    this.source = source ?? "";
  }

  /* =========================================================
     Top-level
     ========================================================= */

  public parseProgram(): Program {
    const start = this.current().range.start;
    const body: Statement[] = [];

    this.skipSeparators();

    while (!this.isAtEnd()) {
      const st = this.parseStatement();
      if (st) body.push(st);

      this.skipSeparators();
    }

    const end = this.previous().range.end;
    return {
      kind: "Program",
      range: { start, end },
      body,
    };
  }

  /* =========================================================
     Statements
     ========================================================= */

  private parseStatement(): Statement | null {
    // Allow stray NEWLINE/SEMICOLON
    this.skipSeparators();

    const t = this.current();

    // Directives
    if (this.match(TokenKind.KW_DISABLE)) return this.parseDisableDirective(this.previous());
    if (this.match(TokenKind.KW_ABLE)) return this.parseAbleDirective(this.previous());

    // Decls
    if (this.match(TokenKind.KW_LET)) return this.parseVarDeclaration("let", this.previous());
    if (this.match(TokenKind.KW_VAR)) return this.parseVarDeclaration("var", this.previous());
    if (this.match(TokenKind.KW_CONST)) return this.parseVarDeclaration("const", this.previous());

    // Control flow
    if (this.match(TokenKind.KW_IF)) return this.parseIfStatement(this.previous());
    if (this.match(TokenKind.KW_WHILE)) return this.parseWhileStatement(this.previous());
    if (this.match(TokenKind.KW_DO)) return this.parseDoWhileStatement(this.previous());
    if (this.match(TokenKind.KW_FOR)) return this.parseForStatement(this.previous());
    if (this.match(TokenKind.KW_FOREACH)) return this.parseForEachStatement(this.previous());
    if (this.match(TokenKind.KW_TRY)) return this.parseTryStatement(this.previous());

    // Function declaration: "async func" or "func"
    if (this.is(TokenKind.KW_ASYNC) && this.peekKind(1) === TokenKind.KW_FUNC) {
      this.advance(); // async
      this.advance(); // func
      return this.parseFunctionDeclaration(true, this.previous());
    }
    if (this.match(TokenKind.KW_FUNC)) {
      return this.parseFunctionDeclaration(false, this.previous());
    }

    // Simple statements
    if (this.match(TokenKind.KW_RETURN)) return this.parseReturnStatement(this.previous());
    if (this.match(TokenKind.KW_THROW)) return this.parseThrowStatement(this.previous());
    if (this.match(TokenKind.KW_BREAK)) return this.makeSimpleStatement("BreakStatement", this.previous());
    if (this.match(TokenKind.KW_CONTINUE)) return this.makeSimpleStatement("ContinueStatement", this.previous());

    // Block
    if (this.match(TokenKind.LBRACE)) {
      // This is a statement-level block
      return this.parseBlockFromOpenedBrace(this.previous());
    }

    // Otherwise: assignment statement or expression statement
    const startTok = t;

    // Try parse an assignable + '='
    const maybeAssignable = this.tryParseAssignableLookahead();
    if (maybeAssignable && this.match(TokenKind.ASSIGN)) {
      const assignTok = this.previous();

      // Forge-specific rewrite: "x = ?isBoolean" / "x = !isBoolean"
      if (this.is(TokenKind.BOOL_Q_ISBOOLEAN) || this.is(TokenKind.BOOL_NOT_ISBOOLEAN)) {
        const opTok = this.advance();
        const force = this.tryReadBoolForceSuffix();
        const boolNode: BooleanOpExpression = {
          kind: "BooleanOpExpression",
          range: {
            start: startTok.range.start,
            end: force === null ? opTok.range.end : this.previous().range.end,
          },
          subject: maybeAssignable,
          op: "query",
          negate: opTok.kind === TokenKind.BOOL_NOT_ISBOOLEAN,
          force,
        };
        return {
          kind: "AssignmentStatement",
          range: { start: startTok.range.start, end: boolNode.range.end },
          target: maybeAssignable,
          value: boolNode,
        } as AssignmentStatement;
      }

      // Forge-specific rewrite: "x = isBoolean(.t/.f)"
      if (this.isIdentifierLexeme("isBoolean")) {
        const isTok = this.advance(); // identifier "isBoolean"
        const castForce = this.tryReadBoolForceSuffix();
        const castNode: BooleanOpExpression = {
          kind: "BooleanOpExpression",
          range: {
            start: startTok.range.start,
            end: castForce === null ? isTok.range.end : this.previous().range.end,
          },
          subject: maybeAssignable,
          op: "cast",
          negate: false,
          force: castForce,
        };
        return {
          kind: "AssignmentStatement",
          range: { start: startTok.range.start, end: castNode.range.end },
          target: maybeAssignable,
          value: castNode,
        } as AssignmentStatement;
      }

      // Normal assignment: parse full RHS expression
      const rhs = this.parseExpression();
      const end = rhs.range.end;

      return {
        kind: "AssignmentStatement",
        range: { start: startTok.range.start, end },
        target: maybeAssignable,
        value: rhs,
      } as AssignmentStatement;
    }

    // If we took tokens during lookahead attempt, roll back
    if (maybeAssignable) {
      // tryParseAssignableLookahead only advances on success,
      // so if it returned a node, we are already advanced past it.
      // But if it returned node and we didn't see '=', we need to parse as expression statement.
      // We handle that by rewinding to start and parsing expression normally.
      this.rewindTo(startTok);
    }

    // Expression statement (with bare-template heuristic allowed at statement level too)
    const expr = this.parseExpression({ allowBareTemplate: true });
    return {
      kind: "ExpressionStatement",
      range: expr.range,
      expression: expr,
    } as ExpressionStatement;
  }

  private parseDisableDirective(kwTok: TokenBase): DisableDirective {
    const targetTok = this.expect(TokenKind.STRING, "Expected a string after 'disable'.");
    const target = this.stringLiteralFromToken(targetTok as StringToken);

    // optional semicolon
    this.match(TokenKind.SEMICOLON);

    return {
      kind: "DisableDirective",
      range: { start: kwTok.range.start, end: target.range.end },
      target,
    };
  }

  private parseAbleDirective(kwTok: TokenBase): AbleDirective {
    const modules: StringLiteral[] = [];

    // able 'Math', 'Time', 'Sys'
    do {
      const sTok = this.expect(TokenKind.STRING, "Expected a string module name after 'able'.");
      modules.push(this.stringLiteralFromToken(sTok as StringToken));
    } while (this.match(TokenKind.COMMA));

    // optional semicolon
    this.match(TokenKind.SEMICOLON);

    const end = modules.length ? modules[modules.length - 1].range.end : kwTok.range.end;

    return {
      kind: "AbleDirective",
      range: { start: kwTok.range.start, end },
      modules,
    };
  }

  private parseVarDeclaration(kind: "let" | "var" | "const", kwTok: TokenBase): VarDeclaration {
    const nameTok = this.expectIdentifierLike("Expected variable name.");
    const name: Identifier = this.makeIdentifier(nameTok);

    let initializer: Expression | null = null;
    if (this.match(TokenKind.ASSIGN)) {
      initializer = this.parseExpression({ allowBareTemplate: true });
    }

    // optional statement terminator
    this.match(TokenKind.SEMICOLON);

    const end = initializer ? initializer.range.end : name.range.end;

    return {
      kind: "VarDeclaration",
      range: { start: kwTok.range.start, end },
      declKind: kind,
      name,
      initializer,
    };
  }

  private parseBlockFromOpenedBrace(openBrace: TokenBase): BlockStatement {
    const body: Statement[] = [];

    this.skipSeparators();

    while (!this.isAtEnd() && !this.is(TokenKind.RBRACE)) {
      const st = this.parseStatement();
      if (st) body.push(st);
      this.skipSeparators();
    }

    const close = this.expect(TokenKind.RBRACE, "Expected '}' to close block.");
    return {
      kind: "BlockStatement",
      range: { start: openBrace.range.start, end: close.range.end },
      body,
    };
  }

  private parseIfStatement(kwTok: TokenBase): IfStatement {
    const test = this.parseConditionExpression();
    const consequent = this.parseBlockStatement("Expected '{' after if condition.");

    const elifClauses: any[] = [];
    while (this.match(TokenKind.KW_ELIF)) {
      const elifKw = this.previous();
      const elifTest = this.parseConditionExpression();
      const elifCons = this.parseBlockStatement("Expected '{' after elif condition.");

      elifClauses.push({
        kind: "IfStatement",
        range: { start: elifKw.range.start, end: elifCons.range.end },
        _clause: "ElifClause",
        test: elifTest,
        consequent: elifCons,
      });
    }

    let alternate: BlockStatement | null = null;
    if (this.match(TokenKind.KW_ELSE)) {
      alternate = this.parseBlockStatement("Expected '{' after else.");
    }

    const end = alternate
      ? alternate.range.end
      : elifClauses.length
        ? elifClauses[elifClauses.length - 1].range.end
        : consequent.range.end;

    return {
      kind: "IfStatement",
      range: { start: kwTok.range.start, end },
      test,
      consequent,
      elifClauses,
      alternate,
    };
  }

  private parseWhileStatement(kwTok: TokenBase): WhileStatement {
    const test = this.parseConditionExpression();
    const body = this.parseBlockStatement("Expected '{' after while condition.");
    return {
      kind: "WhileStatement",
      range: { start: kwTok.range.start, end: body.range.end },
      test,
      body,
    };
  }

  private parseDoWhileStatement(kwTok: TokenBase): DoWhileStatement {
    const body = this.parseBlockStatement("Expected '{' after 'do'.");
    this.expect(TokenKind.KW_WHILE, "Expected 'while' after do-block.");
    const test = this.parseConditionExpression();
    // optional terminator
    this.match(TokenKind.SEMICOLON);
    return {
      kind: "DoWhileStatement",
      range: { start: kwTok.range.start, end: test.range.end },
      body,
      test,
    };
  }

  private parseForStatement(kwTok: TokenBase): ForStatement {
    this.expect(TokenKind.LPAREN, "Expected '(' after 'for'.");

    // init
    let init: Statement | null = null;
    this.skipNewlines();
    if (!this.is(TokenKind.SEMICOLON)) {
      if (this.match(TokenKind.KW_LET)) init = this.parseVarDeclaration("let", this.previous());
      else if (this.match(TokenKind.KW_VAR)) init = this.parseVarDeclaration("var", this.previous());
      else if (this.match(TokenKind.KW_CONST)) init = this.parseVarDeclaration("const", this.previous());
      else {
        const expr = this.parseExpression();
        init = {
          kind: "ExpressionStatement",
          range: expr.range,
          expression: expr,
        } as ExpressionStatement;
      }
    }
    this.expect(TokenKind.SEMICOLON, "Expected ';' after for-init.");

    // test
    let test: Expression | null = null;
    this.skipNewlines();
    if (!this.is(TokenKind.SEMICOLON)) {
      test = this.parseExpression();
    }
    this.expect(TokenKind.SEMICOLON, "Expected ';' after for-test.");

    // update
    let update: Expression | null = null;
    this.skipNewlines();
    if (!this.is(TokenKind.RPAREN)) {
      update = this.parseExpression();
    }
    const closeParen = this.expect(TokenKind.RPAREN, "Expected ')' after for-update.");

    const body = this.parseBlockStatement("Expected '{' after for(...).");

    return {
      kind: "ForStatement",
      range: { start: kwTok.range.start, end: body.range.end },
      init,
      test,
      update,
      body,
    };
  }

  private parseForEachStatement(kwTok: TokenBase): ForEachStatement {
    this.expect(TokenKind.LPAREN, "Expected '(' after 'forEach'.");

    const itemTok = this.expectIdentifierLike("Expected loop variable name in forEach.");
    const item: Identifier = this.makeIdentifier(itemTok);

    this.expect(TokenKind.KW_IN, "Expected 'in' in forEach (forEach (item in iterable)).");

    const iterable = this.parseExpression();
    this.expect(TokenKind.RPAREN, "Expected ')' after forEach(...)");

    const body = this.parseBlockStatement("Expected '{' after forEach(...).");

    return {
      kind: "ForEachStatement",
      range: { start: kwTok.range.start, end: body.range.end },
      item,
      iterable,
      body,
    };
  }

  private parseTryStatement(kwTok: TokenBase): TryStatement {
    const block = this.parseBlockStatement("Expected '{' after 'try'.");

    let handler: any | null = null;
    if (this.match(TokenKind.KW_CATCH)) {
      const catchTok = this.previous();

      let param: Identifier | null = null;
      if (this.match(TokenKind.LPAREN)) {
        if (!this.is(TokenKind.RPAREN)) {
          const pTok = this.expectIdentifierLike("Expected catch parameter name.");
          param = this.makeIdentifier(pTok);
        }
        this.expect(TokenKind.RPAREN, "Expected ')' after catch(...).");
      }

      const body = this.parseBlockStatement("Expected '{' after catch.");
      handler = {
        kind: "TryStatement",
        range: { start: catchTok.range.start, end: body.range.end },
        _clause: "CatchClause",
        param,
        body,
      };
    }

    let finalizer: BlockStatement | null = null;
    if (this.match(TokenKind.KW_FINALLY)) {
      finalizer = this.parseBlockStatement("Expected '{' after finally.");
    }

    const end = finalizer
      ? finalizer.range.end
      : handler
        ? handler.range.end
        : block.range.end;

    return {
      kind: "TryStatement",
      range: { start: kwTok.range.start, end },
      block,
      handler,
      finalizer,
    };
  }

  private parseFunctionDeclaration(isAsync: boolean, funcTok: TokenBase): FunctionDeclaration {
    const nameTok = this.expectIdentifierLike("Expected function name.");
    const name = this.makeIdentifier(nameTok);

    const params = this.parseParamList();
    const body = this.parseBlockStatement("Expected '{' after function signature.");

    return {
      kind: "FunctionDeclaration",
      range: { start: (isAsync ? funcTok.range.start : funcTok.range.start), end: body.range.end },
      name,
      params,
      body,
      isAsync,
    };
  }

  private parseReturnStatement(kwTok: TokenBase): ReturnStatement {
    // return can be followed by expression or end of statement
    if (this.isStatementTerminator(this.current().kind)) {
      return {
        kind: "ReturnStatement",
        range: { start: kwTok.range.start, end: kwTok.range.end },
        argument: null,
      };
    }

    const arg = this.parseExpression({ allowBareTemplate: true });
    this.match(TokenKind.SEMICOLON);

    return {
      kind: "ReturnStatement",
      range: { start: kwTok.range.start, end: arg.range.end },
      argument: arg,
    };
  }

  private parseThrowStatement(kwTok: TokenBase): ThrowStatement {
    const arg = this.parseExpression({ allowBareTemplate: true });
    this.match(TokenKind.SEMICOLON);

    return {
      kind: "ThrowStatement",
      range: { start: kwTok.range.start, end: arg.range.end },
      argument: arg,
    };
  }

  private makeSimpleStatement(kind: "BreakStatement" | "ContinueStatement", kwTok: TokenBase): Statement {
    this.match(TokenKind.SEMICOLON);
    return { kind, range: kwTok.range } as any;
  }

  /* =========================================================
     Conditions
     ========================================================= */

  private parseConditionExpression(): Expression {
    // Prefer parentheses: if ( ... )
    this.skipNewlines();

    if (this.match(TokenKind.LPAREN)) {
      const open = this.previous();
      const expr = this.parseExpression();
      const close = this.expect(TokenKind.RPAREN, "Expected ')' after condition.");
      // Keep condition expression as-is; range already covers tokens inside
      // but we can widen it if desired. We keep the expression range.
      void open; void close;
      return expr;
    }

    // Fallback: parse expression until '{' (heuristic)
    // This allows "if l.dog !isBoolean { ... }" style.
    const expr = this.parseExpression();
    return expr;
  }

  private parseBlockStatement(msgIfMissing: string): BlockStatement {
    this.skipNewlines();
    if (this.match(TokenKind.LBRACE)) {
      return this.parseBlockFromOpenedBrace(this.previous());
    }
    this.errorAtCurrent(msgIfMissing);
    // Recovery: create empty block
    const here = this.current().range.start;
    return {
      kind: "BlockStatement",
      range: { start: here, end: here },
      body: [],
    };
  }

  /* =========================================================
     Expressions (Pratt / precedence climbing)
     ========================================================= */

  private parseExpression(opts?: { allowBareTemplate?: boolean }): Expression {
    return this.parseAssignment(opts);
  }

  private parseAssignment(opts?: { allowBareTemplate?: boolean }): Expression {
    const expr = this.parseBinary(0, opts);

    if (this.match(TokenKind.ASSIGN)) {
      const opTok = this.previous();
      const rhs = this.parseAssignment(opts);

      // Ensure LHS is assignable
      if (!this.isAssignable(expr)) {
        this.errorAt(opTok.range, "Left-hand side of assignment is not assignable.");
        // Still build node for tooling
      }

      const node: AssignmentExpression = {
        kind: "AssignmentExpression",
        range: { start: expr.range.start, end: rhs.range.end },
        operator: "=",
        left: expr as any,
        right: rhs,
      };
      return node;
    }

    return expr;
  }

  private parseBinary(minPrec: number, opts?: { allowBareTemplate?: boolean }): Expression {
    let left = this.parseUnary(opts);

    // Postfix boolean checks: expr ?isBoolean(.t/.f) | expr !isBoolean(.t/.f)
    left = this.parsePostfixBoolCheck(left);

    while (true) {
      const opInfo = this.getBinaryOpInfo();
      if (!opInfo) break;
      if (opInfo.precedence < minPrec) break;

      // consume operator
      const opTok = this.advance();

      const nextMinPrec = opInfo.assoc === "left" ? opInfo.precedence + 1 : opInfo.precedence;
      let right = this.parseBinary(nextMinPrec, opts);
      right = this.parsePostfixBoolCheck(right);

      left = {
        kind: "BinaryExpression",
        range: { start: left.range.start, end: right.range.end },
        operator: opInfo.op,
        left,
        right,
      } as BinaryExpression;
    }

    return left;
  }

  private parseUnary(opts?: { allowBareTemplate?: boolean }): Expression {
    this.skipNewlines();

    // await
    if (this.match(TokenKind.KW_AWAIT)) {
      const kw = this.previous();
      const arg = this.parseUnary(opts);
      return {
        kind: "AwaitExpression",
        range: { start: kw.range.start, end: arg.range.end },
        argument: arg,
      } as AwaitExpression;
    }

    // unary operators
    if (this.match(TokenKind.NOT)) {
      const op = this.previous();
      const arg = this.parseUnary(opts);
      return {
        kind: "UnaryExpression",
        range: { start: op.range.start, end: arg.range.end },
        operator: "!",
        argument: arg,
      } as UnaryExpression;
    }

    if (this.match(TokenKind.PLUS)) {
      const op = this.previous();
      const arg = this.parseUnary(opts);
      return {
        kind: "UnaryExpression",
        range: { start: op.range.start, end: arg.range.end },
        operator: "+",
        argument: arg,
      } as UnaryExpression;
    }

    if (this.match(TokenKind.MINUS)) {
      const op = this.previous();
      const arg = this.parseUnary(opts);
      return {
        kind: "UnaryExpression",
        range: { start: op.range.start, end: arg.range.end },
        operator: "-",
        argument: arg,
      } as UnaryExpression;
    }

    // primary + postfix (member/call) + arrow functions
    return this.parsePostfix(opts);
  }

  private parsePostfix(opts?: { allowBareTemplate?: boolean }): Expression {
    // Arrow with single param: n => ...
    if (this.is(TokenKind.IDENTIFIER) && this.peekKind(1) === TokenKind.ARROW) {
      const pTok = this.advance() as IdentifierToken;
      const param: FunctionParameter = { name: this.makeIdentifier(pTok), defaultValue: null, isRest: false };

      const arrowTok = this.expect(TokenKind.ARROW, "Expected '=>' in arrow function.");
      const body = this.parseArrowBody();
      const end = (body as any).range.end;

      void arrowTok;
      return {
        kind: "ArrowFunctionExpression",
        range: { start: pTok.range.start, end },
        params: [param],
        body,
        isAsync: false,
      } as ArrowFunctionExpression;
    }

    // Arrow with (params) => ...
    if (this.is(TokenKind.LPAREN) && this.looksLikeArrowFromParen()) {
      const open = this.advance(); // (
      const params = this.parseParamListInsideParens(open.range.start);
      const arrowTok = this.expect(TokenKind.ARROW, "Expected '=>' after arrow parameters.");
      const body = this.parseArrowBody();

      void arrowTok;
      return {
        kind: "ArrowFunctionExpression",
        range: { start: open.range.start, end: (body as any).range.end },
        params,
        body,
        isAsync: false,
      } as ArrowFunctionExpression;
    }

    // Function expression: "async func ..." or "func ..."
    if (this.is(TokenKind.KW_ASYNC) && this.peekKind(1) === TokenKind.KW_FUNC) {
      const asyncTok = this.advance();
      const funcTok = this.advance();
      const fn = this.parseFunctionExpression(true, funcTok);
      // widen start to async
      fn.range = { start: asyncTok.range.start, end: fn.range.end };
      return fn;
    }
    if (this.match(TokenKind.KW_FUNC)) {
      return this.parseFunctionExpression(false, this.previous());
    }

    let expr = this.parsePrimary(opts);

    // member/call chain
    while (true) {
      this.skipNewlines();

      if (this.match(TokenKind.DOT)) {
        const dot = this.previous();
        const key = this.parsePropertyKeyAfterDot(dot.range.start);
        const end = key.range.end;

        expr = {
          kind: "MemberExpression",
          range: { start: expr.range.start, end },
          object: expr,
          property: key,
          computed: false,
        } as MemberExpression;
        continue;
      }

      if (this.match(TokenKind.LPAREN)) {
        const open = this.previous();
        const args = this.parseCallArguments(open.range.start);
        const close = this.expect(TokenKind.RPAREN, "Expected ')' after call arguments.");

        expr = {
          kind: "CallExpression",
          range: { start: expr.range.start, end: close.range.end },
          callee: expr,
          args,
        } as CallExpression;
        continue;
      }

      break;
    }

    // postfix boolean checks after member/call chain too
    expr = this.parsePostfixBoolCheck(expr);

    return expr;
  }

  private parsePrimary(opts?: { allowBareTemplate?: boolean }): Expression {
    this.skipNewlines();

    const t = this.current();

    // Bare template string as an expression (heuristic)
    if (opts?.allowBareTemplate && this.shouldParseBareTemplateExpression()) {
      const tpl = this.parseBareTemplateUntilTerminator();
      return tpl;
    }

    if (this.match(TokenKind.NUMBER)) {
      const tok = this.previous() as NumberToken;
      return {
        kind: "NumberLiteral",
        range: tok.range,
        value: tok.value,
        raw: tok.raw,
      } as NumberLiteral;
    }

    if (this.match(TokenKind.DURATION)) {
      const tok = this.previous() as DurationToken;
      return {
        kind: "DurationLiteral",
        range: tok.range,
        value: tok.value,
        unit: tok.unit as DurationUnit,
        raw: tok.raw,
      } as DurationLiteral;
    }

    if (this.match(TokenKind.STRING)) {
      const tok = this.previous() as StringToken;
      return this.stringLiteralFromToken(tok);
    }

    if (this.match(TokenKind.TRUE)) {
      const tok = this.previous();
      return { kind: "BooleanLiteral", range: tok.range, value: true } as BooleanLiteral;
    }
    if (this.match(TokenKind.FALSE)) {
      const tok = this.previous();
      return { kind: "BooleanLiteral", range: tok.range, value: false } as BooleanLiteral;
    }

    // null literal (optional future): not in lexer; accept identifier "null"
    if (this.isIdentifierLexeme("null")) {
      const tok = this.advance();
      return { kind: "NullLiteral", range: tok.range, value: null } as NullLiteral;
    }

    // Namespaced identifier: l.<name> / v.<name> / c.<name>
    if (this.is(TokenKind.IDENTIFIER) && this.isNamespacePrefix(this.currentLexeme()) && this.peekKind(1) === TokenKind.DOT) {
      return this.parseNamespacedIdentifier();
    }

    // Identifier
    if (this.match(TokenKind.IDENTIFIER)) {
      const tok = this.previous() as IdentifierToken;
      return this.makeIdentifier(tok);
    }

    // Parenthesized expression
    if (this.match(TokenKind.LPAREN)) {
      const open = this.previous();
      const expr = this.parseExpression({ allowBareTemplate: false });
      const close = this.expect(TokenKind.RPAREN, "Expected ')' after expression.");
      // widen range to include parentheses (optional)
      expr.range = { start: open.range.start, end: close.range.end };
      return expr;
    }

    // Object literal
    if (this.match(TokenKind.LBRACE)) {
      return this.parseObjectLiteral(this.previous());
    }

    // Array literal
    if (this.match(TokenKind.LBRACKET)) {
      return this.parseArrayLiteral(this.previous());
    }

    // Error token or unknown
    this.errorAtCurrent("Unexpected token in expression.");
    // Recovery: consume one token and create dummy identifier
    const bad = this.advance();
    return {
      kind: "Identifier",
      range: bad.range,
      name: "__error__",
    } as Identifier;
  }

  /* =========================================================
     Arrow helpers
     ========================================================= */

  private looksLikeArrowFromParen(): boolean {
    // We are at '('
    let i = this.idx;
    if (this.tokens[i]?.kind !== TokenKind.LPAREN) return false;
    i++;

    // scan params: ( [id ( = expr )] (, ...)? ) =>
    // We'll do a conservative scan: allow identifiers, commas, equals, dots, strings/numbers inside defaults,
    // and balanced parens/brackets/braces.
    let depthParen = 1;
    let depthBrace = 0;
    let depthBracket = 0;

    while (i < this.tokens.length) {
      const k = this.tokens[i].kind;

      if (k === TokenKind.LPAREN) depthParen++;
      else if (k === TokenKind.RPAREN) {
        depthParen--;
        if (depthParen === 0) {
          // next non-newline token must be ARROW
          let j = i + 1;
          while (this.tokens[j] && this.tokens[j].kind === TokenKind.NEWLINE) j++;
          return this.tokens[j]?.kind === TokenKind.ARROW;
        }
      } else if (k === TokenKind.LBRACE) depthBrace++;
      else if (k === TokenKind.RBRACE) depthBrace = Math.max(0, depthBrace - 1);
      else if (k === TokenKind.LBRACKET) depthBracket++;
      else if (k === TokenKind.RBRACKET) depthBracket = Math.max(0, depthBracket - 1);

      // If braces/brackets show up in param list defaults, we still keep scanning.
      i++;
    }

    return false;
  }

  private parseParamList(): FunctionParameter[] {
    const open = this.expect(TokenKind.LPAREN, "Expected '(' for parameter list.");
    return this.parseParamListInsideParens(open.range.start);
  }

  private parseParamListInsideParens(openPos: Position): FunctionParameter[] {
    const params: FunctionParameter[] = [];

    this.skipNewlines();
    if (this.match(TokenKind.RPAREN)) {
      // empty
      return params;
    }

    while (!this.isAtEnd() && !this.is(TokenKind.RPAREN)) {
      this.skipNewlines();

      const nameTok = this.expectIdentifierLike("Expected parameter name.");
      const name = this.makeIdentifier(nameTok);

      let defaultValue: Expression | null = null;
      if (this.match(TokenKind.ASSIGN)) {
        defaultValue = this.parseExpression();
      }

      params.push({ name, defaultValue, isRest: false });

      this.skipNewlines();
      if (!this.match(TokenKind.COMMA)) break;
    }

    const close = this.expect(TokenKind.RPAREN, "Expected ')' after parameter list.");
    void openPos;
    void close;
    return params;
  }

  private parseArrowBody(): BlockStatement | Expression {
    this.skipNewlines();
    if (this.match(TokenKind.LBRACE)) {
      return this.parseBlockFromOpenedBrace(this.previous());
    }
    return this.parseExpression({ allowBareTemplate: true });
  }

  private parseFunctionExpression(isAsync: boolean, funcTok: TokenBase): FunctionExpression {
    // name optional
    let name: Identifier | null = null;
    if (this.is(TokenKind.IDENTIFIER)) {
      // If the next token is '(', treat as function name
      if (this.peekKind(1) === TokenKind.LPAREN) {
        name = this.makeIdentifier(this.advance() as IdentifierToken);
      }
    }

    const params = this.parseParamList();
    const body = this.parseBlockStatement("Expected '{' after function expression signature.");

    return {
      kind: "FunctionExpression",
      range: { start: funcTok.range.start, end: body.range.end },
      name,
      params,
      body,
      isAsync,
    };
  }

  /* =========================================================
     Postfix boolean checks
     ========================================================= */

  private parsePostfixBoolCheck(subject: Expression): Expression {
    this.skipNewlines();

    if (this.is(TokenKind.BOOL_Q_ISBOOLEAN) || this.is(TokenKind.BOOL_NOT_ISBOOLEAN)) {
      const opTok = this.advance();
      const force = this.tryReadBoolForceSuffix();

      const node: BooleanOpExpression = {
        kind: "BooleanOpExpression",
        range: {
          start: subject.range.start,
          end: force === null ? opTok.range.end : this.previous().range.end,
        },
        subject,
        op: "query",
        negate: opTok.kind === TokenKind.BOOL_NOT_ISBOOLEAN,
        force,
      };
      return node;
    }

    return subject;
  }

  private tryReadBoolForceSuffix(): boolean | null {
    // reads ".t" or ".f" after a boolean operator token or "isBoolean" identifier
    // returns true/false or null if not present
    const save = this.idx;
    this.skipNewlines();

    if (!this.match(TokenKind.DOT)) {
      this.idx = save;
      return null;
    }

    const nameTok = this.current();
    const name = this.propertyNameLexeme(nameTok);
    if (!name) {
      this.idx = save;
      return null;
    }

    // only accept t/f
    if (name !== "t" && name !== "f") {
      this.idx = save;
      return null;
    }

    this.advance();
    return name === "t";
  }

  /* =========================================================
     Namespaced identifiers & property keys
     ========================================================= */

  private parseNamespacedIdentifier(): NamespacedIdentifier {
    const nsTok = this.advance() as IdentifierToken;
    const ns = nsTok.value as VarNamespace;

    this.expect(TokenKind.DOT, "Expected '.' after namespace.");

    // optional escape for extreme names: v.\v
    let escaped = false;
    if (this.match(TokenKind.BACKSLASH)) escaped = true;

    const nameTok = this.expectIdentifierLike("Expected identifier after namespace prefix.");
    const name = this.makeIdentifier(nameTok);
    // note: we ignore escaped flag for namespaced variable names at AST level (you can add it later if you want)
    void escaped;

    const end = name.range.end;

    return {
      kind: "NamespacedIdentifier",
      range: { start: nsTok.range.start, end },
      namespace: ns,
      name,
    };
  }

  private parsePropertyKeyAfterDot(dotStart: Position): PropertyKey {
    this.skipNewlines();

    let escaped = false;
    if (this.match(TokenKind.BACKSLASH)) escaped = true;

    const t = this.current();
    const name = this.propertyNameLexeme(t);

    if (!name) {
      this.errorAtCurrent("Expected property name after '.'.");
      // recovery: synthesize key
      const p = this.current().range.start;
      return { name: "__error__", escaped, range: { start: dotStart, end: p } };
    }

    const tok = this.advance();
    return {
      name,
      escaped,
      range: { start: dotStart, end: tok.range.end },
    };
  }

  private propertyNameLexeme(t: Token): string | null {
    // allow identifier OR keywords used as identifiers (like ".async")
    if (t.kind === TokenKind.IDENTIFIER) return (t as IdentifierToken).value;

    // keywords-as-property: use lexeme
    const kwAsText = this.keywordAsText(t.kind);
    if (kwAsText) return kwAsText;

    if (t.kind === TokenKind.TRUE) return "True";
    if (t.kind === TokenKind.FALSE) return "False";

    return null;
  }

  private keywordAsText(k: TokenKind): string | null {
    switch (k) {
      case TokenKind.KW_ASYNC:
        return "async";
      case TokenKind.KW_AWAIT:
        return "await";
      case TokenKind.KW_FUNC:
        return "func";
      case TokenKind.KW_RETURN:
        return "return";
      case TokenKind.KW_THROW:
        return "throw";
      case TokenKind.KW_TRY:
        return "try";
      case TokenKind.KW_CATCH:
        return "catch";
      case TokenKind.KW_FINALLY:
        return "finally";
      case TokenKind.KW_IF:
        return "if";
      case TokenKind.KW_ELSE:
        return "else";
      case TokenKind.KW_ELIF:
        return "elif";
      case TokenKind.KW_FOR:
        return "for";
      case TokenKind.KW_FOREACH:
        return "forEach";
      case TokenKind.KW_WHILE:
        return "while";
      case TokenKind.KW_DO:
        return "do";
      case TokenKind.KW_IN:
        return "in";
      case TokenKind.KW_LET:
        return "let";
      case TokenKind.KW_VAR:
        return "var";
      case TokenKind.KW_CONST:
        return "const";
      case TokenKind.KW_DISABLE:
        return "disable";
      case TokenKind.KW_ABLE:
        return "able";
      default:
        return null;
    }
  }

  /* =========================================================
     Call arguments
     ========================================================= */

  private parseCallArguments(openPos: Position): CallArgument[] {
    const args: CallArgument[] = [];

    this.skipNewlines();

    if (this.is(TokenKind.RPAREN)) return args;

    while (!this.isAtEnd() && !this.is(TokenKind.RPAREN)) {
      this.skipNewlines();

      // Named arg detection: lower-case identifier + ':' (avoid stealing "Errore: {..}" as named arg)
      if (this.is(TokenKind.IDENTIFIER) && this.peekKind(1) === TokenKind.COLON) {
        const nameTok = this.current() as IdentifierToken;
        const looksNamed = /^[a-z_]/.test(nameTok.value);

        if (looksNamed) {
          this.advance(); // name
          const colon = this.advance(); // :
          const value = this.parseExpression({ allowBareTemplate: true });

          const arg: NamedArgument = {
            kind: "NamedArgument",
            name: this.makeIdentifier(nameTok),
            value,
            range: { start: nameTok.range.start, end: value.range.end },
          };
          void colon;
          args.push(arg);
        } else {
          // treat as bare template (e.g. "Errore: {x}")
          const value = this.parseExpression({ allowBareTemplate: true });
          args.push({
            kind: "PositionalArgument",
            value,
            range: value.range,
          } as PositionalArgument);
        }
      } else {
        const value = this.parseExpression({ allowBareTemplate: true });
        args.push({
          kind: "PositionalArgument",
          value,
          range: value.range,
        } as PositionalArgument);
      }

      this.skipNewlines();
      if (!this.match(TokenKind.COMMA)) break;
    }

    void openPos;
    return args;
  }

  /* =========================================================
     Object & Array literals
     ========================================================= */

  private parseObjectLiteral(open: TokenBase): ObjectLiteral {
    const properties: any[] = [];

    this.skipSeparators();

    while (!this.isAtEnd() && !this.is(TokenKind.RBRACE)) {
      this.skipSeparators();

      // key
      const key = this.parseObjectKey();

      // separator: '=' or ':'
      if (!(this.match(TokenKind.ASSIGN) || this.match(TokenKind.COLON))) {
        this.errorAtCurrent("Expected '=' or ':' in object property.");
        // try recover: if next is RBRACE, stop
        if (this.is(TokenKind.RBRACE)) break;
      }

      // value
      const value = this.parseExpression({ allowBareTemplate: true });

      properties.push({
        key,
        value,
        range: { start: key.range.start, end: value.range.end },
      });

      // optional separators between properties
      this.skipSeparators();
      this.match(TokenKind.COMMA);
      this.skipSeparators();
    }

    const close = this.expect(TokenKind.RBRACE, "Expected '}' to close object literal.");
    return {
      kind: "ObjectLiteral",
      range: { start: open.range.start, end: close.range.end },
      properties,
    };
  }

  private parseObjectKey(): PropertyKey {
    this.skipNewlines();

    const start = this.current().range.start;

    let escaped = false;
    if (this.match(TokenKind.BACKSLASH)) escaped = true;

    const t = this.current();

    // string key
    if (this.match(TokenKind.STRING)) {
      const s = this.previous() as StringToken;
      return {
        name: s.value,
        escaped,
        range: { start, end: s.range.end },
      };
    }

    // identifier / keyword key
    const name = this.propertyNameLexeme(t);
    if (name) {
      const tok = this.advance();
      return {
        name,
        escaped,
        range: { start, end: tok.range.end },
      };
    }

    this.errorAtCurrent("Expected object property key.");
    const bad = this.advance();
    return {
      name: "__error__",
      escaped,
      range: { start, end: bad.range.end },
    };
  }

  private parseArrayLiteral(open: TokenBase): ArrayLiteral {
    const elements: Expression[] = [];

    this.skipSeparators();

    while (!this.isAtEnd() && !this.is(TokenKind.RBRACKET)) {
      this.skipSeparators();

      const el = this.parseExpression({ allowBareTemplate: true });
      elements.push(el);

      this.skipSeparators();
      if (!this.match(TokenKind.COMMA)) break;
      this.skipSeparators();
    }

    const close = this.expect(TokenKind.RBRACKET, "Expected ']' to close array literal.");
    return {
      kind: "ArrayLiteral",
      range: { start: open.range.start, end: close.range.end },
      elements,
    };
  }

  /* =========================================================
     Bare template expressions (heuristic)
     ========================================================= */

  private shouldParseBareTemplateExpression(): boolean {
    // We treat it as bare template when we see tokens that are not typical expression starts,
    // or when the sequence looks like raw text (IDENT IDENT / ERROR / '>>' tokens etc),
    // OR when we see an interpolation brace '{' before a statement terminator.
    const k = this.current().kind;

    if (k === TokenKind.ERROR) return true;
    if (k === TokenKind.GT || k === TokenKind.LT) return true;
    if (k === TokenKind.COLON) return true;

    // If there is an interpolation brace ahead before a terminator, favor template
    const until = this.findExpressionTerminatorIndex();
    for (let i = this.idx; i < until; i++) {
      const kk = this.tokens[i].kind;
      if (kk === TokenKind.LBRACE) return true;
      if (kk === TokenKind.ERROR) return true;
    }

    // IDENT IDENT (raw words) tends to be prompt text: inp(Hello world)
    if (k === TokenKind.IDENTIFIER) {
      const k2 = this.peekKind(1);
      // Avoid catching common expression patterns: Ident.Ident / Ident(...)
      if (k2 === TokenKind.DOT || k2 === TokenKind.LPAREN) return false;
      if (k2 === TokenKind.IDENTIFIER || k2 === TokenKind.ERROR || k2 === TokenKind.GT || k2 === TokenKind.LT) {
        return true;
      }
    }

    return false;
  }

  private parseBareTemplateUntilTerminator(): TemplateString {
    // Terminator depends on context:
    // - If used in call args: terminator is ',' or ')'
    // - If used at statement level: terminator is NEWLINE, ';', '}', EOF
    //
    // This function uses a generic terminator scan based on token nesting depth.

    const startTok = this.current();
    const startOffset = startTok.range.start.offset;

    const parts: (TemplateTextPart | TemplateExprPart)[] = [];

    let lastTextOffset = startOffset;
    const startPos = startTok.range.start;

    const isArgTerminator = (k: TokenKind) => k === TokenKind.COMMA || k === TokenKind.RPAREN;
    const isStmtTerminator = (k: TokenKind) =>
      k === TokenKind.NEWLINE || k === TokenKind.SEMICOLON || k === TokenKind.RBRACE || k === TokenKind.EOF;

    // We stop at whichever terminator occurs first for the current context:
    // If we are inside call args, ')' or ',' will appear before newline or ';' typically.
    const stopAt = (k: TokenKind) => isArgTerminator(k) || isStmtTerminator(k);

    while (!this.isAtEnd() && !stopAt(this.current().kind)) {
      // Interpolation: { expression }
      if (this.match(TokenKind.LBRACE)) {
        const braceOpen = this.previous();
        const braceStart = braceOpen.range.start.offset;

        // Emit text part before '{'
        if (braceStart > lastTextOffset) {
          const text = this.sliceSource(lastTextOffset, braceStart);
          parts.push({
            kind: "TemplateTextPart",
            text,
            range: this.rangeFromOffsets(lastTextOffset, braceStart, startPos),
          });
        }

        // Parse expression until '}'
        const expr = this.parseExpression({ allowBareTemplate: false });
        const close = this.expect(TokenKind.RBRACE, "Expected '}' to close template expression.");

        parts.push({
          kind: "TemplateExprPart",
          expression: expr,
          range: { start: braceOpen.range.start, end: close.range.end },
        });

        lastTextOffset = close.range.end.offset;
        continue;
      }

      // Otherwise just consume token as raw text
      this.advance();
    }

    const endOffset = this.previous().range.end.offset;
    if (endOffset > lastTextOffset) {
      const text = this.sliceSource(lastTextOffset, endOffset);
      parts.push({
        kind: "TemplateTextPart",
        text,
        range: this.rangeFromOffsets(lastTextOffset, endOffset, startPos),
      });
    }

    const endPos = this.previous().range.end;
    return {
      kind: "TemplateString",
      range: { start: startTok.range.start, end: endPos },
      quote: "'",
      parts,
    };
  }

  private sliceSource(startOffset: number, endOffset: number): string {
    if (!this.source) return "";
    const a = Math.max(0, Math.min(this.source.length, startOffset));
    const b = Math.max(0, Math.min(this.source.length, endOffset));
    return this.source.slice(a, b);
  }

  private rangeFromOffsets(startOffset: number, endOffset: number, fallbackPos: Position): Range {
    // We only store offsets/line/col from tokens; for freeform slices we approximate:
    // - Use fallback line/col for start, and keep offsets for both.
    // For diagnostics and tooling, offsets are the most important; line/col are “best-effort”.
    return {
      start: { offset: startOffset, line: fallbackPos.line, column: fallbackPos.column },
      end: { offset: endOffset, line: fallbackPos.line, column: fallbackPos.column + Math.max(0, endOffset - startOffset) },
    };
  }

  private findExpressionTerminatorIndex(): number {
    let i = this.idx;
    let depthParen = 0;
    let depthBracket = 0;
    let depthBrace = 0;

    while (i < this.tokens.length) {
      const k = this.tokens[i].kind;

      if (k === TokenKind.LPAREN) depthParen++;
      else if (k === TokenKind.RPAREN) {
        if (depthParen === 0) return i;
        depthParen--;
      } else if (k === TokenKind.LBRACKET) depthBracket++;
      else if (k === TokenKind.RBRACKET) depthBracket = Math.max(0, depthBracket - 1);
      else if (k === TokenKind.LBRACE) depthBrace++;
      else if (k === TokenKind.RBRACE) {
        if (depthBrace === 0) return i;
        depthBrace = Math.max(0, depthBrace - 1);
      }

      if (depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
        if (k === TokenKind.COMMA || k === TokenKind.NEWLINE || k === TokenKind.SEMICOLON || k === TokenKind.EOF) {
          return i;
        }
      }

      i++;
    }

    return this.tokens.length;
  }

  /* =========================================================
     Utilities
     ========================================================= */

  private stringLiteralFromToken(tok: StringToken): StringLiteral {
    return {
      kind: "StringLiteral",
      range: tok.range,
      value: tok.value,
      quote: tok.quote,
    };
  }

  private makeIdentifier(tok: TokenBase): Identifier {
    const name =
      tok.kind === TokenKind.IDENTIFIER
        ? (tok as IdentifierToken).value
        : (tok.lexeme ?? ""); // fallback
    return { kind: "Identifier", range: tok.range, name };
  }

  private current(): Token {
    return this.tokens[this.idx] ?? this.tokens[this.tokens.length - 1];
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.idx - 1)] ?? this.tokens[0];
  }

  private peekKind(ahead: number): TokenKind {
    return (this.tokens[this.idx + ahead] as Token | undefined)?.kind ?? TokenKind.EOF;
  }

  private currentLexeme(): string {
    const t = this.current();
    return t.kind === TokenKind.IDENTIFIER ? (t as IdentifierToken).value : t.lexeme ?? "";
  }

  private isAtEnd(): boolean {
    return this.current().kind === TokenKind.EOF;
  }

  private is(kind: TokenKind): boolean {
    return this.current().kind === kind;
  }

  private match(kind: TokenKind): boolean {
    if (this.is(kind)) {
      this.advance();
      return true;
    }
    return false;
  }

  private advance(): Token {
    if (!this.isAtEnd()) this.idx++;
    return this.previous();
  }

  private expect(kind: TokenKind, message: string): TokenBase {
    if (this.is(kind)) return this.advance();
    this.errorAtCurrent(message);
    // recovery: synthesize token at current position
    const here = this.current().range;
    return { kind, lexeme: "", range: here } as TokenBase;
  }

  private expectIdentifierLike(message: string): TokenBase {
    const t = this.current();

    if (t.kind === TokenKind.IDENTIFIER) return this.advance();
    const asText = this.keywordAsText(t.kind);
    if (asText) return this.advance();

    this.errorAtCurrent(message);
    return this.advance();
  }

  private errorAtCurrent(message: string): void {
    this.errorAt(this.current().range, message);
    this.synchronize();
  }

  private errorAt(range: Range, message: string): void {
    this.errors.push({ message, range });
  }

  private synchronize(): void {
    // Move forward until we hit a likely statement boundary.
    while (!this.isAtEnd()) {
      const k = this.current().kind;
      if (k === TokenKind.NEWLINE || k === TokenKind.SEMICOLON || k === TokenKind.RBRACE) return;
      this.advance();
    }
  }

  private skipNewlines(): void {
    while (this.match(TokenKind.NEWLINE)) {
      // keep consuming
    }
  }

  private skipSeparators(): void {
    while (true) {
      const k = this.current().kind;
      if (k === TokenKind.NEWLINE || k === TokenKind.SEMICOLON) {
        this.advance();
        continue;
      }
      break;
    }
  }

  private isStatementTerminator(k: TokenKind): boolean {
    return k === TokenKind.NEWLINE || k === TokenKind.SEMICOLON || k === TokenKind.RBRACE || k === TokenKind.EOF;
  }

  private isNamespacePrefix(s: string): s is VarNamespace {
    return s === "l" || s === "v" || s === "c";
  }

  private isAssignable(expr: Expression): boolean {
    return expr.kind === "Identifier" || expr.kind === "NamespacedIdentifier" || expr.kind === "MemberExpression";
  }

  private rewindTo(tok: TokenBase): void {
    // Find token index by exact offset match (best effort).
    const target = tok.range.start.offset;
    for (let i = 0; i < this.tokens.length; i++) {
      if (this.tokens[i].range.start.offset === target) {
        this.idx = i;
        return;
      }
    }
  }

  private isIdentifierLexeme(name: string): boolean {
    return this.current().kind === TokenKind.IDENTIFIER && (this.current() as IdentifierToken).value === name;
  }

  private getBinaryOpInfo(): BinOpInfo | null {
    const k = this.current().kind;

    // IMPORTANT: lexer may tokenize "x" as IDENTIFIER; treat IDENTIFIER("x") as MUL operator in binary position.
    if (k === TokenKind.IDENTIFIER && (this.current() as IdentifierToken).value === "x") {
      return { precedence: 6, assoc: "left", op: "x" };
    }

    return BIN_OP_TABLE[k] ?? null;
  }

  /* =========================================================
     Assignment statement lookahead (limited)
     ========================================================= */

  private tryParseAssignableLookahead(): Expression | null {
    // Parse an assignable expression (Identifier / NamespacedIdentifier / MemberExpression) without calls.
    // If it fails, do not consume tokens.

    const save = this.idx;

    try {
      // Namespaced
      if (
        this.is(TokenKind.IDENTIFIER) &&
        this.isNamespacePrefix(this.currentLexeme()) &&
        this.peekKind(1) === TokenKind.DOT
      ) {
        let expr: Expression = this.parseNamespacedIdentifier();

        // allow member chain: l.var.prop
        while (this.match(TokenKind.DOT)) {
          const dot = this.previous();
          const key = this.parsePropertyKeyAfterDot(dot.range.start);
          expr = {
            kind: "MemberExpression",
            range: { start: expr.range.start, end: key.range.end },
            object: expr,
            property: key,
            computed: false,
          } as MemberExpression;
        }

        return expr;
      }

      // Identifier + member chain (no calls)
      if (this.is(TokenKind.IDENTIFIER)) {
        let expr: Expression = this.makeIdentifier(this.advance() as IdentifierToken);

        while (this.match(TokenKind.DOT)) {
          const dot = this.previous();
          const key = this.parsePropertyKeyAfterDot(dot.range.start);
          expr = {
            kind: "MemberExpression",
            range: { start: expr.range.start, end: key.range.end },
            object: expr,
            property: key,
            computed: false,
          } as MemberExpression;
        }

        return expr;
      }

      return null;
    } catch {
      this.idx = save;
      return null;
    } finally {
      // If next is not '=', we may still need to rewind to start for expression parsing.
      // Caller handles that.
    }
  }
}
