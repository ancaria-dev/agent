// Everything user-facing has two names and both matter: the internal type name
// ("TYPE_NPC_GHUL01") is stable English and the right key for mod logic, while
// the display string is localized and is the only thing safe to show a player.
// Sacred really does localize item and region names, so neither can be dropped.

var typeNameFn = null;
var uiStringFn = null;
var uiStringThis = null;
var typeNames = {};

function typeName(typeId) {
    if (typeNames[typeId] !== undefined) {
        return typeNames[typeId];
    }
    var name = null;
    try {
        if (typeNameFn === null) {
            typeNameFn = new NativeFunction(at(RVA.typeNameFn), "pointer",
                                            ["int"], { abi: "mscdecl" });
        }
        var p = typeNameFn(typeId);
        if (!p.isNull()) {
            // Fixed-size padded records: stop at NUL or at the 0xFF filler.
            var out = "";
            for (var i = 0; i < 64; i++) {
                var b = p.add(i).readU8();
                if (b === 0 || b >= 0x80) {
                    break;
                }
                out += String.fromCharCode(b);
            }
            name = out.length ? out : null;
        }
    } catch (e) {
        name = null;
    }
    typeNames[typeId] = name;
    return name;
}

function uiString(key) {
    try {
        if (uiStringFn === null) {
            uiStringFn = new NativeFunction(at(RVA.uiStringFn), "pointer",
                                            ["pointer", "pointer"],
                                            { abi: "thiscall" });
            // ECX is only touched on a miss (the game returns this+0xC), so a
            // scratch buffer is a safe `this` for a read-only lookup.
            uiStringThis = Memory.alloc(64);
        }
        var entry = uiStringFn(uiStringThis, Memory.allocUtf8String(key));
        if (entry.isNull()) {
            return null;
        }
        var str = entry.readPointer();
        if (str.isNull()) {
            return null;
        }
        var wide = str.readUtf16String(200);
        return (wide === null || wide === "") ? str.readCString(200) : wide;
    } catch (e) {
        return null;
    }
}

// The reverse direction: name -> id.
//
// A mod must never hardcode a type id.  They are build-specific numbers with no
// meaning, and a mod that says 5171 is a mod nobody can read or port, while
// "TYPE_OBJECT_POTION_SMALL_RED" says what it is.  The game has no reverse
// lookup, so one is built by asking typeName for every id once and keeping what
// answers.  It costs a few thousand table lookups, on the Frida thread, once
// per session, and only if some mod actually asks.
//
// Ids are bounds-checked inside typeName (`cmp ecx, edx / jge` against the
// table length), so an id past the end returns its "Bad Item" record rather
// than reading off the end.  That record fails the name pattern below, which is
// also what filters out every other junk answer.
var TYPE_SCAN_LIMIT = 0x4000;
var TYPE_NAME_SHAPE = /^TYPE_[A-Z0-9_]+$/;

var typeIndex = null;

function typeIds() {
    if (typeIndex !== null) {
        return typeIndex;
    }
    var found = {};
    for (var id = 0; id < TYPE_SCAN_LIMIT; id++) {
        var name = typeName(id);
        if (name !== null && TYPE_NAME_SHAPE.test(name)) {
            found[name] = id;
        }
    }
    typeIndex = found;
    return found;
}

command("type.find", function (f) {
    var id = typeIds()[f.name];
    return id === undefined ? { name: f.name } : { name: f.name, id: id };
});

// One frame carries the whole answer: the caller is a mod building a table at
// startup, and 140 rune names in one line beats 140 round-trips.
command("type.list", function (f) {
    var prefix = f.prefix || "";
    var index = typeIds();
    var pairs = [];
    for (var name in index) {
        if (name.indexOf(prefix) === 0) {
            pairs.push(name + ":" + index[name]);
        }
    }
    return { prefix: prefix, n: pairs.length, types: pairs.join(",") };
});

// Hero classes: full+0x10 is 1..9 for heroes and a creature type id for
// everything else, the same field, which is what makes Player : Entity work.
var CLASSES = {
    1: "Seraphim", 2: "Gladiator", 3: "Battlemage", 4: "DarkElf",
    5: "WoodElf", 6: "Vampiress", 7: "VampiressForm", 8: "Dwarf", 9: "Daemon"
};

// Creatures share the object manager with items, effects, lights and scenery,
// and share nothing else with them: reading max HP off a sword returns noise
// (1197494489 in one sample).  The type name is what tells them apart, and
// typeName is cached per id, so asking costs a lookup the first time only.
var CREATURE_TYPES = /^TYPE_(NPC|NATURE)_/;

// A creature by ref, as flat wire fields, or null when the ref is not one.
function creatureFields(ref) {
    var obj = objectByRef(ref);
    if (obj === null) {
        return null;
    }
    try {
        var typeId = obj.add(0x10).readU32() >>> 0;
        // Hero classes 1..9 sit in the same field and name as TYPE_NPC_* too.
        var name = typeName(typeId);
        if (name === null || !CREATURE_TYPES.test(name)) {
            return null;
        }
        return {
            ref: ref,
            type: typeId,
            name: name,
            level: obj.add(0x3FE).readU16(),
            hp: obj.add(0x4D8).readU32() >>> 0,
            maxHp: obj.add(0x4D4).readU32() >>> 0,
            x: obj.add(0x1C).readS32(),
            y: obj.add(0x20).readS32(),
            player: isHeroFull(obj) ? 1 : 0
        };
    } catch (e) {
        return null;
    }
}

function describe(full) {
    if (!live(full)) {
        return null;
    }
    try {
        var typeId = full.add(0x10).readU32() >>> 0;
        return {
            typeId: typeId,
            name: typeName(typeId),
            level: full.add(0x3FE).readU16(),
            hp: full.add(0x4D8).readU32() >>> 0,
            maxHp: full.add(0x4D4).readU32() >>> 0,
            x: full.add(0x1C).readS32(),
            y: full.add(0x20).readS32(),
            player: isHeroFull(full)
        };
    } catch (e) {
        return null;
    }
}
