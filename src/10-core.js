// Process base, hero capture, pointer helpers.  Everything else builds on this.
//
// Two rules learned the hard way and enforced here:
//   * a NativePointer taken from a register or retval can alias the live
//     register -- snapshot it with snapPtr before storing;
//   * the game keeps the hero as a "sheet" struct embedded in a bigger object
//     at +0x3A8, and combat code hands out the sheet while stat code hands out
//     the full object, so both pointers are kept and derived from each other.

// Which module is the game.  The addresses belong to pureHD.exe, the community
// HD wrapper, but a player may be running the stock Sacred.exe or a renamed
// copy, so the first of these that is loaded wins.  Module names come back
// spelled the way the file is spelled on disk and Windows does not care about
// that, so neither does the match.
//
// This is the only list of them on the JavaScript side.
var GAME_MODULES = ["pureHD.exe", "Sacred.exe", "Game.exe"];

function gameModule() {
    var loaded = Process.enumerateModules();
    for (var i = 0; i < GAME_MODULES.length; i++) {
        var wanted = GAME_MODULES[i].toLowerCase();
        for (var j = 0; j < loaded.length; j++) {
            if (loaded[j].name.toLowerCase() === wanted) {
                return loaded[j];
            }
        }
    }
    throw new Error("No game module found in this process. Looked for " +
                    GAME_MODULES.join(", ") + ".");
}

var gameMod = gameModule();
var base = gameMod.base;

// Refuse to install on top of another Coderpack.  A globalThis flag cannot do this:
// every Frida script gets its own JS runtime, so the second injection would see
// a clean scope and hook the same instructions a second time -- every boost
// applied twice, silently.
//
// What is actually shared is the game's code, so that is what gets checked: an
// inline hook overwrites the instruction with a relative jump.  This can miss an
// exotic trampoline encoding, never report one that is not there.
function alreadyHooked(rva) {
    var byte = base.add(rva).readU8();
    return byte === 0xE9 || byte === 0xCC;
}

if (alreadyHooked(RVA.hpDamage) || alreadyHooked(RVA.goldDelta)) {
    throw new Error("Coderpack (or another Frida agent) is already hooked into this " +
                    "process. Restart the game—closing the host doesn’t always " +
                    "unload an injected agent.");
}

// Is this the build the addresses came from?  The executable lookup takes the
// first of three names, so a stock Sacred.exe or a differently-versioned wrapper
// attaches perfectly well and then gets pureHD RVAs applied to it -- hooks that
// land in the middle of some other function, silently.
//
// What is checked is the code itself, not the version resource.  The question
// worth answering is whether these addresses still mean what they meant, and
// the bytes at the sites answer it directly: the stock Sacred.exe differs at all
// twenty of them.  Version metadata answers something narrower and does it
// badly here -- pureHD.exe carries the stock game's OriginalFilename and spells
// its FileVersion "2.28" while the fixed block says 2.0.2.118 -- and reading it
// from in here means parsing the mapped resource directory of a binary we have
// just decided we do not recognise.
//
// The image has its relocations stripped and no /DYNAMICBASE, so it always
// loads at 0x00400000 and these bytes are the file's bytes.  BUILD comes from
// gen/addr.js; an agent bundled without one skips the check rather than
// refusing to load.
function siteBytesMatch(rva, hex) {
    var site = base.add(rva);
    for (var i = 0; i < hex.length; i += 2) {
        if (site.add(i / 2).readU8() !== parseInt(hex.substring(i, i + 2), 16)) {
            return false;
        }
    }
    return true;
}

function checkBuild() {
    if (typeof BUILD === "undefined" || !BUILD.sig) {
        return;
    }
    var differ = [];
    var checked = 0;
    for (var name in BUILD.sig) {
        if (RVA[name] === undefined) {
            continue;
        }
        checked += 1;
        var same;
        try {
            same = siteBytesMatch(RVA[name], BUILD.sig[name]);
        } catch (e) {
            // Past the end of a smaller image, or an unreadable page.  Either
            // way it is not the instruction we expected, and a check that
            // crashes the game it is warning about is worse than no check.
            same = false;
        }
        if (!same) {
            differ.push(name);
        }
    }
    if (differ.length === 0) {
        return;
    }
    var shown = differ.slice(0, 4).join(", ") + (differ.length > 4 ? ", …" : "");
    console.log("!! This isn’t the game build where Coderpack’s addresses were found.");
    console.log("!! Expected " + BUILD.exe + " " + BUILD.version + ", found " +
                gameMod.name + ". " + differ.length + " of " + checked +
                " hook sites hold different instructions (" + shown + ").");
    console.log("!! Hooking it anyway at the current addresses. " +
                "Mods may not behave as expected.");
}

checkBuild();

var SHEET_EMBED = 0x3A8;
var INT32_MAX = 2147483647;

var heroSheet = null;
var heroFull = null;

function at(rva) {
    return base.add(rva);
}

function snapPtr(p) {
    if (p === null || p === undefined) {
        return null;
    }
    try {
        return p.isNull() ? null : ptr(p.toUInt32() >>> 0);
    } catch (e) {
        return null;
    }
}

function live(p) {
    return p !== null && p !== undefined && !p.isNull();
}

function same(a, b) {
    if (!live(a) || !live(b)) {
        return false;
    }
    return (a.toUInt32() >>> 0) === (b.toUInt32() >>> 0);
}

// Combat and gold code hands out the sheet, stat code the full object, so the
// capture path has to accept either.
function noteHeroSheet(sheet) {
    return live(sheet) ? noteHeroFull(sheet.sub(SHEET_EMBED)) : false;
}

function isHeroSheet(p) {
    return same(p, heroSheet);
}

function isHeroFull(p) {
    return same(p, heroFull);
}

// A creature is plausible as the hero if its class id, level and HP all sit in
// the ranges the game itself uses.  Cheap enough to run on every capture and it
// keeps a stray pointer from becoming "the player".
function looksLikeHero(full) {
    try {
        var cls = full.add(0x10).readU32() >>> 0;
        var hp = full.add(0x4D8).readU32() >>> 0;
        var maxHp = full.add(0x4D4).readU32() >>> 0;
        var level = full.add(0x3FE).readU16();
        return cls >= 1 && cls <= 9 &&
               maxHp >= 10 && maxHp <= 500000 && hp <= maxHp &&
               level >= 1 && level <= 250;
    } catch (e) {
        return false;
    }
}

var heroListeners = [];

function onHero(fn) {
    heroListeners.push(fn);
    if (live(heroFull)) {
        try { fn(heroFull, heroSheet); } catch (e) {}
    }
}

function noteHeroFull(full) {
    if (!live(full) || !looksLikeHero(full)) {
        return false;
    }
    var changed = !isHeroFull(full);
    heroFull = snapPtr(full);
    heroSheet = snapPtr(full.add(SHEET_EMBED));
    if (changed) {
        for (var i = 0; i < heroListeners.length; i++) {
            try { heroListeners[i](heroFull, heroSheet); } catch (e) {}
        }
    }
    return true;
}

// Is the game busy loading?  Asking a mod for a verdict stops the game thread
// until the answer comes back, and doing that inside world/hero load is how the
// process dies: gold is handed out during load, so the gold hook -- the only
// ASK site that fires there -- crashed every fresh start while attaching to an
// already-loaded world was fine.  The window is tracked here rather than in the
// session module so it holds even when that module is not loaded.
// Every Interceptor goes through here so a single site can be disabled from
// the command line (--no-hook goldEpilogue).  Bisecting a crash down to one
// instruction otherwise means editing JavaScript between game restarts.
var DISABLED = (typeof NO_HOOK === "undefined") ? [] : NO_HOOK;
var TRACE = (typeof HOOK_TRACE !== "undefined") && HOOK_TRACE;

function hook(name, rva, callbacks) {
    // Interceptor.attach takes a bare function as a shorthand for onEnter, and
    // health uses it.  Normalising here keeps every caller on one shape.
    if (typeof callbacks === "function") {
        callbacks = { onEnter: callbacks };
    }
    if (DISABLED.indexOf(name) >= 0) {
        console.log("hook " + name + " disabled");
        return;
    }
    if (TRACE) {
        // console.log reaches the host as a log message, which it prints as it
        // arrives -- so when the game dies, the last line names the hook that
        // was running.  A crash that kills the process leaves no other trace.
        var body = callbacks.onEnter;
        var after = callbacks.onLeave;
        var traced = {
            onEnter: function (args) {
                console.log("> " + name);
                if (body) {
                    body.call(this, args);
                }
            }
        };
        // Only if the hook already had one.  Adding an onLeave to a
        // mid-function site makes Frida track a return address that is not
        // there -- the tracing would cause the very crash it is looking for.
        if (after) {
            traced.onLeave = function (retval) {
                after.call(this, retval);
                console.log("< " + name);
            };
        }
        callbacks = traced;
    }
    Interceptor.attach(at(rva), callbacks);
}

var loading = 0;

function whileLoading(name, rva) {
    hook(name, rva, {
        onEnter: function () {
            loading += 1;
        },
        onLeave: function () {
            // Attaching in the middle of a load would otherwise leave this
            // negative, and the guard permanently off.
            loading = loading > 0 ? loading - 1 : 0;
        }
    });
}

whileLoading("loadWindowWorld", RVA.worldLoad);
whileLoading("loadWindowHero", RVA.heroLoad);

function isLoading() {
    return loading > 0;
}

// getLocalHero runs constantly and is the one hot site that has always been
// safe to hook, so work that needs to happen "soon, but not at a specific
// instruction" rides on it instead of earning its own trampoline.
var tickListeners = [];

function onTick(fn) {
    tickListeners.push(fn);
}

hook("heroCapture", RVA.getLocalHero, {
    onLeave: function (retval) {
        if (!retval.isNull() && !isHeroFull(retval)) {
            noteHeroFull(retval);
        }
        for (var i = 0; i < tickListeners.length; i++) {
            try {
                tickListeners[i]();
            } catch (e) {}
        }
    }
});
