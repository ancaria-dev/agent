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
    for (var i = 0; i < SHEET_ATTRS.length; i++) {
        values.push(heroSheet.add(SHEET_ATTRS[i]).readU16());
    }
    return { values: values.join(","),
             points: heroSheet.add(SHEET_ATTR_POINTS).readU8() };
}

function skillsNow() {
    var levels = [];
    for (var i = 0; i < SHEET_SKILL_SLOTS; i++) {
        levels.push(heroSheet.add(SHEET_SKILLS + i).readU8());
    }
    return { levels: levels.join(","),
             points: heroSheet.add(SHEET_SKILL_POINTS).readU16() };
}

command("player.attributes", function () {
    requireHero();
    return attributesNow();
});

// Attributes are not among the anti-cheat's mirrored fields, so a plain write
// followed by the game's own recalculation is the whole job.
command("player.attribute", function (f) {
    requireHero();
    var index = parseInt(f.index, 10);
    if (isNaN(index) || index < 0 || index >= SHEET_ATTRS.length) {
        throw new Error("No attribute " + f.index + ".");
    }
    var value = Math.max(0, Math.min(0xFFFF, parseInt(f.value, 10) || 0));
    heroSheet.add(SHEET_ATTRS[index]).writeU16(value);
    recalc();
    return attributesNow();
});

command("player.skills", function () {
    requireHero();
    return skillsNow();
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

evt("agent.ready", { base: base.toString() });
