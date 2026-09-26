// Friend or foe.  Every creature has a class (+0x1F0: 1 hero, 2 monster, 3 NPC,
// 4 horse, 6 animal, 7 mercenary...) and a 16x16 matrix of classes says which
// are allied.  Seen in the game: writing class 2 into a Horse Dealer made him
// something the hero could attack and kill, so class and matrix are the whole
// answer for the hero.  The quest scripts turn NPCs hostile the same way.
//
// The matrix is saved with the game, so a change a mod makes stays in that
// save.  Writes and game calls go through later(), onto the engine thread.

var ALLY_CLASSES = 16;
var ALLY_CLASS = 0x1F0;
var ALLY_MOUNT = 0x1EC;
var ALLY_FLAGS = 0x1F4;
// +0x1F4 bit that flips the game's answer for either creature (0x00423580).
var ALLY_INVERT = 0x40000;

var allyNative = null;

function allyFns() {
    if (allyNative === null) {
        allyNative = {
            alliances: new NativeFunction(at(RVA.getAlliances), "pointer", [], { abi: "mscdecl" }),
            set: new NativeFunction(at(RVA.setAlliance), "void",
                                    ["pointer", "int", "int", "uint8"], { abi: "thiscall" }),
            reset: new NativeFunction(at(RVA.resetAlliances), "void", [], { abi: "mscdecl" }),
            setClass: new NativeFunction(at(RVA.setCreatureClass), "void",
                                         ["pointer", "int", "int"], { abi: "thiscall" })
        };
    }
    return allyNative;
}

// The matrix as 256 characters, '1' allied, row-major by class.
function allianceMatrix() {
    var bytes = new Uint8Array(ptr(VA.allianceMatrix).readByteArray(ALLY_CLASSES * ALLY_CLASSES));
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
        out += bytes[i] ? "1" : "0";
    }
    return out;
}

function allyClassArg(raw, name) {
    var c = parseInt(raw, 10);
    if (isNaN(c) || c < 1 || c >= ALLY_CLASSES) {
        throw new Error("No creature class " + raw + " for " + name + ". Use 1..15.");
    }
    return c;
}

function allyWorld() {
    if (!live(heroFull) || isLoading()) {
        throw new Error("No world loaded.");
    }
}

command("world.alliances", function () {
    return { matrix: allianceMatrix() };
});

// Through the game's own setter, which writes both directions.
command("world.alliance_set", function (f) {
    var a = allyClassArg(f.a, "a");
    var b = allyClassArg(f.b, "b");
    var allied = f.allied === "1" || f.allied === "true" ? 1 : 0;
    allyWorld();
    if (!later(function () {
        var fns = allyFns();
        fns.set(fns.alliances(), a, b, allied);
    })) {
        throw new Error("Too many game calls waiting.");
    }
    return { a: a, b: b, allied: allied };
});

command("world.alliance_reset", function () {
    allyWorld();
    if (!later(function () { allyFns().reset(); })) {
        throw new Error("Too many game calls waiting.");
    }
    return {};
});

// Does A treat B as an enemy?  The game's own answer (0x00423580) walks the
// same steps, read here without calling it: the matrix, a ridden horse judged
// by its rider, and the flag that turns the answer round.  It also has a few
// type pairs and a per-creature grudge list that are left out; see the
// areEnemies row in mappings.
command("world.enemies", function (f) {
    var refA = parseInt(f.a, 10);
    var refB = parseInt(f.b, 10);
    if (creatureFields(refA) === null || creatureFields(refB) === null) {
        throw new Error("Both refs must be creatures.");
    }
    if (refA === refB) {
        return { a: refA, b: refB, enemies: 0 };
    }
    var a = objectByRef(refA);
    var b = objectByRef(refB);
    var judged = b;
    if (creatureFields(refB).horse === 1) {
        var rider = objectByRef(b.add(ALLY_MOUNT).readU32() >>> 0);
        if (rider !== null) {
            judged = rider;
        }
    }
    var ca = a.add(ALLY_CLASS).readU32() >>> 0;
    var cb = judged.add(ALLY_CLASS).readU32() >>> 0;
    var enemies = 1;
    if (ca < ALLY_CLASSES && cb < ALLY_CLASSES) {
        enemies = ptr(VA.allianceMatrix).add(ca * ALLY_CLASSES + cb).readU8() === 0 ? 1 : 0;
    }
    if (((a.add(ALLY_FLAGS).readU32() | b.add(ALLY_FLAGS).readU32()) & ALLY_INVERT) !== 0) {
        enemies = 1 - enemies;
    }
    return { a: refA, b: refB, enemies: enemies };
});

// The game's own class setter, the one the quest scripts use.  The creature
// is found again on the engine thread: the game reuses a ref once its
// creature is gone.  The reply is the creature as the setter left it.
//
// Class 0 means "as it was": the class the creature had before the loader
// first changed it.  The setter's own reset gives the class of the type's
// data, which is not always the class the world placed it with: a town's
// Nobleman is NPC in the street and HUMAN, an enemy, by his type.  That reset
// is only the fallback for a creature the loader never changed.
var allyOriginal = {};

commandLater("world.class_set", function (f) {
    var cls = f.cls === "0" ? 0 : allyClassArg(f.cls, "cls");
    var before = creatureExpected(f);
    var ref = before.ref;
    allyWorld();
    return function () {
        var now = creatureFields(ref);
        if (now === null || now.type !== before.type) {
            throw new Error("The creature at ref " + ref + " is gone.");
        }
        var kept = allyOriginal[ref];
        if (kept !== undefined && kept.type !== now.type) {
            kept = undefined;
            delete allyOriginal[ref];
        }
        if (cls === 0) {
            delete allyOriginal[ref];
            if (kept !== undefined) {
                allyFns().setClass(objectByRef(ref), 1, kept.cls);
            } else {
                allyFns().setClass(objectByRef(ref), 0, 0);
            }
        } else {
            if (kept === undefined) {
                allyOriginal[ref] = { type: now.type, cls: now.cclass };
            }
            allyFns().setClass(objectByRef(ref), 1, cls);
        }
        return creatureFields(ref);
    };
});

// A change to the matrix, whoever made it: a mod, a quest effect, a loaded
// save.  Sampled once a second and reported per changed pair.  The first
// reading after a load is how the save left it, not a change.
var allianceLast = null;

onTickEvery(1000, function () {
    if (isLoading() || !live(heroFull)) {
        allianceLast = null;
        return;
    }
    var now;
    try {
        now = allianceMatrix();
    } catch (e) {
        return;
    }
    var before = allianceLast;
    allianceLast = now;
    if (before === null || before === now) {
        return;
    }
    for (var a = 1; a < ALLY_CLASSES; a++) {
        for (var b = a; b < ALLY_CLASSES; b++) {
            var i = a * ALLY_CLASSES + b;
            var j = b * ALLY_CLASSES + a;
            if (now[i] !== before[i] || now[j] !== before[j]) {
                evt("alliance.changed", { a: a, b: b, allied: now[i] === "1" ? 1 : 0 });
            }
        }
    }
});

onHero(function () {
    allianceLast = null;
    allyOriginal = {};
});
