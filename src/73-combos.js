// Combos, the COMBO tab: four slots on the sheet, each a chain of up to four
// combat arts the hero fires in one go.  The store is a std::vector of 38-byte
// records, [sheet+0x10E] begin and [sheet+0x112] end, always four, in tab
// order (top left, top right, bottom left, bottom right):
//
//   +0x00 word      symbol     0x200 + slot; the action id the combo fires with
//   +0x02 dword[4]  step ids   0 empty, 1..72 a spell, 1000 and up a special move
//   +0x12 word[4]   step levels
//   +0x1A float     recharge total
//   +0x1E float     recharge rate, charge per second
//   +0x22 float     charge; ready once it reaches the total
//
// A step id is the global art id the item modifiers use, not the per-class id
// of the combat-art records in 72-arts.js.
//
// The game's own setter writes a whole slot and works out its recharge, and
// the save carries the vector, so a combo a mod writes stays in that save.

var COMBO_BEGIN = 0x10E;
var COMBO_END = 0x112;
var COMBO_SIZE = 38;
var COMBO_SLOTS = 4;
var COMBO_STEPS = 4;
var COMBO = { symbol: 0x00, steps: 0x02, levels: 0x12, total: 0x1A, rate: 0x1E, charge: 0x22 };
var COMBO_LEVEL_MAX = 0xFF;

var comboSetFn = null;

// The record of one slot, or null when there is no hero or no such slot.
function comboRecord(slot) {
    if (!live(heroSheet)) {
        return null;
    }
    try {
        var begin = heroSheet.add(COMBO_BEGIN).readPointer();
        var end = heroSheet.add(COMBO_END).readPointer();
        if (begin.isNull() || begin.add((slot + 1) * COMBO_SIZE).compare(end) > 0) {
            return null;
        }
        return begin.add(slot * COMBO_SIZE);
    } catch (e) {
        return null;
    }
}

// Filled steps as "id/level" joined by ',', in firing order.
function comboSteps(record) {
    var out = [];
    for (var k = 0; k < COMBO_STEPS; k++) {
        var id = record.add(COMBO.steps + 4 * k).readU32() & 0xFFFF;
        var level = record.add(COMBO.levels + 2 * k).readU16();
        if (id !== 0 && level !== 0) {
            out.push(id + "/" + level);
        }
    }
    return out.join(",");
}

// slot:ready:charge:seconds:steps.  Charge is the HUD ring's 0..1, seconds the
// tooltip's recharge time, total / rate.
function comboPacked(slot, record) {
    var total = record.add(COMBO.total).readFloat();
    var rate = record.add(COMBO.rate).readFloat();
    var charge = record.add(COMBO.charge).readFloat();
    var ratio = total > 0 ? Math.max(0, Math.min(1, charge / total)) : 0;
    var seconds = rate > 0 ? total / rate : total;
    return [slot, charge >= total ? 1 : 0, ratio.toFixed(3), seconds.toFixed(1),
            comboSteps(record)].join(":");
}

command("player.combos", function () {
    var out = [];
    for (var slot = 0; slot < COMBO_SLOTS; slot++) {
        var record = comboRecord(slot);
        if (record === null) {
            throw new Error("No hero found. Load a world first.");
        }
        out.push(comboPacked(slot, record));
    }
    var answer = { n: out.length, combos: out.join(";") };
    // The arts module owns the art records; skipped, the steps stay unlinked.
    var arts = typeof artsPacked === "function" ? artsPacked() : null;
    if (arts !== null) {
        answer.arts = arts.arts;
        answer.cls = arts.cls;
    }
    return answer;
});

// steps: "id/level" joined by ',', up to four; empty clears the slot.  The
// game checks nothing here: the master offers only arts the hero owns, and
// an id neither art table knows just adds no recharge.
command("player.combo_set", function (f) {
    var slot = parseInt(f.slot, 10);
    if (isNaN(slot) || slot < 0 || slot >= COMBO_SLOTS) {
        throw new Error("No combo slot " + f.slot + ". Use 0..3.");
    }
    var ids = [];
    var levels = [];
    var raw = f.steps === undefined ? "" : String(f.steps);
    if (raw.length > 0) {
        var parts = raw.split(",");
        if (parts.length > COMBO_STEPS) {
            throw new Error("A combo has at most four steps.");
        }
        for (var i = 0; i < parts.length; i++) {
            var pair = parts[i].split("/");
            var id = parseInt(pair[0], 10);
            var level = parseInt(pair[1], 10);
            if (isNaN(id) || id < 1 || id > 0xFFFF || isNaN(level) ||
                    level < 1 || level > COMBO_LEVEL_MAX) {
                throw new Error("Bad combo step " + parts[i] + ".");
            }
            ids.push(id);
            levels.push(level);
        }
    }
    if (comboRecord(slot) === null || isLoading()) {
        throw new Error("No world loaded.");
    }
    if (!later(function () {
        var record = comboRecord(slot);
        if (record === null) {
            return;
        }
        var stepBuf = Memory.alloc(4 * COMBO_STEPS);
        var levelBuf = Memory.alloc(2 * COMBO_STEPS);
        for (var k = 0; k < COMBO_STEPS; k++) {
            stepBuf.add(4 * k).writeU32(k < ids.length ? ids[k] : 0);
            levelBuf.add(2 * k).writeU16(k < levels.length ? levels[k] : 0);
        }
        if (comboSetFn === null) {
            comboSetFn = new NativeFunction(at(RVA.comboSet), "void",
                                            ["pointer", "uint16", "pointer", "pointer", "uint16"],
                                            { abi: "thiscall" });
        }
        comboSetFn(heroSheet, slot, stepBuf, levelBuf, record.add(COMBO.symbol).readU16());
    })) {
        throw new Error("Too many game calls waiting.");
    }
    return { ok: 1, slot: slot };
});

// The hero fires a combo: its readiness check, reached once per right click
// with a combo selected.  Asked only when the game says it is charged; a veto
// answers "not charged" and the game takes its own refusal path.  The other
// caller is a summon checking its master's combo and is left alone.
hook("comboReady", RVA.comboReady, {
    onEnter: function (args) {
        this.combo = -1;
        if (live(heroSheet) && this.context.ecx.equals(heroSheet) &&
                this.returnAddress.equals(at(RVA.comboStartReturn))) {
            this.combo = args[0].toUInt32() & 0xFFFF;
        }
    },
    onLeave: function (retval) {
        if (this.combo < 0 || (retval.toUInt32() & 0xFF) === 0) {
            return;
        }
        var record = comboRecord(this.combo);
        if (record === null) {
            return;
        }
        var steps;
        try {
            steps = comboSteps(record);
        } catch (e) {
            return;
        }
        var verdict = ask("combo.use", { slot: this.combo, steps: steps });
        if (verdict.cancel) {
            retval.replace(ptr(0));
            return;
        }
        evt("combo.used", { slot: this.combo, steps: steps });
    }
});

// A slot's steps changed, whoever changed them: the master, a mod.  Sampled
// twice a second; the combos a save brings are not a change.
var comboLast = null;

onTickEvery(500, function () {
    if (isLoading() || !live(heroSheet)) {
        comboLast = null;
        return;
    }
    var now = [];
    for (var slot = 0; slot < COMBO_SLOTS; slot++) {
        var record = comboRecord(slot);
        if (record === null) {
            comboLast = null;
            return;
        }
        try {
            now.push(comboSteps(record));
        } catch (e) {
            return;
        }
    }
    var before = comboLast;
    comboLast = now;
    if (before === null) {
        return;
    }
    for (var i = 0; i < COMBO_SLOTS; i++) {
        if (before[i] !== now[i]) {
            evt("combo.changed", { slot: i, prev: before[i], steps: now[i] });
        }
    }
});

onHero(function () {
    comboLast = null;
});
