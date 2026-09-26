// The taskbar: five weapon slots on the left, five combat art slots on the
// right.  Both live in the hero's own inventory entry, after the 256 bag cells:
//
//   +0xC18 + 24i + 12h   weapon slot i, hand h (0 off hand, 1 weapon hand),
//                        a 12-byte record with the item's ref at +0
//   +0xC90 + 40i + 20f   art slot i, form f (0 knight and every other class,
//                        1 the Vampiress's vampire form), 20 bytes: word type
//                        (0 empty, 2 spell, 3 special move, 4 combo), word
//                        sub, then an art's global id and level, or a
//                        combo's symbol and steps
//   +0xD58 / +0xD5A      the selected weapon slot and art slot
//
// How many slots are open the game works out from the level when it draws
// the bar, through a table of five (level, slots) rows: (0, 1), (2, 2),
// (8, 3), (16, 4), (30, 5).  The table is ordinary game data, so a mod can
// change the levels in memory; the bar rebuilds itself the next time the
// hero clicks an art slot.  A restart brings the game's own levels back.
//
// Using an art is the message the taskbar's right click sends: an action
// event (id 0x105) carrying the target and the art, handed to the hero's
// receive_event.  The game then checks range, mana and recharge itself.

var TASK_BAG_SIZE = 0x1180;
var TASK_BAG_INDEX = 0x1160;
var TASK_BAG_FLAGS = 0x1162;
var TASK_VAMPIRE = 0x2;
var TASK_WEAPONS = 0xC18;
var TASK_WEAPON_HAND = 12;
var TASK_ARTS = 0xC90;
var TASK_ART_RECORD = 20;
var TASK_SELECTED = 0xD58;
var TASK_SLOTS = 5;
var TASK_TABLE_ROWS = 5;
var TASK_SPELL = 2;
var TASK_MOVE = 3;
var TASK_COMBO = 4;
var TASK_COMBO_SYMBOL = 0x200;
var TASK_ITEM_TYPE = 0x118;
var TASK_LEVEL = 0x3FE;

// A world object's position, the part the action event copies.
var TASK_OBJ = { sector: 0x18, x: 0x1C, y: 0x20, layer: 0x24 };
var TASK_EVENT_SIZE = 0x80;
var TASK_EVENT_ID = 0x105;
var TASK_RECEIVE_EVENT = 0x18;

var taskNative = null;

function taskFns() {
    if (taskNative === null) {
        taskNative = {
            setArt: new NativeFunction(at(RVA.setArtSlot), "void",
                                       ["pointer", "uint16", "uint16", "uint16", "pointer"],
                                       { abi: "thiscall" }),
            // (index, kind, notify, extra); the game's own art slot click
            // passes 1, 1, 1 after the index.
            select: new NativeFunction(at(RVA.selectSlot), "void",
                                       ["pointer", "uint16", "uint16", "uint8", "uint32"],
                                       { abi: "thiscall" }),
            pack: new NativeFunction(at(RVA.comboPack), "uint8", ["uint16", "pointer"],
                                     { abi: "stdcall" }),
            // What a right click on an art slot runs, (slot, 1).
            uiArt: new NativeFunction(at(RVA.taskbarSelectArt), "void",
                                      ["pointer", "uint16", "int"], { abi: "thiscall" })
        };
    }
    return taskNative;
}

// The hero's inventory entry, or null outside a world.
function taskBag() {
    if (!live(heroFull)) {
        return null;
    }
    try {
        var mgr = ptr(VA.inventories).readPointer();
        if (mgr.isNull()) {
            return null;
        }
        var index = heroFull.add(0x0C).readU32() >>> 0;
        if (index >= 32) {
            return null;
        }
        var bag = mgr.add(index * TASK_BAG_SIZE);
        return bag.add(TASK_BAG_INDEX).readU16() === index ? bag : null;
    } catch (e) {
        return null;
    }
}

// The level each slot opens at, from the game's table.
function taskUnlockLevels() {
    var out = [];
    for (var i = 0; i < TASK_TABLE_ROWS; i++) {
        out.push(ptr(VA.taskbarSlots).add(i * 4).readU16());
    }
    return out;
}

// What openTaskbarSlots answers: the last row whose level the hero reached.
function taskOpenSlots() {
    var level = heroFull.add(TASK_LEVEL).readU16();
    var table = ptr(VA.taskbarSlots);
    for (var i = TASK_TABLE_ROWS - 1; i >= 0; i--) {
        if (level >= table.add(i * 4).readU16()) {
            return table.add(i * 4 + 2).readU16();
        }
    }
    return TASK_TABLE_ROWS;
}

function taskItemType(ref) {
    var obj = ref ? objectByRef(ref) : null;
    return obj === null ? 0 : obj.add(TASK_ITEM_TYPE).readU32() >>> 0;
}

// One art slot record as type:value:level:steps.  An art gives its global id
// and level, a combo its COMBO tab slot and steps as id/level joined by ','.
function taskArtRecord(bag, slot, form) {
    var rec = bag.add(TASK_ARTS + slot * 2 * TASK_ART_RECORD + form * TASK_ART_RECORD);
    var type = rec.readU16();
    if (type === TASK_SPELL || type === TASK_MOVE) {
        return [type, rec.add(4).readU32(), rec.add(8).readU8(), ""].join(":");
    }
    if (type === TASK_COMBO) {
        var ids = [rec.add(8).readU32(), rec.add(12).readU32()];
        var levels = rec.add(16).readU32();
        var steps = [];
        for (var k = 0; k < 4; k++) {
            var id = (ids[k >> 1] >>> ((k & 1) ? 0 : 16)) & 0xFFFF;
            var level = (levels >>> (24 - 8 * k)) & 0xFF;
            if (id !== 0) {
                steps.push(id + "/" + level);
            }
        }
        return [type, (rec.add(4).readU32() - TASK_COMBO_SYMBOL) >>> 0, 0, steps.join(",")].join(":");
    }
    return "0:0:0:";
}

// An item's fields under a prefix, "w<slot><hand>.", the way item.info gives
// them.  The items module owns them; without it the refs and types still come.
function taskItemInto(out, prefix, ref) {
    if (ref === 0 || typeof itemFields !== "function") {
        return;
    }
    var fields = itemFields(ref);
    for (var key in fields) {
        if (fields[key] !== undefined) {
            out[prefix + key] = fields[key];
        }
    }
}

function taskState(bag, withItems) {
    var weapons = [];
    var items = {};
    for (var i = 0; i < TASK_SLOTS; i++) {
        var off = bag.add(TASK_WEAPONS + i * 2 * TASK_WEAPON_HAND).readU32() >>> 0;
        var main = bag.add(TASK_WEAPONS + (i * 2 + 1) * TASK_WEAPON_HAND).readU32() >>> 0;
        weapons.push([i, off, taskItemType(off), main, taskItemType(main)].join(":"));
        if (withItems) {
            taskItemInto(items, "w" + i + "0.", off);
            taskItemInto(items, "w" + i + "1.", main);
        }
    }
    var arts = [];
    for (var s = 0; s < TASK_SLOTS; s++) {
        for (var f = 0; f < 2; f++) {
            arts.push(s + ":" + f + ":" + taskArtRecord(bag, s, f));
        }
    }
    var state = {
        open: taskOpenSlots(),
        unlock: taskUnlockLevels().join(","),
        form: (bag.add(TASK_BAG_FLAGS).readU16() & TASK_VAMPIRE) ? 1 : 0,
        weapon: bag.add(TASK_SELECTED).readU16(),
        art: bag.add(TASK_SELECTED + 2).readU16(),
        weapons: weapons.join(";"),
        arts: arts.join(";")
    };
    for (var key in items) {
        state[key] = items[key];
    }
    return state;
}

// The taskbar window, cUI_Taskbar2.  Nothing global points at it, so it is
// found once by its vtable in the heap and checked again before every use.
var TASK_WINDOW_NAME = 0x30;
// Compared by its first bytes: the name buffer is not always ended right after.
var TASK_WINDOW_TAG = "UI_WND_TASKBAR";
var taskWindowPtr = null;

function taskWindowOk(p) {
    try {
        return p !== null && p.readPointer().equals(ptr(VA.taskbarVtable)) &&
               p.add(TASK_WINDOW_NAME).readCString(TASK_WINDOW_TAG.length) === TASK_WINDOW_TAG;
    } catch (e) {
        return false;
    }
}

function taskWindow() {
    if (taskWindowOk(taskWindowPtr)) {
        return taskWindowPtr;
    }
    taskWindowPtr = null;
    var vt = ptr(VA.taskbarVtable).toUInt32();
    var pattern = [0, 8, 16, 24].map(function (sh) {
        return ("0" + ((vt >>> sh) & 0xFF).toString(16)).slice(-2);
    }).join(" ");
    var ranges = Process.enumerateRanges("rw-");
    for (var i = 0; i < ranges.length && taskWindowPtr === null; i++) {
        if (ranges[i].size > 0x10000000) {
            continue;
        }
        try {
            var hits = Memory.scanSync(ranges[i].base, ranges[i].size, pattern);
            for (var k = 0; k < hits.length; k++) {
                if (taskWindowOk(hits[k].address)) {
                    taskWindowPtr = hits[k].address;
                    break;
                }
            }
        } catch (e) {}
    }
    return taskWindowPtr;
}

// The level the hero has in an art, base and gear bonus, for the slot to show;
// 1 when the hero lacks it or the arts module is not loaded.
function taskArtLevel(id) {
    var span = typeof heroArtSpan === "function" ? heroArtSpan() : null;
    if (span === null) {
        return 1;
    }
    for (var rec = span[0]; rec.compare(span[1]) < 0; rec = rec.add(ART_SIZE)) {
        if (rec.add(4).readU16() === id) {
            return Math.max(1, Math.min(0xFF, rec.add(6).readU8() + rec.add(7).readU8()));
        }
    }
    return 1;
}

function taskBagOrThrow() {
    var bag = taskBag();
    if (bag === null || isLoading()) {
        throw new Error("No hero found. Load a world first.");
    }
    return bag;
}

function taskSlotArg(raw) {
    var slot = parseInt(raw, 10);
    if (isNaN(slot) || slot < 0 || slot >= TASK_SLOTS) {
        throw new Error("No taskbar slot " + raw + ". Use 0..4.");
    }
    return slot;
}

command("player.taskbar", function () {
    return taskState(taskBagOrThrow(), true);
});

// What an art slot holds in the hero's current form, through the game's own
// setter, the one the taskbar's drop calls.  kind art: id and level; combo:
// the COMBO tab slot; empty clears it.
command("player.taskbar_art", function (f) {
    var slot = taskSlotArg(f.slot);
    var kind = String(f.kind || "");
    var id = parseInt(f.id, 10);
    var level = parseInt(f.level, 10);
    if (kind === "art" && (isNaN(id) || id < 1 || id > 0xFFFF)) {
        throw new Error("Bad art id " + f.id + ".");
    }
    if (kind === "combo" && (isNaN(id) || id < 0 || id > 3)) {
        throw new Error("No combo slot " + f.id + ". Use 0..3.");
    }
    if (kind !== "art" && kind !== "combo" && kind !== "empty") {
        throw new Error("kind is art, combo or empty.");
    }
    taskBagOrThrow();
    if (!later(function () {
        var bag = taskBag();
        if (bag === null) {
            return;
        }
        var fns = taskFns();
        var data = Memory.alloc(0x20);
        if (kind === "art") {
            data.writeU32(id);
            data.add(4).writeU32(isNaN(level) ? taskArtLevel(id) : Math.max(1, Math.min(0xFF, level)));
            fns.setArt(bag, slot, id >= 1000 ? TASK_MOVE : TASK_SPELL, 0, data);
        } else if (kind === "combo") {
            var packed = Memory.alloc(0x20);
            if (!fns.pack(id, packed)) {
                return;
            }
            fns.setArt(bag, slot, TASK_COMBO, packed.add(2).readU16(), packed.add(4));
        } else {
            fns.setArt(bag, slot, 0, 0, data);
        }
    })) {
        throw new Error("Too many game calls waiting.");
    }
    return { ok: 1, slot: slot };
});

// The level each of the five slots opens at, "l1,l2,l3,l4,l5", rising.  A
// write to the game's table in memory, on the engine thread; the save does not
// keep it and a restart undoes it.
command("player.taskbar_unlock", function (f) {
    var parts = String(f.levels || "").split(",");
    if (parts.length !== TASK_TABLE_ROWS) {
        throw new Error("Give five levels, one per slot.");
    }
    var levels = [];
    for (var i = 0; i < parts.length; i++) {
        var level = parseInt(parts[i], 10);
        if (isNaN(level) || level < 0 || level > 0xFFFF || (i > 0 && level < levels[i - 1])) {
            throw new Error("Levels must be 0..65535 and rising.");
        }
        levels.push(level);
    }
    if (!later(function () {
        var table = ptr(VA.taskbarSlots);
        for (var k = 0; k < TASK_TABLE_ROWS; k++) {
            table.add(k * 4).writeU16(levels[k]);
        }
    })) {
        throw new Error("Too many game calls waiting.");
    }
    return { ok: 1, levels: levels.join(",") };
});

// Select an art slot through the taskbar's own right-click method, which
// refuses a slot that is not open and tells the hero which art is ready.
// Seen in the game: the hero then casts from that slot, but the highlight
// frame stays where it was.  Without the taskbar window the slot is selected
// for the hero directly.
//
// Weapon slots are not offered.  The taskbar's weapon method, called like
// this, moved the frame and left the hero holding the old set.
command("player.taskbar_select", function (f) {
    var slot = taskSlotArg(f.slot);
    taskBagOrThrow();
    var bar = taskWindow();
    if (!later(function () {
        var fns = taskFns();
        if (taskWindowOk(bar)) {
            fns.uiArt(bar, slot, 1);
            return;
        }
        var bag = taskBag();
        if (bag !== null) {
            fns.select(bag, slot, 1, 1, 1);
        }
    })) {
        throw new Error("Too many game calls waiting.");
    }
    return { ok: 1, slot: slot };
});

// Tell the hero to use an art (id, the global art id) or a combo (combo, the
// COMBO tab slot), aimed at the creature with ref `target` or, without one,
// at the hero's own spot.  The game decides whether it happens.
command("player.use", function (f) {
    var art = parseInt(f.id, 10);
    if (f.combo !== undefined && f.combo !== "") {
        var combo = parseInt(f.combo, 10);
        if (isNaN(combo) || combo < 0 || combo > 3) {
            throw new Error("No combo slot " + f.combo + ". Use 0..3.");
        }
        art = TASK_COMBO_SYMBOL + combo;
    } else if (isNaN(art) || art < 1 || art >= TASK_COMBO_SYMBOL && art < 1000 || art > 0xFFFF) {
        throw new Error("Bad art id " + f.id + ".");
    }
    var target = parseInt(f.target, 10) || 0;
    if (target !== 0 && objectByRef(target) === null) {
        throw new Error("No object at ref " + f.target + ".");
    }
    taskBagOrThrow();
    if (!later(function () {
        if (!live(heroFull)) {
            return;
        }
        var aim = target !== 0 ? objectByRef(target) : heroFull;
        if (aim === null) {
            return;
        }
        var ev = Memory.alloc(TASK_EVENT_SIZE);
        ev.writePointer(ptr(VA.actionEvent));
        ev.add(0x04).writeU32(TASK_EVENT_ID);
        ev.add(0x10).writeU32(target);
        ev.add(0x14).writeU16(aim.add(TASK_OBJ.sector).readU16());
        ev.add(0x18).writeU32(aim.add(TASK_OBJ.x).readU32());
        ev.add(0x1C).writeU32(aim.add(TASK_OBJ.y).readU32());
        ev.add(0x28).writeU32(100);
        ev.add(0x30).writeU32(art);
        ev.add(0x34).writeU8(aim.add(TASK_OBJ.layer).readU8());
        var receive = heroFull.readPointer().add(TASK_RECEIVE_EVENT).readPointer();
        new NativeFunction(receive, "int", ["pointer", "pointer"],
                           { abi: "thiscall", exceptions: "propagate" })(heroFull, ev);
    })) {
        throw new Error("Too many game calls waiting.");
    }
    return { ok: 1, art: art, target: target };
});

// What changed on the bar, twice a second: a slot's contents, the selection,
// or a newly opened slot.  What a loaded save brings is not a change.
var taskLast = null;

onTickEvery(500, function () {
    var bag = isLoading() ? null : taskBag();
    if (bag === null) {
        taskLast = null;
        return;
    }
    var now;
    try {
        now = taskState(bag, false);
    } catch (e) {
        return;
    }
    var before = taskLast;
    taskLast = now;
    if (before === null) {
        return;
    }
    if (now.open > before.open) {
        evt("taskbar.opened", { prev: before.open, open: now.open });
    }
    var a = before.arts.split(";");
    var b = now.arts.split(";");
    for (var i = 0; i < b.length; i++) {
        if (a[i] !== b[i]) {
            var slotForm = b[i].split(":");
            evt("taskbar.art_changed", {
                slot: slotForm[0], form: slotForm[1],
                prev: a[i].split(":").slice(2).join(":"), now: slotForm.slice(2).join(":")
            });
        }
    }
    var wa = before.weapons.split(";");
    var wb = now.weapons.split(";");
    for (var w = 0; w < wb.length; w++) {
        if (wa[w] !== wb[w]) {
            var p = wa[w].split(":");
            var n = wb[w].split(":");
            var fields = { slot: w, prevOff: p[1], prevMain: p[3],
                           off: n[1], offType: n[2], main: n[3], mainType: n[4] };
            taskItemInto(fields, "w" + w + "0.", parseInt(n[1], 10));
            taskItemInto(fields, "w" + w + "1.", parseInt(n[3], 10));
            evt("taskbar.weapon_changed", fields);
        }
    }
    if (now.weapon !== before.weapon) {
        evt("taskbar.selected", { kind: 0, prev: before.weapon, slot: now.weapon });
    }
    if (now.art !== before.art) {
        evt("taskbar.selected", { kind: 1, prev: before.art, slot: now.art });
    }
});

onHero(function () {
    taskLast = null;
});
