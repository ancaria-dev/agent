// Commands: the direction where a mod acts instead of reacting.
//
// Where the game has its own primitive, Coderpack calls it rather than writing the
// field.  The engine then updates whatever caches and mirrors it keeps, and
// the result matches the UI by construction.  Direct writes are used only where
// no primitive was found (position).
//
// thiscall in Frida takes `this` as the FIRST declared argument, not via
// .call(), and getting that wrong yields an access violation at a nonsense
// address.

var addExperience = new NativeFunction(at(RVA.addExperience), "int",
                                       ["pointer", "int"], { abi: "thiscall" });

function requireHero() {
    if (!live(heroFull)) {
        throw new Error("No hero found. Load a world first.");
    }
}

command("player.state", function () {
    requireHero();
    return heroState();
});

command("player.teleport", function (f) {
    requireHero();
    heroFull.add(0x1C).writeS32(parseInt(f.x, 10));
    heroFull.add(0x20).writeS32(parseInt(f.y, 10));
    return { x: f.x, y: f.y };
});

command("player.hp", function (f) {
    requireHero();
    var value = parseInt(f.value, 10);
    setCreatureStat(heroFull, value, STAT_CURRENT_HP);
    return { hp: heroFull.add(0x4D8).readU32() >>> 0 };
});

command("player.exp", function (f) {
    requireHero();
    addExperience(heroSheet, parseInt(f.amount, 10));
    return { exp: heroFull.add(0x3B4).readU32() >>> 0 };
});

// No callable AddGold entry is mapped yet, so both copies are written and the
// anti-cheat mirrors refreshed, or the checker resets the field to 1.
command("player.gold", function (f) {
    requireHero();
    var value = parseInt(f.value, 10);
    heroFull.add(0x3EE).writeU32(value);
    heroSheet.add(0x46).writeU32(value);
    syncMirrors();
    return { gold: heroFull.add(0x3EE).readU32() >>> 0 };
});

command("player.kill", function () {
    requireHero();
    setCreatureStat(heroFull, 0, STAT_CURRENT_HP);
    return { hp: heroFull.add(0x4D8).readU32() >>> 0 };
});

// The character sheet, read where the game keeps it.  Own names for the
// offsets, because the attribute module that has the same table may be left
// out with --skip.
var SHEET_ATTRS = [0x10, 0x12, 0x14, 0x16, 0x18, 0x1A];
var SHEET_ATTR_POINTS = 0x23;
var SHEET_SKILLS = 0x2C;
// The skill in each slot, 1 Heavenly Magic .. 33 Forge Lore: modifier id - 599.
// Read from the exported hero files, where the sheet lies byte for byte.
var SHEET_SKILL_IDS = 0x24;
var SHEET_SKILL_SLOTS = 8;
var SHEET_SKILL_POINTS = 0x42;
var SHEET_MOVE = 0x40;
var SHEET_RESIST_BASE = 0x66;
var SHEET_RESIST_MULT = 0xD6;

// The derived-stat recalculation, the same one gear and level-ups run.  After
// writing an attribute or a skill this is what makes max HP, damage and the
// rest follow, rather than waiting for the next piece of gear to trigger it.
var commitStatsFn = null;

function recalc() {
    if (commitStatsFn === null) {
        commitStatsFn = new NativeFunction(at(RVA.commitStats), "void",
                                           ["pointer"], { abi: "thiscall" });
    }
    commitStatsFn(heroSheet);
}

function attributesNow() {
    var values = [];
    var bases = [];
    var invested = [];
    for (var i = 0; i < SHEET_ATTRS.length; i++) {
        values.push(heroSheet.add(SHEET_ATTRS[i]).readU16());
        var spent = heroSheet.add(SHEET_INVESTED + i).readU8();
        invested.push(spent);
        bases.push(attributeWithoutGear(i) - spent);
    }
    return { values: values.join(","),
             base: bases.join(","),
             invested: invested.join(","),
             points: heroSheet.add(SHEET_ATTR_POINTS).readU8() };
}

function skillsNow() {
    var levels = [];
    var skills = [];
    for (var i = 0; i < SHEET_SKILL_SLOTS; i++) {
        levels.push(heroSheet.add(SHEET_SKILLS + i).readU8());
        var id = heroSheet.add(SHEET_SKILL_IDS + i).readU8();
        skills.push(id === 0 ? 0 : 599 + id);
    }
    return { levels: levels.join(","),
             skills: skills.join(","),
             points: heroSheet.add(SHEET_SKILL_POINTS).readU16() };
}

command("player.attributes", function () {
    requireHero();
    return attributesNow();
});

// The game keeps no attribute: CalcResults (0x00579AD1) rebuilds each on
// load and on every level-up from the class's base, the level and the points
// invested in it, then adds gear.  So a value is written as invested points,
// and the shown total with it, gear kept, before the game's recalculation:
// the next rebuild then arrives at the same number.  Attributes are not
// among the anti-cheat's mirrored fields.
var SHEET_INVESTED = 0x1C;
var SHEET_BASE_ATTRS = 0x4A;
var SHEET_LEVEL = 0x56;

function attributeWithoutGear(index) {
    var base = heroSheet.add(SHEET_BASE_ATTRS + 2 * index).readU16();
    var level = heroSheet.add(SHEET_LEVEL).readU16();
    return base + Math.floor(base * (level - 1) / 10) +
           heroSheet.add(SHEET_INVESTED + index).readU8();
}

command("player.attribute", function (f) {
    requireHero();
    var index = parseInt(f.index, 10);
    if (isNaN(index) || index < 0 || index >= SHEET_ATTRS.length) {
        throw new Error("No attribute " + f.index + ".");
    }
    var invested = heroSheet.add(SHEET_INVESTED + index).readU8();
    var bare = attributeWithoutGear(index);
    var least = bare - invested;
    var gear = Math.max(0, heroSheet.add(SHEET_ATTRS[index]).readU16() - bare);
    var value = Math.max(least, Math.min(least + 0xFF, parseInt(f.value, 10) || 0));
    heroSheet.add(SHEET_INVESTED + index).writeU8(value - least);
    heroSheet.add(SHEET_ATTRS[index]).writeU16(Math.min(0xFFFF, value + gear));
    recalc();
    return attributesNow();
});

command("player.skills", function () {
    requireHero();
    return skillsNow();
});

// The hero's name, the one the hero select and the saves show: the game's
// getName (0x0044A600), which answers the class's name for a hero never renamed.
var heroNameFn = null;

command("player.name", function () {
    requireHero();
    if (heroNameFn === null) {
        heroNameFn = new NativeFunction(at(RVA.itemName), "pointer", ["pointer"],
                                        { abi: "thiscall" });
    }
    var p = heroNameFn(heroFull);
    return { name: p.isNull() ? "" : p.readUtf16String(64) };
});

// The mark cheats leave on the hero, the one that turns it into a rabbit: the
// word the creature's property 0x24 tests (0x0055DC03), which an exported
// hero's card copies.
var HERO_CHEAT = 0x1FE;

command("player.cheater", function () {
    requireHero();
    return { cheater: heroFull.add(HERO_CHEAT).readU16() !== 0 ? 1 : 0 };
});

command("player.skill", function (f) {
    requireHero();
    var slot = parseInt(f.slot, 10);
    if (isNaN(slot) || slot < 0 || slot >= SHEET_SKILL_SLOTS) {
        throw new Error("No skill slot " + f.slot + ".");
    }
    var value = Math.max(0, Math.min(0xFF, parseInt(f.value, 10) || 0));
    heroSheet.add(SHEET_SKILLS + slot).writeU8(value);
    recalc();
    return skillsNow();
});

// Armour and attack speed come from the game's own getters, which matched the
// character screen exactly.  A resistance is its base times its multiplier,
// rounded, which is what the screen shows per element; the floats sit on
// 2-byte boundaries.
var armorPercentFn = null;
var attackSpeedFn = null;

command("player.sheet", function () {
    requireHero();
    if (armorPercentFn === null) {
        armorPercentFn = new NativeFunction(at(RVA.armorPercent), "int",
                                            ["pointer"], { abi: "thiscall" });
        attackSpeedFn = new NativeFunction(at(RVA.attackSpeed), "int",
                                           ["pointer"], { abi: "thiscall" });
    }
    var resist = [];
    for (var i = 0; i < 4; i++) {
        resist.push(Math.round(
            heroSheet.add(SHEET_RESIST_BASE + i * 4).readFloat() *
            heroSheet.add(SHEET_RESIST_MULT + i * 4).readFloat()));
    }
    return {
        armor: armorPercentFn(heroSheet),
        attackSpeed: attackSpeedFn(heroSheet),
        move: heroSheet.add(SHEET_MOVE).readU16(),
        resist: resist.join(",")
    };
});

command("ui.string", function (f) {
    return { key: f.key, text: uiString(f.key) };
});

command("type.name", function (f) {
    var id = parseInt(f.id, 10);
    return { id: id, name: typeName(id) };
});

// "Enables the Attacking of Animals" is one bit on the hero, +0x200 bit
// 0x10000000, set by the recalculation for each such bonus worn and derived
// afresh every time it runs: a changed item, a new level.  So a mod's choice
// is held, not written once: the tick puts the bit back the way the mod
// wants it until the mod hands it back to the game.  Seen live: with the
// bit from a bonus shield, the hero attacked and killed rabbits.
var ANIMALS_FLAGS = 0x200;
var ANIMALS_BIT = 0x10000000;
var animalsHeld = null;     // null: the game decides; true or false: held

function animalsBitSet() {
    return (heroFull.add(ANIMALS_FLAGS).readU32() & ANIMALS_BIT) !== 0;
}

command("player.animals", function (f) {
    if (!live(heroFull)) {
        throw new Error("No world loaded.");
    }
    if (f.hold === "1" || f.hold === "0") {
        animalsHeld = f.hold === "1";
    } else if (f.hold === "game") {
        animalsHeld = null;
    }
    return { on: animalsBitSet() ? 1 : 0, held: animalsHeld === null ? "game" : (animalsHeld ? "1" : "0") };
});

onTickEvery(250, function () {
    if (animalsHeld === null || isLoading() || !live(heroFull)) {
        return;
    }
    var flags = heroFull.add(ANIMALS_FLAGS).readU32() >>> 0;
    var want = animalsHeld ? (flags | ANIMALS_BIT) >>> 0 : (flags & ~ANIMALS_BIT) >>> 0;
    if (want !== flags) {
        heroFull.add(ANIMALS_FLAGS).writeU32(want);
    }
});

onHero(function () {
    animalsHeld = null;
});

evt("agent.ready", { base: base.toString() });
