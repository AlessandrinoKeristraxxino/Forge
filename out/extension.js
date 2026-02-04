"use strict";
// src/extension.ts
//
// Forge Language Support - VS Code Extension
// ----------------------------------------
// This file wires VS Code -> Forge tooling:
// - Diagnostics (live linting)
// - Runner command (Forge: Run File)
//
// NOTE: This implementation is intentionally "all-in-one" for early development.
// As the project grows, you can move:
// - linting into src/diagnostics/*
// - parsing/semantics into src/core/*
// - system modules into src/system/*
//
// The extension will still work the same; only imports change.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
function getForgeConfig() {
    const cfg = vscode.workspace.getConfiguration("forge");
    return {
        diagnosticsEnabled: cfg.get("diagnostics.enabled", true),
        outputChannelName: cfg.get("runner.outputChannel", "Forge"),
        autoSaveBeforeRun: cfg.get("runner.autoSaveBeforeRun", true),
        allowSysExec: cfg.get("system.allowSysExec", false),
    };
}
function createEnv() {
    return {
        l: new Map(),
        v: new Map(),
        c: new Map(),
    };
}
/* =========================================================
   Comment masking (preserve line/column)
   - Supports:
     // line
     /* block *\/
     ** block **
   ========================================================= */
function maskCommentsPreserveLayout(source) {
    let State;
    (function (State) {
        State[State["Code"] = 0] = "Code";
        State[State["LineComment"] = 1] = "LineComment";
        State[State["BlockCommentSlashStar"] = 2] = "BlockCommentSlashStar";
        State[State["BlockCommentStarStar"] = 3] = "BlockCommentStarStar";
        State[State["SingleQuote"] = 4] = "SingleQuote";
        State[State["DoubleQuote"] = 5] = "DoubleQuote";
    })(State || (State = {}));
    const chars = source.split("");
    let state = State.Code;
    let i = 0;
    const isEscaped = (idx) => {
        // count backslashes before idx
        let count = 0;
        let j = idx - 1;
        while (j >= 0 && chars[j] === "\\") {
            count++;
            j--;
        }
        return count % 2 === 1;
    };
    while (i < chars.length) {
        const c = chars[i];
        const next = i + 1 < chars.length ? chars[i + 1] : "";
        if (state === State.Code) {
            // enter strings
            if (c === "'" && !isEscaped(i)) {
                state = State.SingleQuote;
                i++;
                continue;
            }
            if (c === '"' && !isEscaped(i)) {
                state = State.DoubleQuote;
                i++;
                continue;
            }
            // line comment //
            if (c === "/" && next === "/") {
                chars[i] = " ";
                chars[i + 1] = " ";
                i += 2;
                state = State.LineComment;
                continue;
            }
            // block comment /* */
            if (c === "/" && next === "*") {
                chars[i] = " ";
                chars[i + 1] = " ";
                i += 2;
                state = State.BlockCommentSlashStar;
                continue;
            }
            // block comment ** **
            if (c === "*" && next === "*") {
                chars[i] = " ";
                chars[i + 1] = " ";
                i += 2;
                state = State.BlockCommentStarStar;
                continue;
            }
            i++;
            continue;
        }
        if (state === State.LineComment) {
            if (c === "\n") {
                state = State.Code;
                i++;
                continue;
            }
            chars[i] = " ";
            i++;
            continue;
        }
        if (state === State.BlockCommentSlashStar) {
            if (c === "*" && next === "/") {
                chars[i] = " ";
                chars[i + 1] = " ";
                i += 2;
                state = State.Code;
                continue;
            }
            if (c !== "\n")
                chars[i] = " ";
            i++;
            continue;
        }
        if (state === State.BlockCommentStarStar) {
            if (c === "*" && next === "*") {
                chars[i] = " ";
                chars[i + 1] = " ";
                i += 2;
                state = State.Code;
                continue;
            }
            if (c !== "\n")
                chars[i] = " ";
            i++;
            continue;
        }
        if (state === State.SingleQuote) {
            if (c === "'" && !isEscaped(i))
                state = State.Code;
            i++;
            continue;
        }
        if (state === State.DoubleQuote) {
            if (c === '"' && !isEscaped(i))
                state = State.Code;
            i++;
            continue;
        }
    }
    return chars.join("");
}
/* =========================================================
   Small parsing helpers
   ========================================================= */
function isForgeDocument(doc) {
    if (doc.languageId === "forge")
        return true;
    const ext = path.extname(doc.fileName).toLowerCase();
    return ext === ".forge";
}
function findFirstNonSpaceIndex(line) {
    for (let i = 0; i < line.length; i++) {
        if (line[i] !== " " && line[i] !== "\t")
            return i;
    }
    return line.length;
}
function parseQuotedModuleNames(fragment) {
    // Accept: able 'Math', 'Time', 'Sys'
    // Extract quoted strings (single or double)
    const names = [];
    const re = /'([^']+)'|"([^"]+)"/g;
    let m;
    while ((m = re.exec(fragment)) !== null) {
        const val = (m[1] ?? m[2] ?? "").trim();
        // only accept known module names
        if (val === "Sys" ||
            val === "File" ||
            val === "Net" ||
            val === "Crypto" ||
            val === "Time" ||
            val === "Terminal" ||
            val === "Math" ||
            val === "DateTime" ||
            val === "Regex" ||
            val === "JSON" ||
            val === "Async") {
            names.push(val);
        }
    }
    return names;
}
function parsePrimitiveLiteral(raw) {
    const t = raw.trim();
    // boolean
    if (t === "True")
        return { ok: true, value: true };
    if (t === "False")
        return { ok: true, value: false };
    // number (int/float)
    if (/^[+-]?\d+(\.\d+)?$/.test(t)) {
        return { ok: true, value: Number(t) };
    }
    // string single quotes
    if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
        return { ok: true, value: t.slice(1, -1) };
    }
    // string double quotes
    if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
        return { ok: true, value: t.slice(1, -1) };
    }
    return { ok: false };
}
function parseForgePathExpression(exprRaw) {
    // Supports:
    // - l.dog
    // - v.\v.dog
    // - {l.content}  (caller should strip braces; we accept it anyway)
    // - dog (unqualified)
    let expr = exprRaw.trim();
    // strip interpolation braces if present
    if (expr.startsWith("{") && expr.endsWith("}")) {
        expr = expr.slice(1, -1).trim();
    }
    // quick reject if contains spaces
    if (/\s/.test(expr))
        return null;
    // detect leading namespace prefix l./v./c.
    let ns = null;
    if (expr.length >= 2 && (expr[0] === "l" || expr[0] === "v" || expr[0] === "c") && expr[1] === ".") {
        ns = expr[0];
        expr = expr.slice(2);
    }
    const segments = [];
    let i = 0;
    const readIdent = () => {
        const start = i;
        if (i >= expr.length)
            return null;
        // allow escaped identifier \name
        let escaped = false;
        if (expr[i] === "\\") {
            escaped = true;
            i++;
        }
        const identStart = i;
        if (i >= expr.length)
            return null;
        const first = expr[i];
        if (!/[A-Za-z_]/.test(first))
            return null;
        i++;
        while (i < expr.length && /[A-Za-z0-9_-]/.test(expr[i]))
            i++;
        const ident = expr.slice(identStart, i);
        if (!ident)
            return null;
        // escaped flag exists only to allow reserved names like v/l/c as identifiers; value is same
        void escaped;
        return ident;
    };
    while (i < expr.length) {
        const ident = readIdent();
        if (!ident)
            return null;
        segments.push(ident);
        if (i >= expr.length)
            break;
        if (expr[i] === ".") {
            i++;
            continue;
        }
        // unexpected character
        return null;
    }
    if (segments.length === 0)
        return null;
    return { namespace: ns, segments };
}
/* =========================================================
   Linting (MVP)
   - Validates:
     - module directives disable/able
     - var declarations (let/var/const)
     - duplicate names per namespace
     - console.text.var(...) variable references
     - module usage in expressions (Sys/File/Net/Crypto/Time/Terminal/Math)
   ========================================================= */
function lintForge(source) {
    const masked = maskCommentsPreserveLayout(source);
    const lines = masked.split(/\r?\n/);
    const issues = [];
    const env = createEnv();
    // Module registry
    // When disable 'AllInOne' appears, treat as "start with nothing enabled"
    // Otherwise, default could be "AllInOne" (enabled). For safety in the editor, we start disabled only after explicit disable.
    let allInOneDisabled = false;
    const enabledModules = new Set();
    const addIssue = (iss) => issues.push(iss);
    const declareVar = (ns, name, value, line, col) => {
        const table = env[ns];
        if (table.has(name)) {
            addIssue({
                code: "E002",
                severity: "error",
                message: `Duplicate declaration for '${ns}.${name}'. Rename it or remove the earlier declaration.`,
                line,
                col,
                endCol: col + name.length,
            });
            return;
        }
        table.set(name, value);
    };
    const resolveVar = (pathExpr, line, col) => {
        const varName = pathExpr.segments[0];
        let chosenNs = pathExpr.namespace;
        if (!chosenNs) {
            const hits = [];
            for (const n of ["l", "v", "c"]) {
                if (env[n].has(varName))
                    hits.push(n);
            }
            if (hits.length === 0) {
                addIssue({
                    code: "E001",
                    severity: "error",
                    message: `I can't find variable '${varName}' yet. Declare it first or use l./v./c. explicitly.`,
                    line,
                    col,
                    endCol: col + varName.length,
                });
                return { ok: false };
            }
            if (hits.length > 1) {
                addIssue({
                    code: "E003",
                    severity: "error",
                    message: `Variable '${varName}' exists in ${hits.map((h) => `${h}.`).join(", ")}. Please use an explicit namespace (l./v./c.).`,
                    line,
                    col,
                    endCol: col + varName.length,
                });
                return { ok: false };
            }
            chosenNs = hits[0];
        }
        const base = env[chosenNs].get(varName);
        if (base === undefined) {
            addIssue({
                code: "E001",
                severity: "error",
                message: `I can't find variable '${chosenNs}.${varName}'.`,
                line,
                col,
                endCol: col + varName.length,
            });
            return { ok: false };
        }
        // follow property chain if any
        let current = base;
        for (let idx = 1; idx < pathExpr.segments.length; idx++) {
            const seg = pathExpr.segments[idx];
            if (current && typeof current === "object" && !Array.isArray(current)) {
                const obj = current;
                if (!(seg in obj)) {
                    addIssue({
                        code: "E004",
                        severity: "error",
                        message: `Property '${seg}' is not available on '${chosenNs}.${varName}'.`,
                        line,
                        col,
                        endCol: col + seg.length,
                    });
                    return { ok: false };
                }
                current = obj[seg];
                continue;
            }
            addIssue({
                code: "E005",
                severity: "error",
                message: `Property '${seg}' can be used only on object values.`,
                line,
                col,
                endCol: col + seg.length,
            });
            return { ok: false };
        }
        return { ok: true, value: current };
    };
    const checkModuleUsage = (expr, line, baseCol) => {
        // Detect "Sys." etc usage. If AllInOne is disabled and module not enabled => error.
        const modMatch = expr.match(/\b(Sys|File|Net|Crypto|Time|Terminal|Math|DateTime|Regex|JSON|Async)\b(?=\.)/);
        if (!modMatch)
            return;
        const mod = modMatch[1];
        if (allInOneDisabled && !enabledModules.has(mod)) {
            const col = baseCol + (modMatch.index ?? 0);
            addIssue({
                code: "E010",
                severity: "error",
                message: `Module '${mod}' is not enabled yet. Add: able '${mod}'`,
                line,
                col,
                endCol: col + mod.length,
            });
        }
    };
    // Pass 1: parse line-by-line statements (MVP)
    for (let ln = 0; ln < lines.length; ln++) {
        const line = lines[ln];
        const baseCol = findFirstNonSpaceIndex(line);
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        // module directives
        if (/^disable\b/.test(trimmed)) {
            // Example: disable 'AllInOne';
            const hasAllInOne = /'AllInOne'|"AllInOne"/.test(trimmed);
            if (hasAllInOne) {
                allInOneDisabled = true;
                enabledModules.clear();
            }
            continue;
        }
        if (/^able\b/.test(trimmed)) {
            const mods = parseQuotedModuleNames(trimmed);
            for (const m of mods)
                enabledModules.add(m);
            continue;
        }
        // var declarations: let/var/const
        const declMatch = trimmed.match(/^(let|var|const)\s+([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*;?\s*$/);
        if (declMatch) {
            const kind = declMatch[1];
            const name = declMatch[2];
            const rhs = declMatch[3];
            // map kind -> namespace
            const ns = kind === "let" ? "l" : kind === "var" ? "v" : "c";
            // parse primitive literal only (MVP)
            const lit = parsePrimitiveLiteral(rhs);
            if (lit.ok) {
                declareVar(ns, name, lit.value, ln, baseCol + trimmed.indexOf(name));
            }
            else {
                // Still declare it as null so references resolve, but warn
                declareVar(ns, name, null, ln, baseCol + trimmed.indexOf(name));
                addIssue({
                    code: "W001",
                    severity: "warning",
                    message: `Initializer for '${ns}.${name}' is not a primitive literal (string/number/True/False). The MVP runner may skip parts of it.`,
                    line: ln,
                    col: baseCol + trimmed.indexOf(rhs),
                    endCol: baseCol + trimmed.indexOf(rhs) + Math.min(rhs.length, 1),
                });
                checkModuleUsage(rhs, ln, baseCol + trimmed.indexOf(rhs));
            }
            continue;
        }
        // console.text.var(...)
        const printMatch = trimmed.match(/^console\.text\.var\s*\(\s*(.+?)\s*\)\s*;?\s*$/);
        if (printMatch) {
            const argRaw = printMatch[1];
            checkModuleUsage(argRaw, ln, baseCol + trimmed.indexOf(argRaw));
            // if literal => ok
            if (parsePrimitiveLiteral(argRaw).ok)
                continue;
            // path lookup
            const parsedPath = parseForgePathExpression(argRaw);
            if (parsedPath) {
                resolveVar(parsedPath, ln, baseCol + trimmed.indexOf(argRaw));
            }
            else {
                addIssue({
                    code: "E020",
                    severity: "warning",
                    message: `This print expression is not fully supported in the MVP linter. Prefer: console.text.var(l.name) or console.text.var({l.name})`,
                    line: ln,
                    col: baseCol + trimmed.indexOf(argRaw),
                    endCol: baseCol + trimmed.indexOf(argRaw) + Math.min(argRaw.length, 1),
                });
            }
            continue;
        }
        // sys.exec(...) usage check (even if not in print)
        if (/\bSys\.exec\b/.test(trimmed)) {
            checkModuleUsage(trimmed, ln, baseCol);
            // In MVP: warn that Sys.exec is gated by setting at runtime
            addIssue({
                code: "W010",
                severity: "warning",
                message: `Sys.exec(...) is protected by the setting "forge.system.allowSysExec" for safety.`,
                line: ln,
                col: baseCol + (trimmed.indexOf("Sys.exec") >= 0 ? trimmed.indexOf("Sys.exec") : 0),
                endCol: baseCol + (trimmed.indexOf("Sys.exec") >= 0 ? trimmed.indexOf("Sys.exec") + "Sys.exec".length : 1),
            });
            continue;
        }
    }
    const hasErrors = issues.some((i) => i.severity === "error");
    return { ok: !hasErrors, issues };
}
function sysReadValue(pathExpr) {
    // subset of Sys.* for a realistic demo
    // Supported:
    // - Sys.os.name / Sys.os.version / Sys.os.arch
    // - Sys.cpu.cores
    // - Sys.chek.ram.GB
    const p = pathExpr.trim();
    if (p === "Sys.os.name")
        return os.platform();
    if (p === "Sys.os.version")
        return os.release();
    if (p === "Sys.os.arch")
        return os.arch();
    if (p === "Sys.cpu.cores")
        return os.cpus().length;
    if (p === "Sys.chek.ram.GB") {
        const gb = os.totalmem() / (1024 * 1024 * 1024);
        // keep it readable
        return Math.round(gb * 10) / 10;
    }
    // Not available in standard Node:
    if (p === "Sys.chek.ram.comp")
        return "unknown";
    return null;
}
async function runForgeMvp(doc, cfg, outputChannel) {
    const out = [];
    const env = createEnv();
    const enabledModules = new Set();
    let allInOneDisabled = false;
    const pushOut = (s) => out.push(s);
    const masked = maskCommentsPreserveLayout(doc.getText());
    const lines = masked.split(/\r?\n/);
    for (let ln = 0; ln < lines.length; ln++) {
        const line = lines[ln];
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        // directives
        if (/^disable\b/.test(trimmed)) {
            const hasAllInOne = /'AllInOne'|"AllInOne"/.test(trimmed);
            if (hasAllInOne) {
                allInOneDisabled = true;
                enabledModules.clear();
            }
            continue;
        }
        if (/^able\b/.test(trimmed)) {
            const mods = parseQuotedModuleNames(trimmed);
            for (const m of mods)
                enabledModules.add(m);
            continue;
        }
        // declarations
        const declMatch = trimmed.match(/^(let|var|const)\s+([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*;?\s*$/);
        if (declMatch) {
            const kind = declMatch[1];
            const name = declMatch[2];
            const rhs = declMatch[3];
            const ns = kind === "let" ? "l" : kind === "var" ? "v" : "c";
            const lit = parsePrimitiveLiteral(rhs);
            if (lit.ok) {
                env[ns].set(name, lit.value);
            }
            else {
                // MVP: non-primitive values become null
                env[ns].set(name, null);
            }
            continue;
        }
        // inp(...) / inp.var(...)
        // Examples:
        // const name = inp(Quale è il tuo nome? >> )
        // let inputvar = inp.var(Scrivi qualcosa >> )
        const inpDecl = trimmed.match(/^(let|var|const)\s+([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*inp(\.var)?\(\s*(.+?)\s*\)\s*;?\s*$/);
        if (inpDecl) {
            const kind = inpDecl[1];
            const name = inpDecl[2];
            const mode = inpDecl[3] ? "var" : "raw";
            const prompt = inpDecl[4].trim();
            const ns = kind === "let" ? "l" : kind === "var" ? "v" : "c";
            const userInput = await vscode.window.showInputBox({
                title: "Forge Input",
                prompt: prompt.replace(/>>\s*$/, "").trim(),
                placeHolder: mode === "var" ? "Input (sanitized)" : "Input",
            });
            // MVP sanitation: trim only
            const val = (userInput ?? "").toString();
            env[ns].set(name, mode === "var" ? val.trim() : val);
            continue;
        }
        // console.text.var(...)
        const printMatch = trimmed.match(/^console\.text\.var\s*\(\s*(.+?)\s*\)\s*;?\s*$/);
        if (printMatch) {
            const argRaw = printMatch[1].trim();
            // primitive literal
            const lit = parsePrimitiveLiteral(argRaw);
            if (lit.ok) {
                pushOut(String(lit.value));
                continue;
            }
            // interpolation braces
            const parsedPath = parseForgePathExpression(argRaw);
            if (parsedPath) {
                // check module usage in path-like expressions for system namespaces
                // allow printing Sys.* only if enabled when AllInOne disabled
                const sysLike = argRaw.trim().replace(/^\{|\}$/g, "").trim();
                const sysVal = sysReadValue(sysLike);
                if (sysVal !== null) {
                    if (allInOneDisabled && !enabledModules.has("Sys")) {
                        return {
                            ok: false,
                            output: out,
                            errorMessage: `Runtime error at line ${ln + 1}: Module 'Sys' is not enabled.`,
                        };
                    }
                    pushOut(String(sysVal));
                    continue;
                }
                // variable lookup
                const varName = parsedPath.segments[0];
                let chosenNs = parsedPath.namespace;
                if (!chosenNs) {
                    const hits = [];
                    for (const n of ["l", "v", "c"]) {
                        if (env[n].has(varName))
                            hits.push(n);
                    }
                    if (hits.length === 1)
                        chosenNs = hits[0];
                    else {
                        return {
                            ok: false,
                            output: out,
                            errorMessage: `Runtime error at line ${ln + 1}: Cannot resolve '${varName}'. Use l./v./c. explicitly.`,
                        };
                    }
                }
                const base = env[chosenNs].get(varName);
                if (base === undefined) {
                    return {
                        ok: false,
                        output: out,
                        errorMessage: `Runtime error at line ${ln + 1}: Unknown variable '${chosenNs}.${varName}'.`,
                    };
                }
                // property chain (MVP supports objects only if present)
                let cur = base;
                for (let idx = 1; idx < parsedPath.segments.length; idx++) {
                    const seg = parsedPath.segments[idx];
                    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
                        const obj = cur;
                        cur = obj[seg];
                    }
                    else {
                        return {
                            ok: false,
                            output: out,
                            errorMessage: `Runtime error at line ${ln + 1}: Cannot access '${seg}' on non-object.`,
                        };
                    }
                }
                pushOut(String(cur));
                continue;
            }
            // fallback
            pushOut(argRaw);
            continue;
        }
        // Sys.exec(...)
        const sysExecMatch = trimmed.match(/^Sys\.exec(\.async)?\(\s*(.+?)\s*\)\s*;?\s*$/);
        if (sysExecMatch) {
            const isAsync = Boolean(sysExecMatch[1]);
            const cmdRaw = sysExecMatch[2].trim();
            if (allInOneDisabled && !enabledModules.has("Sys")) {
                return {
                    ok: false,
                    output: out,
                    errorMessage: `Runtime error at line ${ln + 1}: Module 'Sys' is not enabled.`,
                };
            }
            if (!cfg.allowSysExec) {
                return {
                    ok: false,
                    output: out,
                    errorMessage: `Sys.exec is disabled by default for safety.\n` +
                        `Enable it in settings: forge.system.allowSysExec = true`,
                };
            }
            // Only allow string literal for MVP
            const litCmd = parsePrimitiveLiteral(cmdRaw);
            if (!litCmd.ok || typeof litCmd.value !== "string") {
                return {
                    ok: false,
                    output: out,
                    errorMessage: `Runtime error at line ${ln + 1}: Sys.exec(...) expects a string literal command.`,
                };
            }
            const command = litCmd.value;
            const runExec = () => new Promise((resolve, reject) => {
                (0, child_process_1.exec)(command, { windowsHide: true }, (err, stdout, stderr) => {
                    if (stdout?.trim())
                        pushOut(stdout.trimEnd());
                    if (stderr?.trim())
                        pushOut(stderr.trimEnd());
                    if (err)
                        reject(err);
                    else
                        resolve();
                });
            });
            if (isAsync) {
                // fire and forget (still await a tick to avoid unhandled rejection)
                runExec().catch((e) => pushOut(`[Sys.exec.async error] ${String(e)}`));
            }
            else {
                try {
                    await runExec();
                }
                catch (e) {
                    return {
                        ok: false,
                        output: out,
                        errorMessage: `Sys.exec failed: ${String(e)}`,
                    };
                }
            }
            continue;
        }
        // In MVP runner: ignore other statements (if/while/functions etc.)
        // We do NOT hard-fail; we warn in output for visibility.
        if (/^(if|elif|else|while|for|forEach|func|try|catch|finally|throw|return|async|await)\b/.test(trimmed)) {
            pushOut(`[MVP runner] Skipped unsupported statement at line ${ln + 1}: ${trimmed}`);
            continue;
        }
    }
    // write output to channel
    outputChannel.appendLine(`\n$ forge run: ${path.basename(doc.fileName)}`);
    for (const l of out)
        outputChannel.appendLine(l);
    return { ok: true, output: out };
}
/* =========================================================
   Diagnostics Manager
   ========================================================= */
class ForgeDiagnosticsManager {
    context;
    output;
    collection;
    debounceTimers = new Map();
    statusBar;
    constructor(context, output) {
        this.context = context;
        this.output = output;
        this.collection = vscode.languages.createDiagnosticCollection("forge");
        context.subscriptions.push(this.collection);
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBar.text = "Forge: ready";
        this.statusBar.tooltip = "Forge diagnostics status";
        this.statusBar.show();
        context.subscriptions.push(this.statusBar);
    }
    clear(doc) {
        if (doc)
            this.collection.delete(doc.uri);
        else
            this.collection.clear();
        this.statusBar.text = "Forge: ready";
    }
    schedule(doc, delayMs = 250) {
        if (!isForgeDocument(doc))
            return;
        const key = doc.uri.toString();
        const cfg = getForgeConfig();
        if (!cfg.diagnosticsEnabled) {
            this.clear(doc);
            return;
        }
        const existing = this.debounceTimers.get(key);
        if (existing)
            clearTimeout(existing);
        const t = setTimeout(() => {
            this.debounceTimers.delete(key);
            this.refresh(doc);
        }, delayMs);
        this.debounceTimers.set(key, t);
    }
    refresh(doc) {
        if (!isForgeDocument(doc))
            return;
        const cfg = getForgeConfig();
        if (!cfg.diagnosticsEnabled) {
            this.clear(doc);
            return;
        }
        const res = lintForge(doc.getText());
        const diagnostics = res.issues.map((i) => {
            const start = new vscode.Position(i.line, i.col);
            const end = new vscode.Position(i.line, Math.max(i.col + 1, i.endCol));
            const range = new vscode.Range(start, end);
            const severity = i.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
            const d = new vscode.Diagnostic(range, i.message, severity);
            d.source = "forge";
            d.code = i.code;
            return d;
        });
        this.collection.set(doc.uri, diagnostics);
        const errorCount = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
        const warnCount = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length;
        if (errorCount > 0)
            this.statusBar.text = `Forge: ${errorCount} error(s)`;
        else if (warnCount > 0)
            this.statusBar.text = `Forge: ${warnCount} warning(s)`;
        else
            this.statusBar.text = "Forge: OK";
    }
    getDiagnostics(uri) {
        return this.collection.get(uri) ?? [];
    }
}
/* =========================================================
   Commands
   ========================================================= */
async function commandToggleDiagnostics() {
    const cfg = vscode.workspace.getConfiguration("forge");
    const current = cfg.get("diagnostics.enabled", true);
    await cfg.update("diagnostics.enabled", !current, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`Forge diagnostics: ${!current ? "enabled" : "disabled"}`);
}
async function commandRunFile(diag, output) {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return;
    const doc = editor.document;
    if (!isForgeDocument(doc)) {
        vscode.window.showErrorMessage("Open a .forge file first, then run again.");
        return;
    }
    const cfg = getForgeConfig();
    if (cfg.autoSaveBeforeRun && doc.isDirty) {
        const ok = await doc.save();
        if (!ok) {
            vscode.window.showErrorMessage("I couldn't save the file before running.");
            return;
        }
    }
    // refresh diagnostics
    diag.refresh(doc);
    const diags = diag.getDiagnostics(doc.uri);
    const hasErrors = diags.some((d) => d.severity === vscode.DiagnosticSeverity.Error);
    if (hasErrors) {
        vscode.window.showWarningMessage("Please fix Forge errors first, then run again.");
        return;
    }
    output.clear();
    output.show(true);
    const res = await runForgeMvp(doc, cfg, output);
    if (!res.ok) {
        output.appendLine(`\n[Forge runtime error]\n${res.errorMessage}`);
        vscode.window.showErrorMessage("Forge runtime error. Check Output -> Forge for details.");
    }
}
/* =========================================================
   Activate / Deactivate
   ========================================================= */
function activate(context) {
    const cfg = getForgeConfig();
    const output = vscode.window.createOutputChannel(cfg.outputChannelName);
    context.subscriptions.push(output);
    const diagnostics = new ForgeDiagnosticsManager(context, output);
    // Commands
    context.subscriptions.push(vscode.commands.registerCommand("forge.toggleDiagnostics", () => commandToggleDiagnostics()));
    context.subscriptions.push(vscode.commands.registerCommand("forge.runFile", () => commandRunFile(diagnostics, output)));
    // Doc events
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
        if (!isForgeDocument(doc))
            return;
        diagnostics.refresh(doc);
    }));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
        if (!isForgeDocument(doc))
            return;
        diagnostics.refresh(doc);
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((ev) => {
        if (!isForgeDocument(ev.document))
            return;
        diagnostics.schedule(ev.document, 250);
    }));
    // Config changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((ev) => {
        if (!ev.affectsConfiguration("forge"))
            return;
        const newCfg = getForgeConfig();
        output.appendLine(`[Forge] Configuration updated. diagnostics=${newCfg.diagnosticsEnabled}`);
        // Update output channel name if changed (not typical at runtime; keep simple)
        // If diagnostics toggled off, clear current diagnostics.
        if (!newCfg.diagnosticsEnabled) {
            diagnostics.clear();
        }
        else {
            // refresh current editor if any
            const ed = vscode.window.activeTextEditor;
            if (ed && isForgeDocument(ed.document))
                diagnostics.refresh(ed.document);
        }
    }));
    // initial pass for already opened editor
    const editor = vscode.window.activeTextEditor;
    if (editor && isForgeDocument(editor.document)) {
        diagnostics.refresh(editor.document);
    }
    output.appendLine("[Forge] Extension activated.");
}
function deactivate() {
    // VS Code will dispose subscriptions automatically.
}
//# sourceMappingURL=extension.js.map