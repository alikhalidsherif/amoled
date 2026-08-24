// Expression language for procedural scenes (PLAN.md §Phase 5).
//
// Pipeline: tokenizer -> recursive-descent parser -> AST ->
// compile-once closures. Parse ONCE at scene load; evaluation per pixel
// per frame involves zero string work.
//
// Grammar v1:
//   expression := ternary
//   ternary    := comparison ("?" ternary ":" ternary)?
//   comparison := additive (("==" | "!=" | "<" | ">" | "<=" | ">=") additive)?
//   ternary    := additive ("?" ternary ":" ternary)?
//   additive   := multiplicative (("+" | "-") multiplicative)*
//   multiplicative := unary (("*" | "/" | "%") unary)*
//   unary      := "-" unary | power
//   power      := primary ("^" unary)?            (right associative)
//   primary    := number | identifier | call | "(" ternary ")"
//
// Functions mirror GLSL-ish semantics; documented precisely here so the
// Phase 10 GLSL backend matches:
//   sin cos tan asin acos atan atan2(y,x) abs sqrt pow(b,e)
//   min max floor ceil fract mod(a,b)=a-b*floor(a/b)
//   clamp(v,lo,hi) mix(a,b,t) lerp=alias smoothstep(e0,e1,x)
//   step(edge,x) exp log sign distance(x1,y1,x2,y2) length(x,y)
//   noise(x,y)  -- seeded value noise from env.seed

import { valueNoise } from "./prng.js";

// ------------------------------------------------------------------
// Tokenizer
// ------------------------------------------------------------------

const TOKEN_RE = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|<=|>=|==|!=|[-+*/%^<>?:(),]))/y;

function tokenize(src) {
    const tokens = [];
    let pos = 0;
    TOKEN_RE.lastIndex = 0;
    while (pos < src.length) {
        TOKEN_RE.lastIndex = pos;
        const m = TOKEN_RE.exec(src);
        if (!m || m.index !== pos) {
            const rest = src.slice(pos);
            if (!rest.trim()) break;
            throw new AmoExprError(`unexpected character at ${pos}: "${rest.trim()[0]}"`);
        }
        pos = TOKEN_RE.lastIndex;
        if (m[1] !== undefined) tokens.push({ type: "num", value: parseFloat(m[1]), pos });
        else if (m[2] !== undefined) tokens.push({ type: "ident", name: m[2], pos });
        else tokens.push({ type: "op", op: m[3], pos });
    }
    return tokens;
}

export class AmoExprError extends Error {
    constructor(message) {
        super(message);
        this.name = "AmoExprError";
    }
}

// ------------------------------------------------------------------
// Parser -> AST
// ------------------------------------------------------------------

const VARIABLES = new Set(["x", "y", "t", "frame", "width", "height", "u", "v", "seed", "progress", "p"]);

const FUNCTIONS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos,
    atan: Math.atan,
    atan2: { fn: Math.atan2, arity: 2 },
    abs: Math.abs, sqrt: Math.sqrt,
    pow: { fn: Math.pow, arity: 2 },
    min: { fn: Math.min, arity: 2 }, max: { fn: Math.max, arity: 2 },
    floor: Math.floor, ceil: Math.ceil,
    fract: { fn: v => v - Math.floor(v), arity: 1 },
    mod: { fn: (a, b) => (b === 0 ? 0 : a - b * Math.floor(a / b)), arity: 2 },
    clamp: { fn: (v, lo, hi) => v < lo ? lo : v > hi ? hi : v, arity: 3 },
    mix: { fn: (a, b, t) => a + (b - a) * t, arity: 3 },
    lerp: { fn: (a, b, t) => a + (b - a) * t, arity: 3 },
    smoothstep: {
        fn: (e0, e1, x) => {
            if (e1 === e0) return x < e0 ? 0 : 1;
            const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
            return u * u * (3 - 2 * u);
        },
        arity: 3
    },
    step: { fn: (edge, x) => (x < edge ? 0 : 1), arity: 2 },
    exp: Math.exp, log: Math.log,
    sign: Math.sign,
    distance: { fn: (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1), arity: 4 },
    length: { fn: (x, y) => Math.hypot(x, y), arity: 2 },
    noise: { fn: (x, y) => NaN, arity: 2 } // bound to env seed at compile
};

function parseExpressionProgram(src) {
    const tokens = tokenize(src);
    let pos = 0;

    function peek() { return tokens[pos]; }
    function expectOp(op) {
        const tk = tokens[pos];
        if (!tk || tk.type !== "op" || tk.op !== op) {
            throw new AmoExprError(`expected "${op}" at ${tk ? tk.pos : "end"}`);
        }
        pos++;
    }

    function parseTernary() {
        const cond = parseComparison();
        const tk = peek();
        if (tk && tk.type === "op" && tk.op === "?") {
            pos++;
            const thenE = parseTernary();
            expectOp(":");
            const elseE = parseTernary();
            return { kind: "cond", cond, thenE, elseE };
        }
        return cond;
    }

    function parseComparison() {
        let left = parseAdditive();
        for (;;) {
            const tk = peek();
            if (tk && tk.type === "op" && ["<", ">", "<=", ">=", "==", "!="].includes(tk.op)) {
                pos++;
                left = { kind: "cmp", op: tk.op, left, right: parseAdditive() };
            } else return left;
        }
    }

    function parseAdditive() {
        let left = parseMultiplicative();
        for (;;) {
            const tk = peek();
            if (tk && tk.type === "op" && (tk.op === "+" || tk.op === "-")) {
                pos++;
                left = { kind: "bin", op: tk.op, left, right: parseMultiplicative() };
            } else return left;
        }
    }

    function parseMultiplicative() {
        let left = parseUnary();
        for (;;) {
            const tk = peek();
            if (tk && tk.type === "op" && (tk.op === "*" || tk.op === "/" || tk.op === "%")) {
                pos++;
                left = { kind: "bin", op: tk.op, left, right: parseUnary() };
            } else return left;
        }
    }

    function parseUnary() {
        const tk = peek();
        if (tk && tk.type === "op" && tk.op === "-") {
            pos++;
            return { kind: "neg", arg: parseUnary() };
        }
        return parsePower();
    }

    function parsePower() {
        const base = parsePrimary();
        const tk = peek();
        if (tk && tk.type === "op" && (tk.op === "^" || tk.op === "**")) {
            pos++;
            return { kind: "pow", base, exp: parseUnary() }; // right assoc
        }
        return base;
    }

    function parsePrimary() {
        const tk = peek();
        if (!tk) throw new AmoExprError("unexpected end of expression");
        if (tk.type === "num") { pos++; return { kind: "num", value: tk.value }; }
        if (tk.type === "ident") {
            pos++;
            const nx = peek();
            if (nx && nx.type === "op" && nx.op === "(") {
                if (!FUNCTIONS[tk.name]) {
                    throw new AmoExprError(`unknown function "${tk.name}" at ${tk.pos}`);
                }
                pos++;
                const args = [];
                const first = peek();
                if (first && first.type === "op" && first.op === ")") {
                    pos++;
                } else {
                    for (;;) {
                        args.push(parseTernary());
                        const sep = peek();
                        if (sep && sep.type === "op" && sep.op === ",") { pos++; continue; }
                        expectOp(")");
                        break;
                    }
                }
                return { kind: "call", name: tk.name, args };
            }
            if (!VARIABLES.has(tk.name)) {
                throw new AmoExprError(`unknown identifier "${tk.name}" at ${tk.pos}`);
            }
            return { kind: "var", name: tk.name };
        }
        if (tk.type === "op" && tk.op === "(") {
            pos++;
            const inner = parseTernary();
            expectOp(")");
            return inner;
        }
        throw new AmoExprError(`unexpected token "${tk.op ?? tk.name ?? tk.value}" at ${tk.pos}`);
    }

    const ast = parseTernary();
    if (pos < tokens.length) {
        throw new AmoExprError(`trailing input at ${tokens[pos].pos}`);
    }
    return ast;
}

// ------------------------------------------------------------------
// Compiler: AST -> closure tree. Zero allocation per evaluation.
// ------------------------------------------------------------------

function compileNode(node) {
    switch (node.kind) {
        case "num": {
            const v = node.value;
            return () => v;
        }
        case "var": {
            // x/y arrive as positional arguments (hot path); everything else
            // lives on the environment object.
            if (node.name === "x") return (x) => x;
            if (node.name === "y") return (_x, y) => y;
            const name = node.name;
            return (_x, _y, E) => {
                const v = E[name];
                return typeof v === "number" ? v : 0;
            };
        }
        case "neg": {
            const arg = compileNode(node.arg);
            return (x, y, E) => -arg(x, y, E);
        }
        case "bin": {
            const L = compileNode(node.left);
            const R = compileNode(node.right);
            switch (node.op) {
                case "+": return (x, y, E) => L(x, y, E) + R(x, y, E);
                case "-": return (x, y, E) => L(x, y, E) - R(x, y, E);
                case "*": return (x, y, E) => L(x, y, E) * R(x, y, E);
                case "/": return (x, y, E) => safeDiv(L(x, y, E), R(x, y, E));
                case "%": return (x, y, E) => {
                    const r = R(x, y, E);
                    const l = L(x, y, E);
                    if (r === 0) return 0;
                    const m = l % r;
                    return (m < 0 ? m + Math.abs(r) : m);
                };
            }
            break;
        }
        case "pow": {
            const B = compileNode(node.base);
            const X = compileNode(node.exp);
            return (x, y, E) => {
                const b = B(x, y, E);
                if (b < 0) {
                    // integer exponent support for negative bases
                    const e = X(x, y, E);
                    const ei = Math.round(e);
                    if (Math.abs(e - ei) < 1e-9 && Math.abs(ei) <= 16) {
                        let out = 1;
                        for (let i = 0; i < Math.abs(ei); i++) out *= b;
                        return ei < 0 ? safeDiv(1, out) : out;
                    }
                    return NaN;
                }
                return Math.pow(b, X(x, y, E));
            };
        }
        case "cmp": {
            const L = compileNode(node.left);
            const R = compileNode(node.right);
            switch (node.op) {
                case "<": return (x, y, E) => (L(x, y, E) < R(x, y, E) ? 1 : 0);
                case ">": return (x, y, E) => (L(x, y, E) > R(x, y, E) ? 1 : 0);
                case "<=": return (x, y, E) => (L(x, y, E) <= R(x, y, E) ? 1 : 0);
                case ">=": return (x, y, E) => (L(x, y, E) >= R(x, y, E) ? 1 : 0);
                case "==": return (x, y, E) => (L(x, y, E) === R(x, y, E) ? 1 : 0);
                case "!=": return (x, y, E) => (L(x, y, E) !== R(x, y, E) ? 1 : 0);
            }
            break;
        }
        case "cond": {
            const C = compileNode(node.cond);
            const T = compileNode(node.thenE);
            const F = compileNode(node.elseE);
            return (x, y, E) => (C(x, y, E) !== 0 ? T(x, y, E) : F(x, y, E));
        }
        case "call": {
            const spec = FUNCTIONS[node.name];
            const args = node.args.map(compileNode);
            if (node.name === "noise") {
                return (x, y, E) => valueNoise(E.seed | 0, args[0](x, y, E), args[1](x, y, E));
            }
            if (typeof spec === "function") {
                if (args.length !== 1) throw new AmoExprError(`${node.name}: expected 1 argument, got ${args.length}`);
                const A0 = args[0];
                return (x, y, E) => spec(A0(x, y, E));
            }
            if (args.length !== spec.arity) {
                throw new AmoExprError(`${node.name}: expected ${spec.arity} arguments, got ${args.length}`);
            }
            const fn = spec.fn;
            if (args.length === 1) { const A = args[0]; return (x, y, E) => fn(A(x, y, E)); }
            if (args.length === 2) { const [A, B] = args; return (x, y, E) => fn(A(x, y, E), B(x, y, E)); }
            if (args.length === 3) { const [A, B, C] = args; return (x, y, E) => fn(A(x, y, E), B(x, y, E), C(x, y, E)); }
            const [A0, A1, A2, A3] = args;
            return (x, y, E) => fn(A0(x, y, E), A1(x, y, E), A2(x, y, E), A3(x, y, E));
        }
    }
    throw new AmoExprError(`cannot compile node kind "${node.kind}"`);
}

function safeDiv(a, b) {
    if (b === 0) return a > 0 ? Infinity : a < 0 ? -Infinity : 0;
    return a / b;
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/** True when the source references time (t/frame) — used for static detection. */
export function expressionReferencesTime(source) {
    try {
        const tokens = tokenize(source);
        return tokens.some(tk => tk.type === "ident" && (tk.name === "t" || tk.name === "frame"));
    } catch (e) {
        return false; // invalid expressions are reported at compile time
    }
}

/**
 * Compile an expression source once.
 * @returns {{ eval: (x:number, y:number, E:object) => number, ast: object }}
 */
export function compileExpression(source) {
    const ast = parseExpressionProgram(String(source));
    const fn = compileNode(ast);
    return {
        ast,
        eval: (x, y, E) => {
            const v = fn(x, y, E);
            return typeof v === "number" ? v : Number(v) || 0;
        }
    };
}


// ------------------------------------------------------------------
// GLSL backend (PLAN.md §Phase 10). Same AST -> GLSL expression string.
// Determinism caveat: GPU transcendental functions differ from JS in ULPs;
// outputs may differ by ±1/255 after quantization. CPU path remains the
// reference implementation and is used as fallback.
//
// noise() is replicated EXACTLY: the lattice hash uses 32-bit unsigned
// multiply/xor available identically in GLSL ES 3.00.
// ------------------------------------------------------------------

const GLSL_FUNC_MAP = {
    sin: "sin", cos: "cos", tan: "tan", asin: "asin", acos: "acos",
    atan: "atan",
    atan2: "atan",           // GLSL atan(y, x) overloads to 2-arg form
    abs: "abs", sqrt: "sqrt",
    pow: "amo_pow",
    min: "min", max: "max",
    floor: "floor", ceil: "ceil",
    fract: "fract",
    mod: "mod",              // GLSL mod(x,y) === x - y*floor(x/y), matches
    clamp: "clamp",
    mix: "mix", lerp: "mix",
    smoothstep: "smoothstep",
    step: "step",
    exp: "exp", log: "log", sign: "sign",
    distance: "distance", length: "length",
    noise: "amo_noise"
};

export const GLSL_PRELUDE = `
float amo_div(float a, float b) {
    if (b == 0.0) return a > 0.0 ? 3.40282366e38 : (a < 0.0 ? -3.40282366e38 : 0.0);
    return a / b;
}
float amo_pow(float b, float e) {
    if (b < 0.0) {
        float er = round(e);
        if (abs(e - er) < 1e-6 && abs(er) <= 16.0) {
            float out_ = 1.0;
            for (int i = 0; i < 16; i++) {
                if (float(i) >= abs(er)) break;
                out_ *= b;
            }
            return er < 0.0 ? amo_div(1.0, out_) : out_;
        }
        return sqrt(b); // defined fallback, matches nothing — avoid in scenes
    }
    return pow(b, e);
}
float amo_hash(uint seed, int xi, int yi) {
    uint h = (seed ^ (uint(xi) * 374761393u) ^ (uint(yi) * 668265263u));
    h = (h ^ (h >> 13u)) * 1274126177u;
    return float((h ^ (h >> 16u))) / 4294967296.0;
}
float amo_smooth(float u) { return u * u * (3.0 - 2.0 * u); }
float amo_noise(uint seed, float x, float y) {
    float flx = floor(x); float fly = floor(y);
    int xi = int(flx); int yi = int(fly);
    float sx = amo_smooth(x - flx);
    float sy = amo_smooth(y - fly);
    float v00 = amo_hash(seed, xi, yi);
    float v10 = amo_hash(seed, xi + 1, yi);
    float v01 = amo_hash(seed, xi, yi + 1);
    float v11 = amo_hash(seed, xi + 1, yi + 1);
    float a = mix(v00, v10, sx);
    float b = mix(v01, v11, sx);
    return mix(a, b, sy);
}`;

function toGLSLNode(node) {
    switch (node.kind) {
        case "num": return node.value.toFixed(8);
        case "var":
            switch (node.name) {
                case "t": return "uT";
                case "frame": return "float(int(uT * uFps))";
                case "progress": return "uProgress";
                case "seed": return "float(uSeed)";
                default: return node.name; // x y u v width height
            }
        case "neg": return "(-" + toGLSLNode(node.arg) + ")";
        case "cmp": return "(" + toGLSLNode(node.left) + node.op + toGLSLNode(node.right) + " ? 1.0 : 0.0)";
        case "cond": return "(" + toGLSLNode(node.cond) + " != 0.0 ? " +
            toGLSLNode(node.thenE) + " : " + toGLSLNode(node.elseE) + ")";
        case "bin": {
            if (node.op === "/") return "amo_div(" + toGLSLNode(node.left) + ", " + toGLSLNode(node.right) + ")";
            return "(" + toGLSLNode(node.left) + " " + node.op + " " + toGLSLNode(node.right) + ")";
        }
        case "pow": return "amo_pow(" + toGLSLNode(node.base) + ", " + toGLSLNode(node.exp) + ")";
        case "call": {
            if (node.name === "noise") {
                return "amo_noise(uint(uSeed), " + toGLSLNode(node.args[0]) + ", " + toGLSLNode(node.args[1]) + ")";
            }
            const glslName = GLSL_FUNC_MAP[node.name];
            if (!glslName) throw new AmoExprError(`no GLSL mapping for "${node.name}"`);
            return glslName + "(" + node.args.map(toGLSLNode).join(", ") + ")";
        }
        default:
            throw new AmoExprError(`cannot convert node kind "${node.kind}" to GLSL`);
    }
}

/**
 * Compile an expression source to a GLSL expression string (r-value float).
 * Throws AmoExprError for unsupported constructs.
 */
export function compileToGLSL(source) {
    const ast = parseExpressionProgram(String(source));
    return toGLSLNode(ast);
}
