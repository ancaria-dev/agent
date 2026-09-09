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

var setCreatureStat = new NativeFunction(at(RVA.setCreatureStat), "void",
                                         ["pointer", "int", "int"],
                                         { abi: "thiscall" });
var addExperience = new NativeFunction(at(RVA.addExperience), "int",
                                       ["pointer", "int"], { abi: "thiscall" });

var STAT_CURRENT_HP = 2;

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

command("ui.string", function (f) {
    return { key: f.key, text: uiString(f.key) };
});

command("type.name", function (f) {
    var id = parseInt(f.id, 10);
    return { id: id, name: typeName(id) };
});

evt("agent.ready", { base: base.toString() });
