// Making creatures and setting their level, the way the game's own summons
// and script ambushes do it: createByType at a position, then the sheet's
// level setter with "exact", then the class setter.  All of it runs on the
// engine thread, and the reply carries the new creature.
//
// A call made from inside the tick is invisible to Frida's interceptors, so
// the create hook never sees these creatures: the Spawn event is sent here.

var SPAWNER_SHEET = 0x3A8;
var SPAWNER_POS = 0x18;
var SPAWNER_POS_SIZE = 16;
var SPAWNER_LEVEL_MAX = 250;
// Hero classes 1..9 share the type field with creature types; a hero is not
// something to make.
var SPAWNER_FIRST_TYPE = 10;

var spawnerNative = null;

function spawnerFns() {
    if (spawnerNative === null) {
        spawnerNative = {
            create: new NativeFunction(at(RVA.createByType), "uint32",
                                       ["pointer", "int", "pointer", "int", "int", "int"],
                                       { abi: "thiscall", exceptions: "propagate" }),
            level: new NativeFunction(at(RVA.setCreatureLevel), "void",
                                      ["pointer", "uint16", "uint8", "uint8"],
                                      { abi: "thiscall", exceptions: "propagate" }),
            setClass: new NativeFunction(at(RVA.setCreatureClass), "void",
                                         ["pointer", "int", "int"], { abi: "thiscall" })
        };
    }
    return spawnerNative;
}

function spawnerInt(f, key, min, max) {
    if (f[key] === undefined || f[key] === "") {
        return 0;
    }
    var n = parseInt(f[key], 10);
    if (isNaN(n) || n < min || n > max) {
        throw new Error(key + " must be " + min + ".." + max + ", not " + f[key] + ".");
    }
    return n;
}

// The type's family byte, 3 for every creature (see world.objects).
function spawnerIsCreatureType(type) {
    try {
        return type < 0x7E60 &&
               ptr(VA.itemTypes).readPointer().add(type * 0x80 + 0x2E).readU8() === 3;
    } catch (e) {
        return false;
    }
}

function spawnerType(f) {
    var type = f.type === undefined ? NaN : parseInt(f.type, 10);
    if (isNaN(type) && f.name !== undefined) {
        var found = typeIds()[f.name];
        type = found === undefined ? NaN : found;
    }
    var name = isNaN(type) ? null : typeName(type);
    if (type < SPAWNER_FIRST_TYPE || name === null || !CREATURE_TYPES.test(name) ||
            !spawnerIsCreatureType(type)) {
        throw new Error("No creature type " + (f.name || f.type) + ".");
    }
    return type;
}

// The level through the game's setter (0x00565010), with "exact": the level
// as given.  The same setter recomputes the creature from it and fills its HP
// to the new maximum, as it does for a fresh summon.
//
// 250 is the game's limit, not ours: with "uncapped" the setter still takes
// anything above 0xFA down to 250 (0x005657BC).  A higher number could only
// be written into +0x3FE directly, and then nothing derived from the level
// would follow it.  Without "uncapped" the setter also caps at the
// difficulty's and the sector's limit, which a mod asking for a level does
// not want.
function spawnerLevel(obj, level) {
    spawnerFns().level(obj.add(SPAWNER_SHEET), level, 1, 1);
}

// A level the game picks, the way it sets up a quest's NPCs (0x0046251D):
// neither exact nor uncapped, around the hero's level.  The setter spreads it
// by the difficulty and caps it at the difficulty's and the sector's limit.
// Without this a new creature stays at level 1 with 100 HP, the blank the
// factory makes: every caller in the game sets a level afterwards.
function spawnerGameLevel(obj) {
    spawnerFns().level(obj.add(SPAWNER_SHEET), heroFull.add(0x3FE).readU16(), 0, 0);
}

// Max and current HP both, raw: the game's own setter has no clamp.  Healing
// clamps to max, so a creature keeps an HP above its level's only with a
// matching max.  The game's next recalculation of the creature (a level
// change, a reload) puts the max back.
function spawnerHp(obj, hp) {
    setCreatureStat(obj, hp, 1);
    setCreatureStat(obj, hp, STAT_CURRENT_HP);
}

// Fields: type or name; x and y in world units; optional level (1..250),
// hp and cls (1..15).  Without x and y, the hero's own spot; without a level,
// the game picks one.
commandLater("world.spawn", function (f) {
    if (!live(heroFull) || isLoading()) {
        throw new Error("No world loaded.");
    }
    var type = spawnerType(f);
    var level = spawnerInt(f, "level", 1, SPAWNER_LEVEL_MAX);
    var hp = spawnerInt(f, "hp", 1, INT32_MAX);
    var cls = spawnerInt(f, "cls", 1, 15);
    var hasPlace = f.x !== undefined && f.y !== undefined;
    var x = hasPlace ? spawnerInt(f, "x", -INT32_MAX, INT32_MAX) : 0;
    var y = hasPlace ? spawnerInt(f, "y", -INT32_MAX, INT32_MAX) : 0;
    var hero = heroFull;
    return function () {
        if (!same(hero, heroFull)) {
            throw new Error("The world changed before the creature was made.");
        }
        // The hero's own position record with the new point: the sector
        // is looked up again by the game when it does not hold the point.
        var pos = Memory.alloc(SPAWNER_POS_SIZE);
        Memory.copy(pos, hero.add(SPAWNER_POS), SPAWNER_POS_SIZE);
        if (hasPlace) {
            pos.add(4).writeS32(x);
            pos.add(8).writeS32(y);
        }
        var fns = spawnerFns();
        var ref = fns.create(ptr(VA.objectManager).readPointer(), type, pos, 0, 0, 0) >>> 0;
        if (ref === 0 || creatureFields(ref) === null) {
            throw new Error("The game made no creature there.");
        }
        var obj = objectByRef(ref);
        if (level) {
            spawnerLevel(obj, level);
        } else {
            spawnerGameLevel(obj);
        }
        if (cls) {
            fns.setClass(obj, 1, cls);
        }
        if (hp) {
            spawnerHp(obj, hp);
        }
        var fields = creatureFields(ref);
        evt("entity.spawn", fields);
        return fields;
    };
});

// Level of a creature already in the world.  Found again on the engine
// thread, because the game gives a gone creature's ref to the next object.
// Never the hero: its level is guarded by the game's anti-cheat mirror.
commandLater("world.level_set", function (f) {
    var level = spawnerInt(f, "level", 1, SPAWNER_LEVEL_MAX);
    var before = creatureExpected(f);
    var ref = before.ref;
    if (before.player === 1) {
        throw new Error("The hero's level comes from experience.");
    }
    if (level === 0) {
        throw new Error("level must be 1.." + SPAWNER_LEVEL_MAX + ".");
    }
    return function () {
        var now = creatureFields(ref);
        if (now === null || now.type !== before.type) {
            throw new Error("The creature at ref " + ref + " is gone.");
        }
        spawnerLevel(objectByRef(ref), level);
        return creatureFields(ref);
    };
});

// Max and current HP of a creature already in the world, together.
commandLater("world.max_hp", function (f) {
    var hp = spawnerInt(f, "hp", 1, INT32_MAX);
    var before = creatureExpected(f);
    var ref = before.ref;
    if (hp === 0) {
        throw new Error("hp must be 1.." + INT32_MAX + ".");
    }
    return function () {
        var now = creatureFields(ref);
        if (now === null || now.type !== before.type) {
            throw new Error("The creature at ref " + ref + " is gone.");
        }
        spawnerHp(objectByRef(ref), hp);
        return creatureFields(ref);
    };
});
