// src/core/lexer.ts
//
// Forge Lexer (Tokenizer)
// -----------------------
// Converts raw source text into a stream of tokens with precise source ranges.
//
// Key Forge syntax supported:
// - Directives: disable 'AllInOne';  |  able 'Math', 'Time', 'Sys'
// - Comments: // line, /* block */, ** block **
// - Strings: 'single' and "double" with escapes (\" \' \\ \n \t)
// - Numbers: 123, 12.34
// - Durations: 1s, 0.5s, 200ms, 3m, 1h
// - Operators: = == === != !== < <= > >= + - x / % § && || !
// - Punctuation: ( ) { } [ ] , ; . :
// - Namespaces: l. v. c.
// - Escaped member keys: v.\v.dog  (backslash before identifier)
// - Arrow: =>
//
// Notes:
// - Newlines are emitted as tokens by default (useful for statement separation).
// - Whitespace and comments are skipped by default but can be included via options.
// - String interpolation `{ ... }` is NOT tokenized here (it remains part of the string literal).
//   The parser can later transform string literals into TemplateString nodes if desired.

import type { Position, Range } from "./ast";

/* =========================================================
   Token Kinds
   ========================================================= */

export enum TokenKind {
  // Meta
  EOF = "EOF",
  ERROR = "ERROR",

  // Trivia
  WHITESPACE = "WHITESPACE",
  NEWLINE = "NEWLINE",
  COMMENT_LINE = "COMMENT_LINE",
  COMMENT_BLOCK = "COMMENT_BLOCK",

  // Literals
  IDENTIFIER = "IDENTIFIER",
  STRING = "STRING",
  NUMBER = "NUMBER",
  DURATION = "DURATION",

  // Keywords
  KW_DISABLE = "KW_DISABLE",
  KW_ABLE = "KW_ABLE",
  KW_LET = "KW_LET",
  KW_VAR = "KW_VAR",
  KW_CONST = "KW_CONST",
  KW_IF = "KW_IF",
  KW_ELIF = "KW_ELIF",
  KW_ELSE = "KW_ELSE",
  KW_FOR = "KW_FOR",
  KW_FOREACH = "KW_FOREACH",
  KW_IN = "KW_IN",
  KW_WHILE = "KW_WHILE",
  KW_DO = "KW_DO",
  KW_BREAK = "KW_BREAK",
  KW_CONTINUE = "KW_CONTINUE",
  KW_TRY = "KW_TRY",
  KW_CATCH = "KW_CATCH",
  KW_FINALLY = "KW_FINALLY",
  KW_THROW = "KW_THROW",
  KW_RETURN = "KW_RETURN",
  KW_FUNC = "KW_FUNC",
  KW_ASYNC = "KW_ASYNC",
  KW_AWAIT = "KW_AWAIT",

  // Booleans
  TRUE = "TRUE",
  FALSE = "FALSE",

  // Special boolean operators (Forge-specific)
  // ?isBoolean , !isBoolean (as a "check" operator)
  BOOL_Q_ISBOOLEAN = "BOOL_Q_ISBOOLEAN",
  BOOL_NOT_ISBOOLEAN = "BOOL_NOT_ISBOOLEAN",

  // Operators
  ASSIGN = "ASSIGN", // =
  EQ = "EQ", // ==
  SEQ = "SEQ", // ===
  NEQ = "NEQ", // !=
  SNEQ = "SNEQ", // !==
  LT = "LT",
  LTE = "LTE",
  GT = "GT",
  GTE = "GTE",
  PLUS = "PLUS",
  MINUS = "MINUS",
  MUL_X = "MUL_X", // x
  DIV = "DIV",
  MOD = "MOD",
  ROOT = "ROOT", // §
  AND = "AND", // &&
  OR = "OR", // ||
  NOT = "NOT", // !
  ARROW = "ARROW", // =>

  // Punctuation
  LPAREN = "LPAREN",
  RPAREN = "RPAREN",
  LBRACE = "LBRACE",
  RBRACE = "RBRACE",
  LBRACKET = "LBRACKET",
  RBRACKET = "RBRACKET",
  COMMA = "COMMA",
  SEMICOLON = "SEMICOLON",
  DOT = "DOT",
  COLON = "COLON",
  BACKSLASH = "BACKSLASH", // \
}

/* =========================================================
   Token Types
   ========================================================= */

export type DurationUnit = "ms" | "s" | "m" | "h";

export type TokenBase = {
  kind: TokenKind;
  lexeme: string;
  range: Range;
};

export type IdentifierToken = TokenBase & {
  kind: TokenKind.IDENTIFIER;
  value: string;
};

export type StringToken = TokenBase & {
  kind: TokenKind.STRING;
  value: string; // unescaped
  quote: "'" | '"';
  raw: string; // raw content inside quotes (without surrounding quotes)
};

export type NumberToken = TokenBase & {
  kind: TokenKind.NUMBER;
  value: number;
  raw: string;
};

export type DurationToken = TokenBase & {
  kind: TokenKind.DURATION;
  value: number;
  unit: DurationUnit;
  raw: string; // e.g. "0.5s"
};

export type ErrorToken = TokenBase & {
  kind: TokenKind.ERROR;
  message: string;
};

export type Token =
  | TokenBase
  | IdentifierToken
  | StringToken
  | NumberToken
  | DurationToken
  | ErrorToken;

/* =========================================================
   Lexer Options
   ========================================================= */

export type LexerOptions = {
  /** Include whitespace tokens (spaces/tabs). Default: false */
  includeWhitespace?: boolean;
  /** Include comment tokens. Default: false */
  includeComments?: boolean;
  /** Emit NEWLINE tokens. Default: true */
  emitNewlines?: boolean;
  /** If true, an unterminated string/comment produces an ERROR token and stops. Default: true */
  stopOnError?: boolean;
};

export const DEFAULT_LEXER_OPTIONS: Required<LexerOptions> = {
  includeWhitespace: false,
  includeComments: false,
  emitNewlines: true,
  stopOnError: true,
};

/* =========================================================
   Lexer Error
   ========================================================= */

export type LexerError = {
  message: string;
  range: Range;
};

export type LexResult = {
  tokens: Token[];
  errors: LexerError[];
};

/* =========================================================
   Core Lexer
   ========================================================= */

export class Lexer {
  private readonly src: string;
  private readonly opts: Required<LexerOptions>;

  private i = 0; // offset
  private line = 0; // 0-based
  private col = 0; // 0-based

  private tokens: Token[] = [];
  private errors: LexerError[] = [];

  constructor(source: string, options?: LexerOptions) {
    this.src = source ?? "";
    this.opts = { ...DEFAULT_LEXER_OPTIONS, ...(options ?? {}) };
  }

  public lex(): LexResult {
    while (!this.isEOF()) {
      const c = this.peek();

      // NEWLINE
      if (c === "\n") {
        this.emitNewline();
        continue;
      }
      if (c === "\r") {
        // normalize CRLF: consume \r and if next is \n, let newline handler consume it
        this.advance();
        continue;
      }

      // WHITESPACE (spaces/tabs)
      if (c === " " || c === "\t") {
        this.lexWhitespace();
        continue;
      }

      // COMMENTS or DIV
      if (c === "/") {
        const next = this.peek(1);
        if (next === "/") {
          this.lexLineComment();
          continue;
        }
        if (next === "*") {
          this.lexBlockCommentSlashStar();
          continue;
        }
        // else it's DIV operator
        this.emitSimple(TokenKind.DIV, "/");
        this.advance();
        continue;
      }

      // BLOCK COMMENT ** ... **
      if (c === "*" && this.peek(1) === "*") {
        this.lexBlockCommentStarStar();
        continue;
      }

      // STRINGS
      if (c === "'" || c === '"') {
        this.lexString(c);
        continue;
      }

      // NUMBERS / DURATIONS
      if (isDigit(c)) {
        this.lexNumberOrDuration();
        continue;
      }

      // IDENTIFIERS / KEYWORDS / TRUE/FALSE / isBoolean operator combos
      if (isIdentStart(c)) {
        this.lexIdentifierOrKeyword();
        continue;
      }

      // SPECIAL BOOL OPS: ?isBoolean / !isBoolean
      if (c === "?" && this.matchIsBoolean(1)) {
        this.lexBoolCheck(TokenKind.BOOL_Q_ISBOOLEAN);
        continue;
      }
      if (c === "!" && this.matchIsBoolean(1)) {
        this.lexBoolCheck(TokenKind.BOOL_NOT_ISBOOLEAN);
        continue;
      }

      // OPERATORS / PUNCTUATION
      if (this.lexOperatorOrPunct()) continue;

      // Unknown char -> error
      this.errorHere(`Unexpected character '${printable(c)}'.`);
      if (this.opts.stopOnError) break;
      this.advance();
    }

    // EOF
    this.tokens.push({
      kind: TokenKind.EOF,
      lexeme: "",
      range: this.rangeAtCurrent(),
    });

    return { tokens: this.tokens, errors: this.errors };
  }

  /* =========================================================
     Basics
     ========================================================= */

  private isEOF(): boolean {
    return this.i >= this.src.length;
  }

  private peek(ahead = 0): string {
    const idx = this.i + ahead;
    if (idx < 0 || idx >= this.src.length) return "\0";
    return this.src[idx];
  }

  private advance(): string {
    const c = this.peek();
    this.i++;

    if (c === "\n") {
      this.line++;
      this.col = 0;
    } else {
      this.col++;
    }

    return c;
  }

  private position(): Position {
    return { offset: this.i, line: this.line, column: this.col };
  }

  private rangeFrom(start: Position, end: Position): Range {
    return { start, end };
  }

  private rangeAtCurrent(): Range {
    const p = this.position();
    return { start: { ...p }, end: { ...p } };
  }

  private emit(kind: TokenKind, lexeme: string, start: Position, end: Position): TokenBase {
    const tok: TokenBase = { kind, lexeme, range: this.rangeFrom(start, end) };
    this.tokens.push(tok);
    return tok;
  }

  private emitSimple(kind: TokenKind, lexeme: string): void {
    const start = this.position();
    const end = { ...start, offset: start.offset + lexeme.length, column: start.column + lexeme.length };
    this.tokens.push({ kind, lexeme, range: this.rangeFrom(start, end) });
  }

  private errorHere(message: string): void {
    const start = this.position();
    const end = { ...start, offset: start.offset + 1, column: start.column + 1 };
    const range = this.rangeFrom(start, end);
    this.errors.push({ message, range });

    this.tokens.push({
      kind: TokenKind.ERROR,
      lexeme: this.peek(),
      range,
      message,
    } satisfies ErrorToken);
  }

  private addError(message: string, start: Position, end: Position): void {
    const range = this.rangeFrom(start, end);
    this.errors.push({ message, range });

    this.tokens.push({
      kind: TokenKind.ERROR,
      lexeme: this.src.slice(start.offset, end.offset),
      range,
      message,
    } satisfies ErrorToken);
  }

  /* =========================================================
     Trivia
     ========================================================= */

  private emitNewline(): void {
    const start = this.position();
    this.advance(); // consumes \n
    const end = this.position();

    if (this.opts.emitNewlines) {
      this.tokens.push({ kind: TokenKind.NEWLINE, lexeme: "\n", range: this.rangeFrom(start, end) });
    }
  }

  private lexWhitespace(): void {
    const start = this.position();
    let text = "";

    while (!this.isEOF()) {
      const c = this.peek();
      if (c !== " " && c !== "\t") break;
      text += this.advance();
    }

    const end = this.position();

    if (this.opts.includeWhitespace) {
      this.tokens.push({ kind: TokenKind.WHITESPACE, lexeme: text, range: this.rangeFrom(start, end) });
    }
  }

  private lexLineComment(): void {
    const start = this.position();
    // consume "//"
    this.advance();
    this.advance();

    let text = "//";
    while (!this.isEOF()) {
      const c = this.peek();
      if (c === "\n" || c === "\r") break;
      text += this.advance();
    }

    const end = this.position();

    if (this.opts.includeComments) {
      this.tokens.push({ kind: TokenKind.COMMENT_LINE, lexeme: text, range: this.rangeFrom(start, end) });
    }
  }

  private lexBlockCommentSlashStar(): void {
    const start = this.position();
    // consume "/*"
    this.advance();
    this.advance();

    let text = "/*";
    while (!this.isEOF()) {
      const c = this.peek();
      if (c === "*" && this.peek(1) === "/") {
        text += this.advance(); // *
        text += this.advance(); // /
        const end = this.position();
        if (this.opts.includeComments) {
          this.tokens.push({ kind: TokenKind.COMMENT_BLOCK, lexeme: text, range: this.rangeFrom(start, end) });
        }
        return;
      }
      text += this.advance();
    }

    // unterminated
    const end = this.position();
    this.addError("Unterminated block comment (expected '*/').", start, end);
    if (this.opts.stopOnError) return;
  }

  private lexBlockCommentStarStar(): void {
    const start = this.position();
    // consume "**"
    this.advance();
    this.advance();

    let text = "**";
    while (!this.isEOF()) {
      const c = this.peek();
      if (c === "*" && this.peek(1) === "*") {
        text += this.advance();
        text += this.advance();
        const end = this.position();
        if (this.opts.includeComments) {
          this.tokens.push({ kind: TokenKind.COMMENT_BLOCK, lexeme: text, range: this.rangeFrom(start, end) });
        }
        return;
      }
      text += this.advance();
    }

    const end = this.position();
    this.addError("Unterminated block comment (expected '**').", start, end);
    if (this.opts.stopOnError) return;
  }

  /* =========================================================
     Strings
     ========================================================= */

  private lexString(quote: "'" | '"'): void {
    const start = this.position();
    this.advance(); // consume opening quote

    let raw = "";
    let value = "";

    while (!this.isEOF()) {
      const c = this.peek();

      if (c === "\n") {
        // allowed: multiline strings. Keep as raw/value.
        raw += this.advance();
        value += "\n";
        continue;
      }

      if (c === quote && !this.isEscaped()) {
        this.advance(); // closing quote
        const end = this.position();

        const lexemeFull = this.src.slice(start.offset, end.offset);
        const tok: StringToken = {
          kind: TokenKind.STRING,
          lexeme: lexemeFull,
          range: this.rangeFrom(start, end),
          value,
          quote,
          raw,
        };
        this.tokens.push(tok);
        return;
      }

      if (c === "\\") {
        raw += this.advance(); // backslash
        if (this.isEOF()) break;
        const esc = this.advance();
        raw += esc;

        const decoded = decodeEscape(esc);
        if (decoded !== null) {
          value += decoded;
        } else {
          // unknown escape: keep literal char
          value += esc;
        }
        continue;
      }

      raw += this.advance();
      value += c;
    }

    // unterminated
    const end = this.position();
    this.addError("Unterminated string literal.", start, end);
    if (this.opts.stopOnError) return;
  }

  private isEscaped(): boolean {
    // Determine if the current char is escaped by counting preceding backslashes
    // Example: \\'  (quote escaped)
    let backslashes = 0;
    for (let j = this.i - 1; j >= 0; j--) {
      if (this.src[j] !== "\\") break;
      backslashes++;
    }
    return backslashes % 2 === 1;
  }

  /* =========================================================
     Numbers / Durations
     ========================================================= */

  private lexNumberOrDuration(): void {
    const start = this.position();
    let raw = "";

    // integer part
    while (isDigit(this.peek())) raw += this.advance();

    // fraction
    if (this.peek() === "." && isDigit(this.peek(1))) {
      raw += this.advance(); // dot
      while (isDigit(this.peek())) raw += this.advance();
    }

    // duration unit (no spaces)
    const unit = this.readDurationUnitIfPresent();
    if (unit) {
      const end = this.position();
      const full = raw + unit;

      const valueNum = Number(raw);
      if (!Number.isFinite(valueNum)) {
        this.addError(`Invalid duration number '${raw}'.`, start, end);
        if (this.opts.stopOnError) return;
      }

      const tok: DurationToken = {
        kind: TokenKind.DURATION,
        lexeme: full,
        range: this.rangeFrom(start, end),
        value: valueNum,
        unit,
        raw: full,
      };
      this.tokens.push(tok);
      return;
    }

    // plain number
    const end = this.position();
    const valueNum = Number(raw);
    if (!Number.isFinite(valueNum)) {
      this.addError(`Invalid number literal '${raw}'.`, start, end);
      if (this.opts.stopOnError) return;
    }

    const tok: NumberToken = {
      kind: TokenKind.NUMBER,
      lexeme: raw,
      range: this.rangeFrom(start, end),
      value: valueNum,
      raw,
    };
    this.tokens.push(tok);
  }

  private readDurationUnitIfPresent(): DurationUnit | null {
    // match longest first: "ms" before "m"
    const a = this.peek();
    const b = this.peek(1);

    if (a === "m" && b === "s") {
      this.advance();
      this.advance();
      return "ms";
    }
    if (a === "s") {
      this.advance();
      return "s";
    }
    if (a === "m") {
      this.advance();
      return "m";
    }
    if (a === "h") {
      this.advance();
      return "h";
    }
    return null;
  }

  /* =========================================================
     Identifiers / Keywords
     ========================================================= */

  private lexIdentifierOrKeyword(): void {
    const start = this.position();
    let text = "";

    text += this.advance();
    while (isIdentPart(this.peek())) text += this.advance();

    const end = this.position();

    // Keywords / Booleans
    const kw = keywordKind(text);
    if (kw) {
      this.tokens.push({ kind: kw, lexeme: text, range: this.rangeFrom(start, end) });
      return;
    }

    // True / False
    if (text === "True") {
      this.tokens.push({ kind: TokenKind.TRUE, lexeme: text, range: this.rangeFrom(start, end) });
      return;
    }
    if (text === "False") {
      this.tokens.push({ kind: TokenKind.FALSE, lexeme: text, range: this.rangeFrom(start, end) });
      return;
    }

    const tok: IdentifierToken = {
      kind: TokenKind.IDENTIFIER,
      lexeme: text,
      range: this.rangeFrom(start, end),
      value: text,
    };
    this.tokens.push(tok);
  }

  private matchIsBoolean(aheadFromCurrent: number): boolean {
    // Checks whether src at (i+ahead) starts with "isBoolean" and is word-bounded after.
    const start = this.i + aheadFromCurrent;
    const word = "isBoolean";

    if (start + word.length > this.src.length) return false;
    if (this.src.slice(start, start + word.length) !== word) return false;

    const after = start + word.length;
    const afterChar = after < this.src.length ? this.src[after] : "\0";
    // word boundary: not ident part
    if (isIdentPart(afterChar)) return false;

    return true;
  }

  private lexBoolCheck(kind: TokenKind.BOOL_Q_ISBOOLEAN | TokenKind.BOOL_NOT_ISBOOLEAN): void {
    const start = this.position();
    // consume '?' or '!'
    const first = this.advance();
    // consume "isBoolean"
    const word = "isBoolean";
    for (let k = 0; k < word.length; k++) this.advance();

    const end = this.position();
    const lexeme = first + word;

    this.tokens.push({
      kind,
      lexeme,
      range: this.rangeFrom(start, end),
    });
  }

  /* =========================================================
     Operators / punctuation
     ========================================================= */

  private lexOperatorOrPunct(): boolean {
    const c = this.peek();
    const n = this.peek(1);
    const start = this.position();

    // Multi-char operators first
    if (c === "=" && n === "=" && this.peek(2) === "=") {
      this.advance(); this.advance(); this.advance();
      this.tokens.push({ kind: TokenKind.SEQ, lexeme: "===", range: this.rangeFrom(start, this.position()) });
      return true;
    }
    if (c === "!" && n === "=" && this.peek(2) === "=") {
      this.advance(); this.advance(); this.advance();
      this.tokens.push({ kind: TokenKind.SNEQ, lexeme: "!==", range: this.rangeFrom(start, this.position()) });
      return true;
    }
    if (c === "=" && n === "=") {
      this.advance(); this.advance();
      this.tokens.push({ kind: TokenKind.EQ, lexeme: "==", range: this.rangeFrom(start, this.position()) });
      return true;
    }
    if (c === "!" && n === "=") {
      this.advance(); this.advance();
      this.tokens.push({ kind: TokenKind.NEQ, lexeme: "!=", range: this.rangeFrom(start, this.position()) });
      return true;
    }
    if (c === "<" && n === "=") {
      this.advance(); this.advance();
      this.tokens.push({ kind: TokenKind.LTE, lexeme: "<=", range: this.rangeFrom(start, this.position()) });
      return true;
    }
    if (c === ">" && n === "=") {
      this.advance(); this.advance();
      this.tokens.push({ kind: TokenKind.GTE, lexeme: ">=", range: this.rangeFrom(start, this.position()) });
      return true;
    }
    if (c === "&" && n === "&") {
      this.advance(); this.advance();
      this.tokens.push({ kind: TokenKind.AND, lexeme: "&&", range: this.rangeFrom(start, this.position()) });
      return true;
    }
    if (c === "|" && n === "|") {
      this.advance(); this.advance();
      this.tokens.push({ kind: TokenKind.OR, lexeme: "||", range: this.rangeFrom(start, this.position()) });
      return true;
    }
    if (c === "=" && n === ">") {
      this.advance(); this.advance();
      this.tokens.push({ kind: TokenKind.ARROW, lexeme: "=>", range: this.rangeFrom(start, this.position()) });
      return true;
    }

    // Single-char operators
    switch (c) {
      case "=":
        this.advance();
        this.tokens.push({ kind: TokenKind.ASSIGN, lexeme: "=", range: this.rangeFrom(start, this.position()) });
        return true;
      case "<":
        this.advance();
        this.tokens.push({ kind: TokenKind.LT, lexeme: "<", range: this.rangeFrom(start, this.position()) });
        return true;
      case ">":
        this.advance();
        this.tokens.push({ kind: TokenKind.GT, lexeme: ">", range: this.rangeFrom(start, this.position()) });
        return true;
      case "+":
        this.advance();
        this.tokens.push({ kind: TokenKind.PLUS, lexeme: "+", range: this.rangeFrom(start, this.position()) });
        return true;
      case "-":
        this.advance();
        this.tokens.push({ kind: TokenKind.MINUS, lexeme: "-", range: this.rangeFrom(start, this.position()) });
        return true;
      case "x":
        // IMPORTANT: "x" is also a valid identifier start, but we only reach here
        // if it wasn't lexed as an identifier. That happens when "x" appears
        // surrounded by whitespace or punctuation and not as part of a longer ident.
        // Example: "a x b" -> we will lex "a"(ident) whitespace then here "x"(mul).
        //
        // If user writes "xValue" it is an identifier and won't come here.
        this.advance();
        this.tokens.push({ kind: TokenKind.MUL_X, lexeme: "x", range: this.rangeFrom(start, this.position()) });
        return true;
      case "%":
        this.advance();
        this.tokens.push({ kind: TokenKind.MOD, lexeme: "%", range: this.rangeFrom(start, this.position()) });
        return true;
      case "§":
        this.advance();
        this.tokens.push({ kind: TokenKind.ROOT, lexeme: "§", range: this.rangeFrom(start, this.position()) });
        return true;
      case "!":
        // NOTE: !isBoolean is handled earlier. Here is normal NOT.
        this.advance();
        this.tokens.push({ kind: TokenKind.NOT, lexeme: "!", range: this.rangeFrom(start, this.position()) });
        return true;

      // Punctuation
      case "(":
        this.advance();
        this.tokens.push({ kind: TokenKind.LPAREN, lexeme: "(", range: this.rangeFrom(start, this.position()) });
        return true;
      case ")":
        this.advance();
        this.tokens.push({ kind: TokenKind.RPAREN, lexeme: ")", range: this.rangeFrom(start, this.position()) });
        return true;
      case "{":
        this.advance();
        this.tokens.push({ kind: TokenKind.LBRACE, lexeme: "{", range: this.rangeFrom(start, this.position()) });
        return true;
      case "}":
        this.advance();
        this.tokens.push({ kind: TokenKind.RBRACE, lexeme: "}", range: this.rangeFrom(start, this.position()) });
        return true;
      case "[":
        this.advance();
        this.tokens.push({ kind: TokenKind.LBRACKET, lexeme: "[", range: this.rangeFrom(start, this.position()) });
        return true;
      case "]":
        this.advance();
        this.tokens.push({ kind: TokenKind.RBRACKET, lexeme: "]", range: this.rangeFrom(start, this.position()) });
        return true;
      case ",":
        this.advance();
        this.tokens.push({ kind: TokenKind.COMMA, lexeme: ",", range: this.rangeFrom(start, this.position()) });
        return true;
      case ";":
        this.advance();
        this.tokens.push({ kind: TokenKind.SEMICOLON, lexeme: ";", range: this.rangeFrom(start, this.position()) });
        return true;
      case ".":
        this.advance();
        this.tokens.push({ kind: TokenKind.DOT, lexeme: ".", range: this.rangeFrom(start, this.position()) });
        return true;
      case ":":
        this.advance();
        this.tokens.push({ kind: TokenKind.COLON, lexeme: ":", range: this.rangeFrom(start, this.position()) });
        return true;
      case "\\":
        this.advance();
        this.tokens.push({ kind: TokenKind.BACKSLASH, lexeme: "\\", range: this.rangeFrom(start, this.position()) });
        return true;
      default:
        return false;
    }
  }
}

/* =========================================================
   Public helpers
   ========================================================= */

export function tokenize(source: string, options?: LexerOptions): LexResult {
  return new Lexer(source, options).lex();
}

/* =========================================================
   Keyword map
   ========================================================= */

function keywordKind(text: string): TokenKind | null {
  switch (text) {
    case "disable":
      return TokenKind.KW_DISABLE;
    case "able":
      return TokenKind.KW_ABLE;

    case "let":
      return TokenKind.KW_LET;
    case "var":
      return TokenKind.KW_VAR;
    case "const":
      return TokenKind.KW_CONST;

    case "if":
      return TokenKind.KW_IF;
    case "elif":
      return TokenKind.KW_ELIF;
    case "else":
      return TokenKind.KW_ELSE;

    case "for":
      return TokenKind.KW_FOR;
    case "forEach":
      return TokenKind.KW_FOREACH;
    case "in":
      return TokenKind.KW_IN;

    case "while":
      return TokenKind.KW_WHILE;
    case "do":
      return TokenKind.KW_DO;

    case "break":
      return TokenKind.KW_BREAK;
    case "continue":
      return TokenKind.KW_CONTINUE;

    case "try":
      return TokenKind.KW_TRY;
    case "catch":
      return TokenKind.KW_CATCH;
    case "finally":
      return TokenKind.KW_FINALLY;

    case "throw":
      return TokenKind.KW_THROW;
    case "return":
      return TokenKind.KW_RETURN;

    case "func":
      return TokenKind.KW_FUNC;

    case "async":
      return TokenKind.KW_ASYNC;
    case "await":
      return TokenKind.KW_AWAIT;

    default:
      return null;
  }
}

/* =========================================================
   Character utilities
   ========================================================= */

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isIdentStart(c: string): boolean {
  // ASCII letters + underscore
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

function isIdentPart(c: string): boolean {
  // allow hyphen in identifiers (Forge examples include "Corsair-Vengeance")
  return isIdentStart(c) || isDigit(c) || c === "-" || c === "_";
}

function decodeEscape(c: string): string | null {
  switch (c) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "'":
      return "'";
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "{":
      // handy for allowing \{ inside strings
      return "{";
    case "}":
      return "}";
    default:
      return null;
  }
}

function printable(c: string): string {
  if (c === "\n") return "\\n";
  if (c === "\t") return "\\t";
  if (c === "\r") return "\\r";
  if (c === "\0") return "\\0";
  return c;
}
