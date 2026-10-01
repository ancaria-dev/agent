// The agent's build check, run outside the game.
//
//     node tests/buildcheck.js
//
// 10-core.js decides at attach whether the module it is looking at is the
// binary the addresses were found in, and warns when it is not.  The failure
// it exists to catch is silent, so it is worth knowing that the check itself
// still fires, and the only other way to find out is to install a stock
// Sacred.exe and start the game.
//
// Frida runs QuickJS and the agent shares one scope, so the harness is the
// host's own recipe: gen/addr.js first, then the module under test, evaluated
// as one script in a context holding fake Frida globals.  Only core is loaded;
// it is where the check lives and every other module would drag in stubs that
// prove nothing.  The fake process is built out of signatures.json, so
// "the expected build" here is the same file the agent compares against.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const AGENT = path.join(ROOT, "src");
const BASE = 0x400000;

const build = JSON.parse(
    fs.readFileSync(path.join(ROOT, "signatures.json"), "utf8"));
const addr = fs.readFileSync(path.join(AGENT, "gen", "addr.js"), "utf8");
const core = fs.readFileSync(path.join(AGENT, "10-core.js"), "utf8");
const RVA = vm.runInNewContext(addr + "\nRVA;");
// However many sites the registry hooks today.
const SITES = Object.keys(build.sig).length;

// A process whose memory holds exactly the bytes the signatures describe, and
// nothing else: reading anywhere the harness did not write is an unmapped page,
// which is also what a smaller image looks like from inside a hook.
function fakeGame(moduleName, bytesAt) {
    const memory = new Map();
    for (const [name, hex] of Object.entries(build.sig)) {
        const at = BASE + RVA[name];
        const write = bytesAt(name, hex);
        for (let i = 0; i < write.length; i += 2) {
            memory.set(at + i / 2, parseInt(write.substring(i, i + 2), 16));
        }
    }
    return { name: moduleName, memory };
}

// Enough NativePointer for core to load: it adds offsets, reads bytes and asks
// whether a pointer is null.  Anything it does with the hero is unreachable
// here, because nothing calls back into the callbacks the harness registers.
function pointer(game, value) {
    return {
        add: (offset) => pointer(game, value + Number(offset)),
        sub: (offset) => pointer(game, value - Number(offset)),
        isNull: () => value === 0,
        toUInt32: () => value >>> 0,
        readU8() {
            if (!game.memory.has(value)) {
                throw new Error(
                    "access violation reading 0x" + value.toString(16));
            }
            return game.memory.get(value);
        },
        readU16: () => 0,
        readU32: () => 0,
    };
}

// Returns everything the agent printed while loading.
function attach(game) {
    const said = [];
    const context = {
        Process: { enumerateModules: () => [{ name: game.name, base: pointer(game, BASE) }] },
        Interceptor: { attach() {} },
        ptr: (value) => pointer(game, Number(value)),
        console: { log: (line) => said.push(String(line)) },
    };
    vm.runInNewContext(addr + "\n" + core, context, { filename: "agent" });
    return said;
}

let failed = 0;

function check(what, condition) {
    console.log((condition ? "ok   " : "FAIL ") + what);
    if (!condition) {
        failed += 1;
    }
}

// The build the addresses were found in: nothing to say.
const right = attach(fakeGame(build.exe, (name, hex) => hex));
check("the expected build draws no warning", right.length === 0);

// A different binary that happens to be called something we attach to.  Three
// sites moved is still three hooks landing in the middle of someone else's
// function, so it is still worth a warning.
const moved = new Set(["hpClamp", "itemMove", "worldLoad"]);
const other = attach(fakeGame("Sacred.exe", (name, hex) =>
    (moved.has(name) ? "90" + hex.substring(2) : hex)));
const warning = other.join("\n");
check("a changed site is reported", other.length === 3);
check("the warning names the expected build",
      warning.includes(build.exe + " " + build.version));
check("the warning names what was found", warning.includes("Sacred.exe"));
check("the warning counts the sites", warning.includes("3 of " + SITES + " hook sites"));
check("the warning names the sites that moved",
      [...moved].every((name) => warning.includes(name)));
check("the warning says what it means for mods",
      warning.includes("Mods may not behave as expected"));

// A binary too small to hold these addresses at all: every read faults.  The
// check has to survive that.  Crashing the game it is warning about would be
// worse than not warning.
const empty = { name: "Game.exe", memory: new Map() };
for (const name of ["hpDamage", "goldDelta"]) {
    empty.memory.set(BASE + RVA[name], 0x00);   // the double-install guard
}
const tiny = attach(empty);
check("an unreadable site is a mismatch, not a crash",
      tiny.join("\n").includes(SITES + " of " + SITES + " hook sites"));

// An agent bundled from a release older than the fingerprint has no BUILD, and
// has to load anyway rather than refusing on a missing table.
const older = attach(fakeGame(build.exe, (name, hex) => hex),
                     addr.replace(/var BUILD = \{[\s\S]*?\n\};\n/, ""));
check("an agent with no fingerprint still loads", older.length === 0);

console.log(failed === 0
    ? "buildcheck: all good"
    : "buildcheck: " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
