"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.Parser = void 0;
exports.parseSource = parseSource;
exports.parseTokens = parseTokens;
const lexer_1 = require("./lexer");
/* =========================================================
   Public helpers
   ========================================================= */
function parseSource(source) {
    const lex = (0, lexer_1.tokenize)(source, {
        includeComments: false,
        includeWhitespace: false,
        emitNewlines: true,
        stopOnError: false,
    });
    const parser = new Parser(lex.tokens, source);
    const program = parser.parseProgram();
    // merge lexer and parser errors
    const errors = [
        ...lex.errors.map((e) => ({ message: e.message, range: e.range })),
        ...parser.errors,
    ];
    return { program, errors };
}
function parseTokens(tokens, source = "") {
    const parser = new Parser(tokens, source);
    const program = parser.parseProgram();
    return { program, errors: parser.errors };
}
const BIN_OP_TABLE = {
    [lexer_1.TokenKind.OR]: { precedence: 1, assoc: "left", op: "||" },
    [lexer_1.TokenKind.AND]: { precedence: 2, assoc: "left", op: "&&" },
    [lexer_1.TokenKind.EQ]: { precedence: 3, assoc: "left", op: "==" },
    [lexer_1.TokenKind.NEQ]: { precedence: 3, assoc: "left", op: "!=" },
    [lexer_1.TokenKind.SEQ]: { precedence: 3, assoc: "left", op: "===" },
    [lexer_1.TokenKind.SNEQ]: { precedence: 3, assoc: "left", op: "!==" },
    [lexer_1.TokenKind.LT]: { precedence: 4, assoc: "left", op: "<" },
    [lexer_1.TokenKind.LTE]: { precedence: 4, assoc: "left", op: "<=" },
    [lexer_1.TokenKind.GT]: { precedence: 4, assoc: "left", op: ">" },
    [lexer_1.TokenKind.GTE]: { precedence: 4, assoc: "left", op: ">=" },
    [lexer_1.TokenKind.PLUS]: { precedence: 5, assoc: "left", op: "+" },
    [lexer_1.TokenKind.MINUS]: { precedence: 5, assoc: "left", op: "-" },
    [lexer_1.TokenKind.DIV]: { precedence: 6, assoc: "left", op: "/" },
    [lexer_1.TokenKind.MOD]: { precedence: 6, assoc: "left", op: "%" },
    [lexer_1.TokenKind.ROOT]: { precedence: 6, assoc: "left", op: "§" },
    [lexer_1.TokenKind.MUL_X]: { precedence: 6, assoc: "left", op: "x" },
};
class Parser {
    tokens;
    source;
    idx = 0;
    errors = [];
    constructor(tokens, source = "") {
        this.tokens = tokens ?? [];
        this.source = source ?? "";
    }
    /* =========================================================
       Top-level
       ========================================================= */
    parseProgram() {
        const start = this.current().range.start;
        const body = [];
        this.skipSeparators();
        while (!this.isAtEnd()) {
            const st = this.parseStatement();
            if (st)
                body.push(st);
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
    parseStatement() {
        // Allow stray NEWLINE/SEMICOLON
        this.skipSeparators();
        const t = this.current();
        // Directives
        if (this.match(lexer_1.TokenKind.KW_DISABLE))
            return this.parseDisableDirective(this.previous());
        if (this.match(lexer_1.TokenKind.KW_ABLE))
            return this.parseAbleDirective(this.previous());
        // Decls
        if (this.match(lexer_1.TokenKind.KW_LET))
            return this.parseVarDeclaration("let", this.previous());
        if (this.match(lexer_1.TokenKind.KW_VAR))
            return this.parseVarDeclaration("var", this.previous());
        if (this.match(lexer_1.TokenKind.KW_CONST))
            return this.parseVarDeclaration("const", this.previous());
        // Control flow
        if (this.match(lexer_1.TokenKind.KW_IF))
            return this.parseIfStatement(this.previous());
        if (this.match(lexer_1.TokenKind.KW_WHILE))
            return this.parseWhileStatement(this.previous());
        if (this.match(lexer_1.TokenKind.KW_DO))
            return this.parseDoWhileStatement(this.previous());
        if (this.match(lexer_1.TokenKind.KW_FOR))
            return this.parseForStatement(this.previous());
        if (this.match(lexer_1.TokenKind.KW_FOREACH))
            return this.parseForEachStatement(this.previous());
        if (this.match(lexer_1.TokenKind.KW_TRY))
            return this.parseTryStatement(this.previous());
        // Function declaration: "async func" or "func"
        if (this.is(lexer_1.TokenKind.KW_ASYNC) && this.peekKind(1) === lexer_1.TokenKind.KW_FUNC) {
            this.advance(); // async
            this.advance(); // func
            return this.parseFunctionDeclaration(true, this.previous());
        }
        if (this.match(lexer_1.TokenKind.KW_FUNC)) {
            return this.parseFunctionDeclaration(false, this.previous());
        }
        // Simple statements
        if (this.match(lexer_1.TokenKind.KW_RETURN))
            return this.parseReturnStatement(this.previous());
        if (this.match(lexer_1.TokenKind.KW_THROW))
            return this.parseThrowStatement(this.previous());
        if (this.match(lexer_1.TokenKind.KW_BREAK))
            return this.makeSimpleStatement("BreakStatement", this.previous());
        if (this.match(lexer_1.TokenKind.KW_CONTINUE))
            return this.makeSimpleStatement("ContinueStatement", this.previous());
        // Block
        if (this.match(lexer_1.TokenKind.LBRACE)) {
            // This is a statement-level block
            return this.parseBlockFromOpenedBrace(this.previous());
        }
        // Otherwise: assignment statement or expression statement
        const startTok = t;
        // Try parse an assignable + '='
        const maybeAssignable = this.tryParseAssignableLookahead();
        if (maybeAssignable && this.match(lexer_1.TokenKind.ASSIGN)) {
            const assignTok = this.previous();
            // Forge-specific rewrite: "x = ?isBoolean" / "x = !isBoolean"
            if (this.is(lexer_1.TokenKind.BOOL_Q_ISBOOLEAN) || this.is(lexer_1.TokenKind.BOOL_NOT_ISBOOLEAN)) {
                const opTok = this.advance();
                const force = this.tryReadBoolForceSuffix();
                const boolNode = {
                    kind: "BooleanOpExpression",
                    range: {
                        start: startTok.range.start,
                        end: force === null ? opTok.range.end : this.previous().range.end,
                    },
                    subject: maybeAssignable,
                    op: "query",
                    negate: opTok.kind === lexer_1.TokenKind.BOOL_NOT_ISBOOLEAN,
                    force,
                };
                return {
                    kind: "AssignmentStatement",
                    range: { start: startTok.range.start, end: boolNode.range.end },
                    target: maybeAssignable,
                    value: boolNode,
                };
            }
            // Forge-specific rewrite: "x = isBoolean(.t/.f)"
            if (this.isIdentifierLexeme("isBoolean")) {
                const isTok = this.advance(); // identifier "isBoolean"
                const castForce = this.tryReadBoolForceSuffix();
                const castNode = {
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
                };
            }
            // Normal assignment: parse full RHS expression
            const rhs = this.parseExpression();
            const end = rhs.range.end;
            return {
                kind: "AssignmentStatement",
                range: { start: startTok.range.start, end },
                target: maybeAssignable,
                value: rhs,
            };
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
        };
    }
    parseDisableDirective(kwTok) {
        const targetTok = this.expect(lexer_1.TokenKind.STRING, "Expected a string after 'disable'.");
        const target = this.stringLiteralFromToken(targetTok);
        // optional semicolon
        this.match(lexer_1.TokenKind.SEMICOLON);
        return {
            kind: "DisableDirective",
            range: { start: kwTok.range.start, end: target.range.end },
            target,
        };
    }
    parseAbleDirective(kwTok) {
        const modules = [];
        // able 'Math', 'Time', 'Sys'
        do {
            const sTok = this.expect(lexer_1.TokenKind.STRING, "Expected a string module name after 'able'.");
            modules.push(this.stringLiteralFromToken(sTok));
        } while (this.match(lexer_1.TokenKind.COMMA));
        // optional semicolon
        this.match(lexer_1.TokenKind.SEMICOLON);
        const end = modules.length ? modules[modules.length - 1].range.end : kwTok.range.end;
        return {
            kind: "AbleDirective",
            range: { start: kwTok.range.start, end },
            modules,
        };
    }
    parseVarDeclaration(kind, kwTok) {
        const nameTok = this.expectIdentifierLike("Expected variable name.");
        const name = this.makeIdentifier(nameTok);
        let initializer = null;
        if (this.match(lexer_1.TokenKind.ASSIGN)) {
            initializer = this.parseExpression({ allowBareTemplate: true });
        }
        // optional statement terminator
        this.match(lexer_1.TokenKind.SEMICOLON);
        const end = initializer ? initializer.range.end : name.range.end;
        return {
            kind: "VarDeclaration",
            range: { start: kwTok.range.start, end },
            declKind: kind,
            name,
            initializer,
        };
    }
    parseBlockFromOpenedBrace(openBrace) {
        const body = [];
        this.skipSeparators();
        while (!this.isAtEnd() && !this.is(lexer_1.TokenKind.RBRACE)) {
            const st = this.parseStatement();
            if (st)
                body.push(st);
            this.skipSeparators();
        }
        const close = this.expect(lexer_1.TokenKind.RBRACE, "Expected '}' to close block.");
        return {
            kind: "BlockStatement",
            range: { start: openBrace.range.start, end: close.range.end },
            body,
        };
    }
    parseIfStatement(kwTok) {
        const test = this.parseConditionExpression();
        const consequent = this.parseBlockStatement("Expected '{' after if condition.");
        const elifClauses = [];
        while (this.match(lexer_1.TokenKind.KW_ELIF)) {
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
        let alternate = null;
        if (this.match(lexer_1.TokenKind.KW_ELSE)) {
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
    parseWhileStatement(kwTok) {
        const test = this.parseConditionExpression();
        const body = this.parseBlockStatement("Expected '{' after while condition.");
        return {
            kind: "WhileStatement",
            range: { start: kwTok.range.start, end: body.range.end },
            test,
            body,
        };
    }
    parseDoWhileStatement(kwTok) {
        const body = this.parseBlockStatement("Expected '{' after 'do'.");
        this.expect(lexer_1.TokenKind.KW_WHILE, "Expected 'while' after do-block.");
        const test = this.parseConditionExpression();
        // optional terminator
        this.match(lexer_1.TokenKind.SEMICOLON);
        return {
            kind: "DoWhileStatement",
            range: { start: kwTok.range.start, end: test.range.end },
            body,
            test,
        };
    }
    parseForStatement(kwTok) {
        this.expect(lexer_1.TokenKind.LPAREN, "Expected '(' after 'for'.");
        // init
        let init = null;
        this.skipNewlines();
        if (!this.is(lexer_1.TokenKind.SEMICOLON)) {
            if (this.match(lexer_1.TokenKind.KW_LET))
                init = this.parseVarDeclaration("let", this.previous());
            else if (this.match(lexer_1.TokenKind.KW_VAR))
                init = this.parseVarDeclaration("var", this.previous());
            else if (this.match(lexer_1.TokenKind.KW_CONST))
                init = this.parseVarDeclaration("const", this.previous());
            else {
                const expr = this.parseExpression();
                init = {
                    kind: "ExpressionStatement",
                    range: expr.range,
                    expression: expr,
                };
            }
        }
        this.expect(lexer_1.TokenKind.SEMICOLON, "Expected ';' after for-init.");
        // test
        let test = null;
        this.skipNewlines();
        if (!this.is(lexer_1.TokenKind.SEMICOLON)) {
            test = this.parseExpression();
        }
        this.expect(lexer_1.TokenKind.SEMICOLON, "Expected ';' after for-test.");
        // update
        let update = null;
        this.skipNewlines();
        if (!this.is(lexer_1.TokenKind.RPAREN)) {
            update = this.parseExpression();
        }
        const closeParen = this.expect(lexer_1.TokenKind.RPAREN, "Expected ')' after for-update.");
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
    parseForEachStatement(kwTok) {
        this.expect(lexer_1.TokenKind.LPAREN, "Expected '(' after 'forEach'.");
        const itemTok = this.expectIdentifierLike("Expected loop variable name in forEach.");
        const item = this.makeIdentifier(itemTok);
        this.expect(lexer_1.TokenKind.KW_IN, "Expected 'in' in forEach (forEach (item in iterable)).");
        const iterable = this.parseExpression();
        this.expect(lexer_1.TokenKind.RPAREN, "Expected ')' after forEach(...)");
        const body = this.parseBlockStatement("Expected '{' after forEach(...).");
        return {
            kind: "ForEachStatement",
            range: { start: kwTok.range.start, end: body.range.end },
            item,
            iterable,
            body,
        };
    }
    parseTryStatement(kwTok) {
        const block = this.parseBlockStatement("Expected '{' after 'try'.");
        let handler = null;
        if (this.match(lexer_1.TokenKind.KW_CATCH)) {
            const catchTok = this.previous();
            let param = null;
            if (this.match(lexer_1.TokenKind.LPAREN)) {
                if (!this.is(lexer_1.TokenKind.RPAREN)) {
                    const pTok = this.expectIdentifierLike("Expected catch parameter name.");
                    param = this.makeIdentifier(pTok);
                }
                this.expect(lexer_1.TokenKind.RPAREN, "Expected ')' after catch(...).");
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
        let finalizer = null;
        if (this.match(lexer_1.TokenKind.KW_FINALLY)) {
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
    parseFunctionDeclaration(isAsync, funcTok) {
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
    parseReturnStatement(kwTok) {
        // return can be followed by expression or end of statement
        if (this.isStatementTerminator(this.current().kind)) {
            return {
                kind: "ReturnStatement",
                range: { start: kwTok.range.start, end: kwTok.range.end },
                argument: null,
            };
        }
        const arg = this.parseExpression({ allowBareTemplate: true });
        this.match(lexer_1.TokenKind.SEMICOLON);
        return {
            kind: "ReturnStatement",
            range: { start: kwTok.range.start, end: arg.range.end },
            argument: arg,
        };
    }
    parseThrowStatement(kwTok) {
        const arg = this.parseExpression({ allowBareTemplate: true });
        this.match(lexer_1.TokenKind.SEMICOLON);
        return {
            kind: "ThrowStatement",
            range: { start: kwTok.range.start, end: arg.range.end },
            argument: arg,
        };
    }
    makeSimpleStatement(kind, kwTok) {
        this.match(lexer_1.TokenKind.SEMICOLON);
        return { kind, range: kwTok.range };
    }
    /* =========================================================
       Conditions
       ========================================================= */
    parseConditionExpression() {
        // Prefer parentheses: if ( ... )
        this.skipNewlines();
        if (this.match(lexer_1.TokenKind.LPAREN)) {
            const open = this.previous();
            const expr = this.parseExpression();
            const close = this.expect(lexer_1.TokenKind.RPAREN, "Expected ')' after condition.");
            // Keep condition expression as-is; range already covers tokens inside
            // but we can widen it if desired. We keep the expression range.
            void open;
            void close;
            return expr;
        }
        // Fallback: parse expression until '{' (heuristic)
        // This allows "if l.dog !isBoolean { ... }" style.
        const expr = this.parseExpression();
        return expr;
    }
    parseBlockStatement(msgIfMissing) {
        this.skipNewlines();
        if (this.match(lexer_1.TokenKind.LBRACE)) {
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
    parseExpression(opts) {
        return this.parseAssignment(opts);
    }
    parseAssignment(opts) {
        const expr = this.parseBinary(0, opts);
        if (this.match(lexer_1.TokenKind.ASSIGN)) {
            const opTok = this.previous();
            const rhs = this.parseAssignment(opts);
            // Ensure LHS is assignable
            if (!this.isAssignable(expr)) {
                this.errorAt(opTok.range, "Left-hand side of assignment is not assignable.");
                // Still build node for tooling
            }
            const node = {
                kind: "AssignmentExpression",
                range: { start: expr.range.start, end: rhs.range.end },
                operator: "=",
                left: expr,
                right: rhs,
            };
            return node;
        }
        return expr;
    }
    parseBinary(minPrec, opts) {
        let left = this.parseUnary(opts);
        // Postfix boolean checks: expr ?isBoolean(.t/.f) | expr !isBoolean(.t/.f)
        left = this.parsePostfixBoolCheck(left);
        while (true) {
            const opInfo = this.getBinaryOpInfo();
            if (!opInfo)
                break;
            if (opInfo.precedence < minPrec)
                break;
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
            };
        }
        return left;
    }
    parseUnary(opts) {
        this.skipNewlines();
        // await
        if (this.match(lexer_1.TokenKind.KW_AWAIT)) {
            const kw = this.previous();
            const arg = this.parseUnary(opts);
            return {
                kind: "AwaitExpression",
                range: { start: kw.range.start, end: arg.range.end },
                argument: arg,
            };
        }
        // unary operators
        if (this.match(lexer_1.TokenKind.NOT)) {
            const op = this.previous();
            const arg = this.parseUnary(opts);
            return {
                kind: "UnaryExpression",
                range: { start: op.range.start, end: arg.range.end },
                operator: "!",
                argument: arg,
            };
        }
        if (this.match(lexer_1.TokenKind.PLUS)) {
            const op = this.previous();
            const arg = this.parseUnary(opts);
            return {
                kind: "UnaryExpression",
                range: { start: op.range.start, end: arg.range.end },
                operator: "+",
                argument: arg,
            };
        }
        if (this.match(lexer_1.TokenKind.MINUS)) {
            const op = this.previous();
            const arg = this.parseUnary(opts);
            return {
                kind: "UnaryExpression",
                range: { start: op.range.start, end: arg.range.end },
                operator: "-",
                argument: arg,
            };
        }
        // primary + postfix (member/call) + arrow functions
        return this.parsePostfix(opts);
    }
    parsePostfix(opts) {
        // Arrow with single param: n => ...
        if (this.is(lexer_1.TokenKind.IDENTIFIER) && this.peekKind(1) === lexer_1.TokenKind.ARROW) {
            const pTok = this.advance();
            const param = { name: this.makeIdentifier(pTok), defaultValue: null, isRest: false };
            const arrowTok = this.expect(lexer_1.TokenKind.ARROW, "Expected '=>' in arrow function.");
            const body = this.parseArrowBody();
            const end = body.range.end;
            void arrowTok;
            return {
                kind: "ArrowFunctionExpression",
                range: { start: pTok.range.start, end },
                params: [param],
                body,
                isAsync: false,
            };
        }
        // Arrow with (params) => ...
        if (this.is(lexer_1.TokenKind.LPAREN) && this.looksLikeArrowFromParen()) {
            const open = this.advance(); // (
            const params = this.parseParamListInsideParens(open.range.start);
            const arrowTok = this.expect(lexer_1.TokenKind.ARROW, "Expected '=>' after arrow parameters.");
            const body = this.parseArrowBody();
            void arrowTok;
            return {
                kind: "ArrowFunctionExpression",
                range: { start: open.range.start, end: body.range.end },
                params,
                body,
                isAsync: false,
            };
        }
        // Function expression: "async func ..." or "func ..."
        if (this.is(lexer_1.TokenKind.KW_ASYNC) && this.peekKind(1) === lexer_1.TokenKind.KW_FUNC) {
            const asyncTok = this.advance();
            const funcTok = this.advance();
            const fn = this.parseFunctionExpression(true, funcTok);
            // widen start to async
            fn.range = { start: asyncTok.range.start, end: fn.range.end };
            return fn;
        }
        if (this.match(lexer_1.TokenKind.KW_FUNC)) {
            return this.parseFunctionExpression(false, this.previous());
        }
        let expr = this.parsePrimary(opts);
        // member/call chain
        while (true) {
            this.skipNewlines();
            if (this.match(lexer_1.TokenKind.DOT)) {
                const dot = this.previous();
                const key = this.parsePropertyKeyAfterDot(dot.range.start);
                const end = key.range.end;
                expr = {
                    kind: "MemberExpression",
                    range: { start: expr.range.start, end },
                    object: expr,
                    property: key,
                    computed: false,
                };
                continue;
            }
            if (this.match(lexer_1.TokenKind.LPAREN)) {
                const open = this.previous();
                const args = this.parseCallArguments(open.range.start);
                const close = this.expect(lexer_1.TokenKind.RPAREN, "Expected ')' after call arguments.");
                expr = {
                    kind: "CallExpression",
                    range: { start: expr.range.start, end: close.range.end },
                    callee: expr,
                    args,
                };
                continue;
            }
            break;
        }
        // postfix boolean checks after member/call chain too
        expr = this.parsePostfixBoolCheck(expr);
        return expr;
    }
    parsePrimary(opts) {
        this.skipNewlines();
        const t = this.current();
        // Bare template string as an expression (heuristic)
        if (opts?.allowBareTemplate && this.shouldParseBareTemplateExpression()) {
            const tpl = this.parseBareTemplateUntilTerminator();
            return tpl;
        }
        if (this.match(lexer_1.TokenKind.NUMBER)) {
            const tok = this.previous();
            return {
                kind: "NumberLiteral",
                range: tok.range,
                value: tok.value,
                raw: tok.raw,
            };
        }
        if (this.match(lexer_1.TokenKind.DURATION)) {
            const tok = this.previous();
            return {
                kind: "DurationLiteral",
                range: tok.range,
                value: tok.value,
                unit: tok.unit,
                raw: tok.raw,
            };
        }
        if (this.match(lexer_1.TokenKind.STRING)) {
            const tok = this.previous();
            return this.stringLiteralFromToken(tok);
        }
        if (this.match(lexer_1.TokenKind.TRUE)) {
            const tok = this.previous();
            return { kind: "BooleanLiteral", range: tok.range, value: true };
        }
        if (this.match(lexer_1.TokenKind.FALSE)) {
            const tok = this.previous();
            return { kind: "BooleanLiteral", range: tok.range, value: false };
        }
        // null literal (optional future): not in lexer; accept identifier "null"
        if (this.isIdentifierLexeme("null")) {
            const tok = this.advance();
            return { kind: "NullLiteral", range: tok.range, value: null };
        }
        // Namespaced identifier: l.<name> / v.<name> / c.<name>
        if (this.is(lexer_1.TokenKind.IDENTIFIER) && this.isNamespacePrefix(this.currentLexeme()) && this.peekKind(1) === lexer_1.TokenKind.DOT) {
            return this.parseNamespacedIdentifier();
        }
        // Identifier
        if (this.match(lexer_1.TokenKind.IDENTIFIER)) {
            const tok = this.previous();
            return this.makeIdentifier(tok);
        }
        // Parenthesized expression
        if (this.match(lexer_1.TokenKind.LPAREN)) {
            const open = this.previous();
            const expr = this.parseExpression({ allowBareTemplate: false });
            const close = this.expect(lexer_1.TokenKind.RPAREN, "Expected ')' after expression.");
            // widen range to include parentheses (optional)
            expr.range = { start: open.range.start, end: close.range.end };
            return expr;
        }
        // Object literal
        if (this.match(lexer_1.TokenKind.LBRACE)) {
            return this.parseObjectLiteral(this.previous());
        }
        // Array literal
        if (this.match(lexer_1.TokenKind.LBRACKET)) {
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
        };
    }
    /* =========================================================
       Arrow helpers
       ========================================================= */
    looksLikeArrowFromParen() {
        // We are at '('
        let i = this.idx;
        if (this.tokens[i]?.kind !== lexer_1.TokenKind.LPAREN)
            return false;
        i++;
        // scan params: ( [id ( = expr )] (, ...)? ) =>
        // We'll do a conservative scan: allow identifiers, commas, equals, dots, strings/numbers inside defaults,
        // and balanced parens/brackets/braces.
        let depthParen = 1;
        let depthBrace = 0;
        let depthBracket = 0;
        while (i < this.tokens.length) {
            const k = this.tokens[i].kind;
            if (k === lexer_1.TokenKind.LPAREN)
                depthParen++;
            else if (k === lexer_1.TokenKind.RPAREN) {
                depthParen--;
                if (depthParen === 0) {
                    // next non-newline token must be ARROW
                    let j = i + 1;
                    while (this.tokens[j] && this.tokens[j].kind === lexer_1.TokenKind.NEWLINE)
                        j++;
                    return this.tokens[j]?.kind === lexer_1.TokenKind.ARROW;
                }
            }
            else if (k === lexer_1.TokenKind.LBRACE)
                depthBrace++;
            else if (k === lexer_1.TokenKind.RBRACE)
                depthBrace = Math.max(0, depthBrace - 1);
            else if (k === lexer_1.TokenKind.LBRACKET)
                depthBracket++;
            else if (k === lexer_1.TokenKind.RBRACKET)
                depthBracket = Math.max(0, depthBracket - 1);
            // If braces/brackets show up in param list defaults, we still keep scanning.
            i++;
        }
        return false;
    }
    parseParamList() {
        const open = this.expect(lexer_1.TokenKind.LPAREN, "Expected '(' for parameter list.");
        return this.parseParamListInsideParens(open.range.start);
    }
    parseParamListInsideParens(openPos) {
        const params = [];
        this.skipNewlines();
        if (this.match(lexer_1.TokenKind.RPAREN)) {
            // empty
            return params;
        }
        while (!this.isAtEnd() && !this.is(lexer_1.TokenKind.RPAREN)) {
            this.skipNewlines();
            const nameTok = this.expectIdentifierLike("Expected parameter name.");
            const name = this.makeIdentifier(nameTok);
            let defaultValue = null;
            if (this.match(lexer_1.TokenKind.ASSIGN)) {
                defaultValue = this.parseExpression();
            }
            params.push({ name, defaultValue, isRest: false });
            this.skipNewlines();
            if (!this.match(lexer_1.TokenKind.COMMA))
                break;
        }
        const close = this.expect(lexer_1.TokenKind.RPAREN, "Expected ')' after parameter list.");
        void openPos;
        void close;
        return params;
    }
    parseArrowBody() {
        this.skipNewlines();
        if (this.match(lexer_1.TokenKind.LBRACE)) {
            return this.parseBlockFromOpenedBrace(this.previous());
        }
        return this.parseExpression({ allowBareTemplate: true });
    }
    parseFunctionExpression(isAsync, funcTok) {
        // name optional
        let name = null;
        if (this.is(lexer_1.TokenKind.IDENTIFIER)) {
            // If the next token is '(', treat as function name
            if (this.peekKind(1) === lexer_1.TokenKind.LPAREN) {
                name = this.makeIdentifier(this.advance());
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
    parsePostfixBoolCheck(subject) {
        this.skipNewlines();
        if (this.is(lexer_1.TokenKind.BOOL_Q_ISBOOLEAN) || this.is(lexer_1.TokenKind.BOOL_NOT_ISBOOLEAN)) {
            const opTok = this.advance();
            const force = this.tryReadBoolForceSuffix();
            const node = {
                kind: "BooleanOpExpression",
                range: {
                    start: subject.range.start,
                    end: force === null ? opTok.range.end : this.previous().range.end,
                },
                subject,
                op: "query",
                negate: opTok.kind === lexer_1.TokenKind.BOOL_NOT_ISBOOLEAN,
                force,
            };
            return node;
        }
        return subject;
    }
    tryReadBoolForceSuffix() {
        // reads ".t" or ".f" after a boolean operator token or "isBoolean" identifier
        // returns true/false or null if not present
        const save = this.idx;
        this.skipNewlines();
        if (!this.match(lexer_1.TokenKind.DOT)) {
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
    parseNamespacedIdentifier() {
        const nsTok = this.advance();
        const ns = nsTok.value;
        this.expect(lexer_1.TokenKind.DOT, "Expected '.' after namespace.");
        // optional escape for extreme names: v.\v
        let escaped = false;
        if (this.match(lexer_1.TokenKind.BACKSLASH))
            escaped = true;
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
    parsePropertyKeyAfterDot(dotStart) {
        this.skipNewlines();
        let escaped = false;
        if (this.match(lexer_1.TokenKind.BACKSLASH))
            escaped = true;
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
    propertyNameLexeme(t) {
        // allow identifier OR keywords used as identifiers (like ".async")
        if (t.kind === lexer_1.TokenKind.IDENTIFIER)
            return t.value;
        // keywords-as-property: use lexeme
        const kwAsText = this.keywordAsText(t.kind);
        if (kwAsText)
            return kwAsText;
        if (t.kind === lexer_1.TokenKind.TRUE)
            return "True";
        if (t.kind === lexer_1.TokenKind.FALSE)
            return "False";
        return null;
    }
    keywordAsText(k) {
        switch (k) {
            case lexer_1.TokenKind.KW_ASYNC:
                return "async";
            case lexer_1.TokenKind.KW_AWAIT:
                return "await";
            case lexer_1.TokenKind.KW_FUNC:
                return "func";
            case lexer_1.TokenKind.KW_RETURN:
                return "return";
            case lexer_1.TokenKind.KW_THROW:
                return "throw";
            case lexer_1.TokenKind.KW_TRY:
                return "try";
            case lexer_1.TokenKind.KW_CATCH:
                return "catch";
            case lexer_1.TokenKind.KW_FINALLY:
                return "finally";
            case lexer_1.TokenKind.KW_IF:
                return "if";
            case lexer_1.TokenKind.KW_ELSE:
                return "else";
            case lexer_1.TokenKind.KW_ELIF:
                return "elif";
            case lexer_1.TokenKind.KW_FOR:
                return "for";
            case lexer_1.TokenKind.KW_FOREACH:
                return "forEach";
            case lexer_1.TokenKind.KW_WHILE:
                return "while";
            case lexer_1.TokenKind.KW_DO:
                return "do";
            case lexer_1.TokenKind.KW_IN:
                return "in";
            case lexer_1.TokenKind.KW_LET:
                return "let";
            case lexer_1.TokenKind.KW_VAR:
                return "var";
            case lexer_1.TokenKind.KW_CONST:
                return "const";
            case lexer_1.TokenKind.KW_DISABLE:
                return "disable";
            case lexer_1.TokenKind.KW_ABLE:
                return "able";
            default:
                return null;
        }
    }
    /* =========================================================
       Call arguments
       ========================================================= */
    parseCallArguments(openPos) {
        const args = [];
        this.skipNewlines();
        if (this.is(lexer_1.TokenKind.RPAREN))
            return args;
        while (!this.isAtEnd() && !this.is(lexer_1.TokenKind.RPAREN)) {
            this.skipNewlines();
            // Named arg detection: lower-case identifier + ':' (avoid stealing "Errore: {..}" as named arg)
            if (this.is(lexer_1.TokenKind.IDENTIFIER) && this.peekKind(1) === lexer_1.TokenKind.COLON) {
                const nameTok = this.current();
                const looksNamed = /^[a-z_]/.test(nameTok.value);
                if (looksNamed) {
                    this.advance(); // name
                    const colon = this.advance(); // :
                    const value = this.parseExpression({ allowBareTemplate: true });
                    const arg = {
                        kind: "NamedArgument",
                        name: this.makeIdentifier(nameTok),
                        value,
                        range: { start: nameTok.range.start, end: value.range.end },
                    };
                    void colon;
                    args.push(arg);
                }
                else {
                    // treat as bare template (e.g. "Errore: {x}")
                    const value = this.parseExpression({ allowBareTemplate: true });
                    args.push({
                        kind: "PositionalArgument",
                        value,
                        range: value.range,
                    });
                }
            }
            else {
                const value = this.parseExpression({ allowBareTemplate: true });
                args.push({
                    kind: "PositionalArgument",
                    value,
                    range: value.range,
                });
            }
            this.skipNewlines();
            if (!this.match(lexer_1.TokenKind.COMMA))
                break;
        }
        void openPos;
        return args;
    }
    /* =========================================================
       Object & Array literals
       ========================================================= */
    parseObjectLiteral(open) {
        const properties = [];
        this.skipSeparators();
        while (!this.isAtEnd() && !this.is(lexer_1.TokenKind.RBRACE)) {
            this.skipSeparators();
            // key
            const key = this.parseObjectKey();
            // separator: '=' or ':'
            if (!(this.match(lexer_1.TokenKind.ASSIGN) || this.match(lexer_1.TokenKind.COLON))) {
                this.errorAtCurrent("Expected '=' or ':' in object property.");
                // try recover: if next is RBRACE, stop
                if (this.is(lexer_1.TokenKind.RBRACE))
                    break;
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
            this.match(lexer_1.TokenKind.COMMA);
            this.skipSeparators();
        }
        const close = this.expect(lexer_1.TokenKind.RBRACE, "Expected '}' to close object literal.");
        return {
            kind: "ObjectLiteral",
            range: { start: open.range.start, end: close.range.end },
            properties,
        };
    }
    parseObjectKey() {
        this.skipNewlines();
        const start = this.current().range.start;
        let escaped = false;
        if (this.match(lexer_1.TokenKind.BACKSLASH))
            escaped = true;
        const t = this.current();
        // string key
        if (this.match(lexer_1.TokenKind.STRING)) {
            const s = this.previous();
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
    parseArrayLiteral(open) {
        const elements = [];
        this.skipSeparators();
        while (!this.isAtEnd() && !this.is(lexer_1.TokenKind.RBRACKET)) {
            this.skipSeparators();
            const el = this.parseExpression({ allowBareTemplate: true });
            elements.push(el);
            this.skipSeparators();
            if (!this.match(lexer_1.TokenKind.COMMA))
                break;
            this.skipSeparators();
        }
        const close = this.expect(lexer_1.TokenKind.RBRACKET, "Expected ']' to close array literal.");
        return {
            kind: "ArrayLiteral",
            range: { start: open.range.start, end: close.range.end },
            elements,
        };
    }
    /* =========================================================
       Bare template expressions (heuristic)
       ========================================================= */
    shouldParseBareTemplateExpression() {
        // We treat it as bare template when we see tokens that are not typical expression starts,
        // or when the sequence looks like raw text (IDENT IDENT / ERROR / '>>' tokens etc),
        // OR when we see an interpolation brace '{' before a statement terminator.
        const k = this.current().kind;
        if (k === lexer_1.TokenKind.ERROR)
            return true;
        if (k === lexer_1.TokenKind.GT || k === lexer_1.TokenKind.LT)
            return true;
        if (k === lexer_1.TokenKind.COLON)
            return true;
        // If there is an interpolation brace ahead before a terminator, favor template
        const until = this.findExpressionTerminatorIndex();
        for (let i = this.idx; i < until; i++) {
            const kk = this.tokens[i].kind;
            if (kk === lexer_1.TokenKind.LBRACE)
                return true;
            if (kk === lexer_1.TokenKind.ERROR)
                return true;
        }
        // IDENT IDENT (raw words) tends to be prompt text: inp(Hello world)
        if (k === lexer_1.TokenKind.IDENTIFIER) {
            const k2 = this.peekKind(1);
            // Avoid catching common expression patterns: Ident.Ident / Ident(...)
            if (k2 === lexer_1.TokenKind.DOT || k2 === lexer_1.TokenKind.LPAREN)
                return false;
            if (k2 === lexer_1.TokenKind.IDENTIFIER || k2 === lexer_1.TokenKind.ERROR || k2 === lexer_1.TokenKind.GT || k2 === lexer_1.TokenKind.LT) {
                return true;
            }
        }
        return false;
    }
    parseBareTemplateUntilTerminator() {
        // Terminator depends on context:
        // - If used in call args: terminator is ',' or ')'
        // - If used at statement level: terminator is NEWLINE, ';', '}', EOF
        //
        // This function uses a generic terminator scan based on token nesting depth.
        const startTok = this.current();
        const startOffset = startTok.range.start.offset;
        const parts = [];
        let lastTextOffset = startOffset;
        const startPos = startTok.range.start;
        const isArgTerminator = (k) => k === lexer_1.TokenKind.COMMA || k === lexer_1.TokenKind.RPAREN;
        const isStmtTerminator = (k) => k === lexer_1.TokenKind.NEWLINE || k === lexer_1.TokenKind.SEMICOLON || k === lexer_1.TokenKind.RBRACE || k === lexer_1.TokenKind.EOF;
        // We stop at whichever terminator occurs first for the current context:
        // If we are inside call args, ')' or ',' will appear before newline or ';' typically.
        const stopAt = (k) => isArgTerminator(k) || isStmtTerminator(k);
        while (!this.isAtEnd() && !stopAt(this.current().kind)) {
            // Interpolation: { expression }
            if (this.match(lexer_1.TokenKind.LBRACE)) {
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
                const close = this.expect(lexer_1.TokenKind.RBRACE, "Expected '}' to close template expression.");
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
    sliceSource(startOffset, endOffset) {
        if (!this.source)
            return "";
        const a = Math.max(0, Math.min(this.source.length, startOffset));
        const b = Math.max(0, Math.min(this.source.length, endOffset));
        return this.source.slice(a, b);
    }
    rangeFromOffsets(startOffset, endOffset, fallbackPos) {
        // We only store offsets/line/col from tokens; for freeform slices we approximate:
        // - Use fallback line/col for start, and keep offsets for both.
        // For diagnostics and tooling, offsets are the most important; line/col are “best-effort”.
        return {
            start: { offset: startOffset, line: fallbackPos.line, column: fallbackPos.column },
            end: { offset: endOffset, line: fallbackPos.line, column: fallbackPos.column + Math.max(0, endOffset - startOffset) },
        };
    }
    findExpressionTerminatorIndex() {
        let i = this.idx;
        let depthParen = 0;
        let depthBracket = 0;
        let depthBrace = 0;
        while (i < this.tokens.length) {
            const k = this.tokens[i].kind;
            if (k === lexer_1.TokenKind.LPAREN)
                depthParen++;
            else if (k === lexer_1.TokenKind.RPAREN) {
                if (depthParen === 0)
                    return i;
                depthParen--;
            }
            else if (k === lexer_1.TokenKind.LBRACKET)
                depthBracket++;
            else if (k === lexer_1.TokenKind.RBRACKET)
                depthBracket = Math.max(0, depthBracket - 1);
            else if (k === lexer_1.TokenKind.LBRACE)
                depthBrace++;
            else if (k === lexer_1.TokenKind.RBRACE) {
                if (depthBrace === 0)
                    return i;
                depthBrace = Math.max(0, depthBrace - 1);
            }
            if (depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
                if (k === lexer_1.TokenKind.COMMA || k === lexer_1.TokenKind.NEWLINE || k === lexer_1.TokenKind.SEMICOLON || k === lexer_1.TokenKind.EOF) {
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
    stringLiteralFromToken(tok) {
        return {
            kind: "StringLiteral",
            range: tok.range,
            value: tok.value,
            quote: tok.quote,
        };
    }
    makeIdentifier(tok) {
        const name = tok.kind === lexer_1.TokenKind.IDENTIFIER
            ? tok.value
            : (tok.lexeme ?? ""); // fallback
        return { kind: "Identifier", range: tok.range, name };
    }
    current() {
        return this.tokens[this.idx] ?? this.tokens[this.tokens.length - 1];
    }
    previous() {
        return this.tokens[Math.max(0, this.idx - 1)] ?? this.tokens[0];
    }
    peekKind(ahead) {
        return this.tokens[this.idx + ahead]?.kind ?? lexer_1.TokenKind.EOF;
    }
    currentLexeme() {
        const t = this.current();
        return t.kind === lexer_1.TokenKind.IDENTIFIER ? t.value : t.lexeme ?? "";
    }
    isAtEnd() {
        return this.current().kind === lexer_1.TokenKind.EOF;
    }
    is(kind) {
        return this.current().kind === kind;
    }
    match(kind) {
        if (this.is(kind)) {
            this.advance();
            return true;
        }
        return false;
    }
    advance() {
        if (!this.isAtEnd())
            this.idx++;
        return this.previous();
    }
    expect(kind, message) {
        if (this.is(kind))
            return this.advance();
        this.errorAtCurrent(message);
        // recovery: synthesize token at current position
        const here = this.current().range;
        return { kind, lexeme: "", range: here };
    }
    expectIdentifierLike(message) {
        const t = this.current();
        if (t.kind === lexer_1.TokenKind.IDENTIFIER)
            return this.advance();
        const asText = this.keywordAsText(t.kind);
        if (asText)
            return this.advance();
        this.errorAtCurrent(message);
        return this.advance();
    }
    errorAtCurrent(message) {
        this.errorAt(this.current().range, message);
        this.synchronize();
    }
    errorAt(range, message) {
        this.errors.push({ message, range });
    }
    synchronize() {
        // Move forward until we hit a likely statement boundary.
        while (!this.isAtEnd()) {
            const k = this.current().kind;
            if (k === lexer_1.TokenKind.NEWLINE || k === lexer_1.TokenKind.SEMICOLON || k === lexer_1.TokenKind.RBRACE)
                return;
            this.advance();
        }
    }
    skipNewlines() {
        while (this.match(lexer_1.TokenKind.NEWLINE)) {
            // keep consuming
        }
    }
    skipSeparators() {
        while (true) {
            const k = this.current().kind;
            if (k === lexer_1.TokenKind.NEWLINE || k === lexer_1.TokenKind.SEMICOLON) {
                this.advance();
                continue;
            }
            break;
        }
    }
    isStatementTerminator(k) {
        return k === lexer_1.TokenKind.NEWLINE || k === lexer_1.TokenKind.SEMICOLON || k === lexer_1.TokenKind.RBRACE || k === lexer_1.TokenKind.EOF;
    }
    isNamespacePrefix(s) {
        return s === "l" || s === "v" || s === "c";
    }
    isAssignable(expr) {
        return expr.kind === "Identifier" || expr.kind === "NamespacedIdentifier" || expr.kind === "MemberExpression";
    }
    rewindTo(tok) {
        // Find token index by exact offset match (best effort).
        const target = tok.range.start.offset;
        for (let i = 0; i < this.tokens.length; i++) {
            if (this.tokens[i].range.start.offset === target) {
                this.idx = i;
                return;
            }
        }
    }
    isIdentifierLexeme(name) {
        return this.current().kind === lexer_1.TokenKind.IDENTIFIER && this.current().value === name;
    }
    getBinaryOpInfo() {
        const k = this.current().kind;
        // IMPORTANT: lexer may tokenize "x" as IDENTIFIER; treat IDENTIFIER("x") as MUL operator in binary position.
        if (k === lexer_1.TokenKind.IDENTIFIER && this.current().value === "x") {
            return { precedence: 6, assoc: "left", op: "x" };
        }
        return BIN_OP_TABLE[k] ?? null;
    }
    /* =========================================================
       Assignment statement lookahead (limited)
       ========================================================= */
    tryParseAssignableLookahead() {
        // Parse an assignable expression (Identifier / NamespacedIdentifier / MemberExpression) without calls.
        // If it fails, do not consume tokens.
        const save = this.idx;
        try {
            // Namespaced
            if (this.is(lexer_1.TokenKind.IDENTIFIER) &&
                this.isNamespacePrefix(this.currentLexeme()) &&
                this.peekKind(1) === lexer_1.TokenKind.DOT) {
                let expr = this.parseNamespacedIdentifier();
                // allow member chain: l.var.prop
                while (this.match(lexer_1.TokenKind.DOT)) {
                    const dot = this.previous();
                    const key = this.parsePropertyKeyAfterDot(dot.range.start);
                    expr = {
                        kind: "MemberExpression",
                        range: { start: expr.range.start, end: key.range.end },
                        object: expr,
                        property: key,
                        computed: false,
                    };
                }
                return expr;
            }
            // Identifier + member chain (no calls)
            if (this.is(lexer_1.TokenKind.IDENTIFIER)) {
                let expr = this.makeIdentifier(this.advance());
                while (this.match(lexer_1.TokenKind.DOT)) {
                    const dot = this.previous();
                    const key = this.parsePropertyKeyAfterDot(dot.range.start);
                    expr = {
                        kind: "MemberExpression",
                        range: { start: expr.range.start, end: key.range.end },
                        object: expr,
                        property: key,
                        computed: false,
                    };
                }
                return expr;
            }
            return null;
        }
        catch {
            this.idx = save;
            return null;
        }
        finally {
            // If next is not '=', we may still need to rewind to start for expression parsing.
            // Caller handles that.
        }
    }
}
exports.Parser = Parser;
//# sourceMappingURL=parser.js.map