// The agent's JavaScript handled as text: what the release strips out of it,
// and what it reads out of it. A port of protocol's former src/js.rs; the
// output must stay byte for byte what that produced.
//
// `compact` is the whole of the minification. It removes comments, indentation
// and blank lines and collapses runs of spaces, and nothing else: no renaming,
// no reordering, no dropping of anything declared. Every module shares one
// scope, so a minifier that decided a top-level function was unused would ship
// an agent that loads and then silently does less. Line breaks stay because
// automatic semicolon insertion depends on them.
//
// `sites` reads the hook names back out. Every site is installed through a call
// that takes its own name first and its address second,
// `hook("goldDelta", RVA.goldDelta, ...)`, so a hook missing from the list is
// a hook nobody can switch off.

const CODE = 0;
const LINE = 1;
const BLOCK = 2;
const TEXT = 3;
const TEMPLATE = 4;
const REGEX = 5;

const ALNUM = /^[\p{Alphabetic}\p{N}]$/u;
const SPACE = /^\p{White_Space}$/u;
const WORD = /^[A-Za-z0-9_]$/;

/** Minifies one module: comments and layout out, code untouched. */
export function compact(source) {
    return scan(source, true);
}

/** Removes the comments and leaves the layout alone. */
export function stripComments(source) {
    return scan(source, false);
}

function scan(source, tight) {
    const chars = Array.from(source);
    const out = [];
    let state = CODE;
    let quote = "";
    // Whether anything but whitespace is on this line yet, and whether a space
    // is owed before the next code character.
    let codeOnLine = false;
    let owed = false;
    // The last code character: `/` after a value divides, after anything else
    // it opens a regular expression.
    let prev = "\0";
    let i = 0;

    const emit = (c) => {
        if (tight && owed) {
            out.push(" ");
            owed = false;
        }
        out.push(c);
        codeOnLine = true;
    };
    const line = () => {
        if (!tight || codeOnLine) {
            out.push("\n");
        }
        codeOnLine = false;
        owed = false;
    };
    const escaped = () => {
        emit(chars[i]);
        if (i + 1 < chars.length) {
            emit(chars[i + 1]);
        }
        i += 2;
    };

    while (i < chars.length) {
        const c = chars[i];
        const next = i + 1 < chars.length ? chars[i + 1] : "\0";
        switch (state) {
        case CODE:
            if (c === "/" && next === "/") {
                state = LINE;
                i += 2;
                continue;
            }
            if (c === "/" && next === "*") {
                state = BLOCK;
                i += 2;
                continue;
            }
            if (c === "\n") {
                line();
                i += 1;
                continue;
            }
            if (c === " " || c === "\t" || c === "\r") {
                if (tight) {
                    // Leading whitespace is dropped rather than owed.
                    owed = codeOnLine;
                } else {
                    out.push(c);
                }
                i += 1;
                continue;
            }
            emit(c);
            if (c === "\"" || c === "'") {
                state = TEXT;
                quote = c;
            } else if (c === "`") {
                state = TEMPLATE;
            } else if (c === "/" && opensRegex(prev)) {
                state = REGEX;
            }
            prev = c;
            i += 1;
            break;
        case LINE:
            // The newline is left to CODE, which knows whether the line had code.
            if (c === "\n") {
                state = CODE;
                continue;
            }
            i += 1;
            break;
        case BLOCK:
            if (c === "*" && next === "/") {
                state = CODE;
                i += 2;
                continue;
            }
            if (c === "\n") {
                line();
            }
            i += 1;
            break;
        case TEXT:
            if (c === "\\") {
                escaped();
                continue;
            }
            emit(c);
            // A raw newline ends a broken string, so a typo cannot swallow
            // the rest of the file.
            if (c === quote || c === "\n") {
                state = CODE;
                prev = quote;
            }
            i += 1;
            break;
        case TEMPLATE:
            if (c === "\\") {
                escaped();
                continue;
            }
            emit(c);
            if (c === "`") {
                state = CODE;
                prev = "`";
            }
            i += 1;
            break;
        case REGEX:
            if (c === "\\") {
                escaped();
                continue;
            }
            if (c === "[") {
                // A `/` inside a character class does not end the literal.
                const end = charClass(chars, i);
                for (let k = i; k < end; k += 1) {
                    emit(chars[k]);
                }
                i = end;
                continue;
            }
            if (c === "\n") {
                // No regular expression spans a line: that `/` was a division.
                state = CODE;
                continue;
            }
            emit(c);
            if (c === "/") {
                state = CODE;
                prev = "/";
            }
            i += 1;
            break;
        }
    }
    return out.join("");
}

/** The index just past the character class that opens at `from`. */
function charClass(chars, from) {
    let i = from;
    while (i < chars.length) {
        const c = chars[i];
        if (c === "\\" && i + 1 < chars.length) {
            i += 2;
            continue;
        }
        i += 1;
        if (c === "]" || c === "\n") {
            break;
        }
    }
    return i;
}

function opensRegex(prev) {
    return !(ALNUM.test(prev) || "_$)]}\"'`/".includes(prev));
}

/** The hook sites one module installs, in the order it installs them. */
export function sites(source) {
    const text = Array.from(stripComments(source));
    const found = [];
    let i = 0;
    while (i + 4 <= text.length) {
        if (text[i] === "R" && text[i + 1] === "V" && text[i + 2] === "A" && text[i + 3] === ".") {
            const name = namedBefore(text, i);
            if (name !== null && !found.includes(name)) {
                found.push(name);
            }
            i += 4;
            continue;
        }
        i += 1;
    }
    return found;
}

/** Walks back from `RVA.` over `, "name"` and the call that opened it. */
function namedBefore(text, at) {
    let i = skipBack(text, at - 1);
    if (i < 0 || text[i] !== ",") {
        return null;
    }
    i = skipBack(text, i - 1);
    if (i < 0 || text[i] !== "\"") {
        return null;
    }
    const end = i;
    let start = i - 1;
    while (start >= 0 && text[start] !== "\"") {
        start -= 1;
    }
    if (start < 0) {
        return null;
    }
    const name = text.slice(start + 1, end).join("");
    if (name === "" || !Array.from(name).every((c) => WORD.test(c)) || /^[0-9]/.test(name)) {
        return null;
    }
    // Whatever opened the call has to be a name: an argument list, not a pair.
    const paren = skipBack(text, start - 1);
    if (paren < 0 || text[paren] !== "(") {
        return null;
    }
    const before = paren - 1;
    if (before < 0 || !WORD.test(text[before])) {
        return null;
    }
    return name;
}

/** The first index at or before `from` that is not whitespace, or -1. */
function skipBack(text, from) {
    let i = from;
    while (i >= 0 && SPACE.test(text[i])) {
        i -= 1;
    }
    return i;
}

/** The module name `--skip` takes: 50-health.js is health. */
export function moduleName(file) {
    let name = file;
    while (name.endsWith(".js")) {
        name = name.slice(0, -3);
    }
    return name.replace(/^[0-9-]+/, "");
}
