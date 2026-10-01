// Items: picked up, stored, equipped, dragged.
//
// Everything here addresses an item by its object-manager `ref`, never by its
// address.  The heap moves every launch, the ref does not move within a
// session, and it is what the game's own functions take.
//
// The pickup event is the one place in Coderpack where a mod can veto AND redirect,
// and neither is a trick: cCreature::pickupItem reads the item out of
// objectByIndex(ref) and, when that comes back NULL, jumps straight to its own
// epilogue (`je 0x0055937C` at +0x158380).  So writing 0 into the argument is
// the game's own "nothing there" path, and writing another ref makes the very
// same code pick up a different object.  The argument slot is checked rather
// than guessed: the body reads it at [esp+0x6C] after pushing 0x68 bytes, which
// is [esp+4] at the entry, which is args[0].

var ITEM = {
    ref: 0x0C,
    type: 0x10,
    minLevel: 0x12C,
    level: 0x131,
    // Words, not bytes: a sword set to 150 read 150 here, and the damage words
    // next to it held 20..24 physical, 10..14 fire and 8..12 magic, the
    // tooltip's own numbers.  Minimums at +0x134, maximums eight bytes on, in
    // the order physical, fire, magic, poison.
    attack: 0x144,
    defense: 0x146,
    damageMin: 0x134,
    damageMax: 0x13C,
    protectionA: 0x14A,
    protectionB: 0x14E,
    nameText: 0x3C,
    modFlags: 0x152,
    modIds: 0x162,
    modValues: 0x182,
    // A SECOND copy of the type id, and the reason retyping was cosmetic: we
    // wrote +0x10, the game kept reading this one.  Confirmed on four items,
    // two runes and two potions, where it equalled +0x10 exactly.
    type2: 0x118,
    // Base value.  Small red potion 400, large red 1200, exactly 3x.  Runes 5
    // and 6.  The displayed price is derived from it (it moves with charisma),
    // which is why nothing changed when only the type did.
    price: 0x120
};

// Eight modifier slots, and the geometry proves it: the id array is 8 dwords
// at +0x162 and ends exactly where the value array begins at +0x182, which is
// 8 words ending at +0x192.  Ids pair with values by index.
//
// A slot is three fields, not two.  The id dword carries a parameter in its
// high word (803 with 5 reads "+15% Mental Regeneration": the attribute the
// bonus comes from), and a flags word sits at +0x152.  Packed as
// id:value[:param[:flags]], the last two only when set, so the common case
// still reads 811:30.
//
// This is where an item's actual EFFECT lives, as opposed to its type id, which
// is only what it is called.  Retyping a rune renames it and leaves it doing
// what it did.
var MOD_SLOTS = 8;

function readMods(obj) {
    var pairs = [];
    try {
        for (var i = 0; i < MOD_SLOTS; i++) {
            var full = obj.add(ITEM.modIds + i * 4).readU32() >>> 0;
            var id = full & 0xFFFF;
            if (id === 0) {
                break;
            }
            var param = full >>> 16;
            var flags = obj.add(ITEM.modFlags + i * 2).readU16();
            var entry = id + ":" + obj.add(ITEM.modValues + i * 2).readU16();
            if (param !== 0 || flags !== 0) {
                entry += ":" + param;
            }
            if (flags !== 0) {
                entry += ":" + flags;
            }
            pairs.push(entry);
        }
    } catch (e) {}
    return pairs.join(",");
}

// Replaces the whole list, clearing the slots past it: "the modifiers are
// exactly these".  Seen in the game: a sword rewritten to 811:30,809:25,802:20
// lost its five old lines and showed Attack Speed +30, +25% to Attack and
// Weapon Damage Fire +20.  That first rewrite wrote only the id word and left
// an old param behind ("+25% Mental Regeneration to Attack"), which is why all
// three fields are written now, a param or flags left out meaning 0.
function writeMods(obj, packed) {
    var pairs = packed === "" ? [] : packed.split(",");
    for (var i = 0; i < MOD_SLOTS; i++) {
        var part = i < pairs.length ? pairs[i].split(":") : [];
        var id = (parseInt(part[0], 10) || 0) & 0xFFFF;
        var value = parseInt(part[1], 10) || 0;
        var param = (parseInt(part[2], 10) || 0) & 0xFFFF;
        var flags = parseInt(part[3], 10) || 0;
        obj.add(ITEM.modIds + i * 4).writeU32(((param << 16) | id) >>> 0);
        obj.add(ITEM.modFlags + i * 2).writeU16(id === 0 ? 0 : flags);
        obj.add(ITEM.modValues + i * 2).writeU16(id === 0 ? 0 : value);
    }
}

// What the player reads: the name and the modifier lines exactly as the
// tooltip shows them, from the game's own functions.  cItem::getName takes the
// item's own name text when it has one (a magic item's whole name, "Fabulous
// Helmet of Oblivion") and its type's otherwise.  The tooltip's line builder
// formats one modifier slot of a block that starts at item + 0x118, and works
// as well on a block built here, which is how any id gets its text.
//
// Both go through the game's text cache, which may read a text it has not
// needed yet from global.res and keep it.  Commands call them on Frida's
// thread, as ui.string always has.
var ITEM_BLOCK = 0x118;
var BLOCK_SIZE = 0x80;
var itemText = null;

function itemTextNatives() {
    if (itemText === null) {
        itemText = {
            name: new NativeFunction(at(RVA.itemName), "pointer", ["pointer"],
                                     { abi: "thiscall" }),
            line: new NativeFunction(at(RVA.modifierLine), "void",
                                     ["pointer", "pointer", "pointer", "int", "pointer"],
                                     { abi: "thiscall" }),
            out: Memory.alloc(4096),
            cursor: Memory.alloc(4),
            block: Memory.alloc(BLOCK_SIZE)
        };
    }
    return itemText;
}

function itemDisplayName(obj) {
    var p = itemTextNatives().name(obj);
    return p.isNull() ? null : p.readUtf16String(200);
}

// One tooltip line of a block, as [colour, text]; null for an empty slot.
// The game writes "\cAARRGGBB" before the text and a newline after it.
function modifierLine(block, index) {
    var n = itemTextNatives();
    n.out.writeU32(0);
    n.cursor.writePointer(n.out);
    n.line(block, n.cursor, block, index, ptr(0));
    var text = n.out.readUtf16String(2000) || "";
    var colour = "";
    var m = /^\\c([0-9a-fA-F]{8})/.exec(text);
    if (m !== null) {
        colour = m[1].toLowerCase();
        text = text.substring(m[0].length);
    }
    // A bonus for one class carries a second code after the class name.
    text = text.replace(/\\c[0-9a-fA-F]{8}/g, "").replace(/\s+$/, "");
    return text === "" ? null : [colour, text];
}

// Flat fields, because that is what the wire carries.  The display name is
// left to item.info: it comes from the game's text cache, and item events fire
// for every piece a spawning NPC puts on.  The internal type name is the
// stable key and the one a mod should match on.
function itemFields(ref) {
    var obj = objectByRef(ref);
    if (obj === null) {
        return { ref: ref };
    }
    try {
        var typeId = obj.add(ITEM.type).readU32() >>> 0;
        return {
            ref: ref,
            type: typeId,
            name: typeName(typeId) || ("type" + typeId),
            level: obj.add(ITEM.level).readU8(),
            min: obj.add(ITEM.minLevel).readU8(),
            atk: obj.add(ITEM.attack).readU16(),
            def: obj.add(ITEM.defense).readU16(),
            pmin: obj.add(ITEM.damageMin).readU16(),
            fmin: obj.add(ITEM.damageMin + 2).readU16(),
            mmin: obj.add(ITEM.damageMin + 4).readU16(),
            xmin: obj.add(ITEM.damageMin + 6).readU16(),
            pmax: obj.add(ITEM.damageMax).readU16(),
            fmax: obj.add(ITEM.damageMax + 2).readU16(),
            mmax: obj.add(ITEM.damageMax + 4).readU16(),
            xmax: obj.add(ITEM.damageMax + 6).readU16(),
            prot: obj.add(ITEM.protectionA).readU8() +
                  obj.add(ITEM.protectionB).readU8(),
            price: obj.add(ITEM.price).readU32() >>> 0,
            mods: readMods(obj),
            // Only when the two copies disagree, which on an untouched item
            // they never do, so seeing this field at all means something wrote
            // one of them.
            type2: (obj.add(ITEM.type2).readU32() >>> 0) === typeId
                ? undefined
                : obj.add(ITEM.type2).readU32() >>> 0
        };
    } catch (e) {
        return { ref: ref };
    }
}

// Rewriting an item in place.
//
// The type id at +0x10 is what everything else about an item is looked up
// from: its name, its sprite, what it does when used.  Writing it turns one
// item into another.  The display NAME cannot be set: Sacred composes it from
// affixes at draw time, so the type is the only handle, and changing it changes
// the name as a consequence.
//
// The other mapped fields (levels, attack, defense, damage, price) are plain
// numbers and writable the same way, through the same command, so a mod does
// not need a new one per field.  The second number is the width in bytes.
var WRITABLE = { level: [ITEM.level, 1], min: [ITEM.minLevel, 1],
                 atk: [ITEM.attack, 2], def: [ITEM.defense, 2],
                 price: [ITEM.price, 4],
                 pmin: [ITEM.damageMin, 2], fmin: [ITEM.damageMin + 2, 2],
                 mmin: [ITEM.damageMin + 4, 2], xmin: [ITEM.damageMin + 6, 2],
                 pmax: [ITEM.damageMax, 2], fmax: [ITEM.damageMax + 2, 2],
                 mmax: [ITEM.damageMax + 4, 2], xmax: [ITEM.damageMax + 6, 2] };

function reshape(ref, changes) {
    var obj = objectByRef(ref);
    if (obj === null) {
        return false;
    }
    var wrote = false;
    // "The type" is both copies.  Writing one and not the other is what made
    // the first attempt a reskin, so a caller never gets to do that by
    // accident.  There is one `type` field and it means both.  A mod that
    // names the type rather than numbering it sends `typeName`, the game's
    // internal name; an unknown name changes nothing.
    var newType = changes.type;
    if (newType === undefined && changes.typeName !== undefined) {
        newType = typeIds()[changes.typeName];
    }
    if (newType !== undefined) {
        var typeId = parseInt(newType, 10);
        if (!isNaN(typeId)) {
            try {
                obj.add(ITEM.type).writeU32(typeId >>> 0);
                obj.add(ITEM.type2).writeU32(typeId >>> 0);
                wrote = true;
            } catch (e) {}
        }
    }
    if (changes.mods !== undefined) {
        try {
            writeMods(obj, changes.mods);
            wrote = true;
        } catch (e) {}
    }
    for (var key in changes) {
        var field = WRITABLE[key];
        if (field === undefined) {
            continue;
        }
        var value = parseInt(changes[key], 10);
        if (isNaN(value)) {
            continue;
        }
        try {
            if (field[1] === 4) {
                obj.add(field[0]).writeU32(value >>> 0);
            } else if (field[1] === 2) {
                // Signed words: 50000 read back as -15536 and the tooltip went
                // negative, so nothing above 32767 is written.
                obj.add(field[0]).writeU16(value < 0 ? 0 : (value > 32767 ? 32767 : value));
            } else {
                obj.add(field[0]).writeU8(value & 0xFF);
            }
            wrote = true;
        } catch (e) {}
    }
    return wrote;
}

command("item.info", function (f) {
    var ref = parseInt(f.ref, 10);
    var fields = itemFields(ref);
    var obj = objectByRef(ref);
    if (obj !== null) {
        try {
            fields.display = itemDisplayName(obj) || "";
        } catch (e) {}
    }
    return fields;
});

// The tooltip's modifier lines of one item: text joined by newlines, colours
// (AARRGGBB) joined by commas, in slot order.
command("item.lines", function (f) {
    var obj = objectByRef(parseInt(f.ref, 10));
    if (obj === null) {
        throw new Error("No item found at ref " + f.ref + ".");
    }
    var texts = [];
    var colours = [];
    for (var i = 0; i < MOD_SLOTS; i++) {
        var line = modifierLine(obj.add(ITEM_BLOCK), i);
        if (line !== null) {
            colours.push(line[0]);
            texts.push(line[1]);
        }
    }
    return { ref: f.ref, n: texts.length, lines: texts.join("\n"), colours: colours.join(",") };
});

// Any modifier's text for a value, from a one-slot block built here.
command("item.modtext", function (f) {
    var id = parseInt(f.id, 10);
    if (isNaN(id) || id <= 0 || id > 0xFFFF) {
        throw new Error("A modifier id is 1..65535.");
    }
    var n = itemTextNatives();
    for (var i = 0; i < BLOCK_SIZE; i += 4) {
        n.block.add(i).writeU32(0);
    }
    n.block.add(0x3A).writeU16(parseInt(f.flags, 10) || 0);
    n.block.add(0x4A).writeU32((((parseInt(f.param, 10) || 0) & 0xFFFF) << 16 | id) >>> 0);
    n.block.add(0x6A).writeU16(parseInt(f.value, 10) || 0);
    var line = modifierLine(n.block, 0);
    return line === null ? { id: id, text: "" } : { id: id, text: line[1], colour: line[0] };
});

// Fields are named exactly as they arrive on an item event, so a mod that read
// `type` off a Pickup writes `type` back here.
command("item.reshape", function (f) {
    var ref = parseInt(f.ref, 10);
    if (f.type === undefined && f.typeName !== undefined && typeIds()[f.typeName] === undefined) {
        throw new Error("No item type " + f.typeName + ".");
    }
    if (!reshape(ref, f)) {
        throw new Error("No item found at ref " + f.ref + ".");
    }
    return itemFields(ref);
});

// thiscall(creature)(int ref, ...).  ECX is the creature doing the picking up,
// which is how the hero is told apart from an NPC, and only the hero's
// pickups are asked about.  The other three call sites are creature AI and
// their rate has never been measured, so they observe and move on rather than
// stop the game thread on a mob bending down.
hook("itemPickup", RVA.itemPickup, {
    onEnter: function (args) {
        var ref, mine;
        try {
            ref = args[0].toUInt32() >>> 0;
            mine = isHeroFull(this.context.ecx);
        } catch (e) {
            return;
        }
        var fields = itemFields(ref);
        fields.player = mine ? 1 : 0;
        if (!mine) {
            evt("item.pickup", fields);
            return;
        }
        var verdict = ask("item.pickup", fields);
        if (verdict.cancel) {
            args[0] = ptr(0);
            return;
        }
        // Two different powers, and they compose in this order: `ref` chooses
        // WHICH object is picked up, `type` (and the other fields) change the
        // one that ends up being picked up.  Swapping the ref affects this call
        // only.  Reshaping edits the world object and outlives it.
        var swapped = asked(verdict, "ref", ref);
        if (swapped !== ref) {
            // A ref that resolves to nothing is not an error to guard against:
            // the game already treats it as "there was nothing there".
            args[0] = ptr(swapped >>> 0);
        }
        if (Object.keys(verdict.set).length > (verdict.set.ref ? 1 : 0)) {
            reshape(swapped, verdict.set);
        }
    }
});

// thiscall(creature)(int type, int count, int ref, int inventory) -> ref.  The
// first argument is the TYPE: the game sizes it from the type table and hands
// it to cObjectManager::create, which builds a fresh item when ref is 0.  So
// the item is known only on the way out, as the ref the function returns, 0
// when the bag had no room.
hook("itemStore", RVA.itemStore, {
    onEnter: function () {
        this.creature = snapPtr(this.context.ecx);
    },
    onLeave: function (retval) {
        try {
            var ref = retval.toUInt32() >>> 0;
            if (ref === 0) {
                return;
            }
            var fields = itemFields(ref);
            fields.player = isHeroFull(this.creature) ? 1 : 0;
            evt("item.stored", fields);
        } catch (e) {}
    }
});

// The hero's bag and what the hero wears.
//
// The inventory manager holds 32 bags of 0x1180 bytes; a creature's own is the
// one whose index equals its ref (the hero, ref 1, owns bag 1).  A bag is a
// grid of 12-byte cells, row * width + column: the item's top-left cell holds
// its ref, width, height and type.  Worn items are 19 refs on the creature.
var BAG_SIZE = 0x1180;
var BAG_COUNT = 32;
var BAG_CELLS = 0x18;
var BAG_CELL = 12;
var BAG_WIDTH = 0x115C;
var BAG_HEIGHT = 0x115E;
var BAG_INDEX = 0x1160;
var WORN = 0x1A4;
var WORN_SLOTS = 19;

function heroBag() {
    var mgr = ptr(VA.inventories).readPointer();
    if (mgr.isNull()) {
        return null;
    }
    var index = heroFull.add(ITEM.ref).readU32() >>> 0;
    if (index >= BAG_COUNT) {
        return null;
    }
    var bag = mgr.add(index * BAG_SIZE);
    return bag.add(BAG_INDEX).readU16() === index ? bag : null;
}

// Bag items as cell:ref:type:w:h and worn items as slot:ref:type, each list
// joined by ';', with every type's name once, type=NAME joined by ','.
command("player.inventory", function () {
    if (!live(heroFull)) {
        throw new Error("No hero found. Load a world first.");
    }
    var names = {};
    var bagged = [];
    var width = 0;
    var height = 0;
    var bag = heroBag();
    if (bag !== null) {
        width = bag.add(BAG_WIDTH).readU16();
        height = bag.add(BAG_HEIGHT).readU16();
        var cells = Math.min(width * height, (BAG_INDEX - BAG_CELLS) / BAG_CELL | 0);
        for (var cell = 0; cell < cells; cell++) {
            var rec = bag.add(BAG_CELLS + cell * BAG_CELL);
            var ref = rec.readU32() >>> 0;
            if (ref === 0) {
                continue;
            }
            var obj = objectByRef(ref);
            var type = obj === null ? rec.add(8).readU16() : obj.add(ITEM.type).readU32() >>> 0;
            bagged.push([cell, ref, type, rec.add(5).readU8(), rec.add(6).readU8()].join(":"));
            names[type] = true;
        }
    }
    var worn = [];
    for (var slot = 0; slot < WORN_SLOTS; slot++) {
        var wref = heroFull.add(WORN + slot * 4).readU32() >>> 0;
        var wobj = wref ? objectByRef(wref) : null;
        if (wobj === null) {
            continue;
        }
        var wtype = wobj.add(ITEM.type).readU32() >>> 0;
        worn.push([slot, wref, wtype].join(":"));
        names[wtype] = true;
    }
    var named = [];
    for (var t in names) {
        var n = typeName(parseInt(t, 10));
        if (n !== null) {
            named.push(t + "=" + n);
        }
    }
    return { width: width, height: height, items: bagged.join(";"),
             worn: worn.join(";"), names: named.join(",") };
});

// A new item in the hero's bag, made the way the game makes a new hero's kit:
// inventory_putItem(type, 1, 0, 0) on the hero, on the engine thread.  The
// game picks the free cell; with none free it logs and makes nothing.  The
// item arrives as an item.stored event, which carries its ref.  Seen live:
// (5171, 1, 0, 0) returned ref 3437 and the potion lay in cell 120.
var giveItemFn = null;

command("player.give", function (f) {
    if (!live(heroFull)) {
        throw new Error("No hero found. Load a world first.");
    }
    var type = f.type === undefined ? NaN : parseInt(f.type, 10);
    if (isNaN(type) && f.name !== undefined) {
        var found = typeIds()[f.name];
        type = found === undefined ? NaN : found;
    }
    if (isNaN(type) || type <= 0 || typeName(type) === null) {
        throw new Error("No item type " + (f.name || f.type) + ".");
    }
    var hero = heroFull;
    var queued = later(function () {
        if (!same(hero, heroFull)) {
            return;
        }
        if (giveItemFn === null) {
            giveItemFn = new NativeFunction(at(RVA.itemStore), "int",
                                            ["pointer", "int", "int", "int", "int"],
                                            { abi: "thiscall", exceptions: "propagate" });
        }
        // Called from inside the tick's own callback, so Frida runs no
        // interceptor for it and the store hook stays silent: say it here.
        var ref = giveItemFn(hero, type, 1, 0, 0) >>> 0;
        if (ref !== 0) {
            var fields = itemFields(ref);
            fields.player = 1;
            evt("item.stored", fields);
        }
    });
    if (!queued) {
        throw new Error("Too many game calls waiting.");
    }
    return { type: type, name: typeName(type) };
});

// thiscall(creature)(int slot, int ref, int nn).  One function does equip and
// unequip: ref 0 means "clear this slot", so the raw ref is reported and the
// two are told apart by the flag rather than by a separate event.
hook("itemEquip", RVA.itemEquip, {
    onEnter: function (args) {
        try {
            var slot = args[0].toUInt32() >>> 0;
            var ref = args[1].toUInt32() >>> 0;
            var fields = ref ? itemFields(ref) : { ref: 0 };
            fields.slot = slot;
            fields.off = ref ? 0 : 1;
            fields.player = isHeroFull(this.context.ecx) ? 1 : 0;
            evt("item.equip", fields);
        } catch (e) {}
    }
});

// thiscall(inventory)(u16 src, u16 dst): two inventory entry indices, not grid
// slots (see the itemMove row), and no item identity on this path.  Moving an
// item within one bag does not come through here.
hook("itemMove", RVA.itemMove, {
    onEnter: function (args) {
        try {
            evt("item.moved", {
                from: args[0].toUInt32() & 0xFFFF,
                to: args[1].toUInt32() & 0xFFFF
            });
        } catch (e) {}
    }
});

// A potion drunk.  The site is the call right after cPotion3D::receive_event's
// filters have passed, so it runs once per drink and never for the other events
// a potion receives.  EDI is the potion and ESI the creature drinking it.
// onEnter only: this is a mid-function site.
hook("potionDrink", RVA.potionDrink, function () {
    try {
        var potion = this.context.edi;
        var type = potion.add(ITEM.type).readU32() >>> 0;
        evt("item.drink", {
            ref: potion.add(ITEM.ref).readU32() >>> 0,
            type: type,
            name: typeName(type),
            player: isHeroFull(this.context.esi) ? 1 : 0
        });
    } catch (e) {}
});
