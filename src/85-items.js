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
    percent: 0x119,
    minLevel: 0x12C,
    level: 0x131,
    attack: 0x144,
    protectionA: 0x14A,
    protectionB: 0x14E,
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
// This is where an item's actual EFFECT lives, as opposed to its type id, which
// is only what it is called.  Retyping a rune renames it and leaves it doing
// what it did.
var MOD_SLOTS = 8;

function readMods(obj) {
    var pairs = [];
    try {
        for (var i = 0; i < MOD_SLOTS; i++) {
            var id = obj.add(ITEM.modIds + i * 4).readU16();
            if (id === 0) {
                break;
            }
            pairs.push(id + ":" + obj.add(ITEM.modValues + i * 2).readU16());
        }
    } catch (e) {}
    return pairs.join(",");
}

// Replaces the whole list, clearing the slots past it: "the modifiers are
// exactly these".  UNVERIFIED against the game: reading these is confirmed,
// writing them is not, so treat a changed tooltip as the first evidence.
function writeMods(obj, packed) {
    var pairs = packed === "" ? [] : packed.split(",");
    for (var i = 0; i < MOD_SLOTS; i++) {
        var id = 0;
        var value = 0;
        if (i < pairs.length) {
            var half = pairs[i].split(":");
            id = parseInt(half[0], 10) || 0;
            value = parseInt(half[1], 10) || 0;
        }
        obj.add(ITEM.modIds + i * 4).writeU16(id);
        obj.add(ITEM.modValues + i * 2).writeU16(value);
    }
}

// The manager's table, walked read-only.  The game's own objectByIndex is
// callable, but its ref-mismatch branch WRITES [obj+0xC] to repair the entry --
// a lookup for logging has no business doing that, and the table walk is four
// reads.  Bounds come from the same function so a bad ref behaves identically.
function objectByRef(ref) {
    if (!ref || ref < 0) {
        return null;
    }
    try {
        var mgr = ptr(VA.objectManager).readPointer();
        if (mgr.isNull()) {
            return null;
        }
        var table = mgr.add(4).readPointer();
        var end = mgr.add(8).readPointer();
        if (table.isNull() || ref >= ((end.toUInt32() - table.toUInt32()) >> 2)) {
            return null;
        }
        var obj = table.add(ref * 4).readPointer();
        return obj.isNull() ? null : obj;
    } catch (e) {
        return null;
    }
}

// Flat fields, because that is what the wire carries.  The display name is
// deliberately absent: Sacred composes item names from affixes ("Damaged" +
// base + "of Oblivion") and there is no single string to read, so the internal
// type name is the stable key and the one a mod should match on.
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
            atk: obj.add(ITEM.attack).readU8(),
            prot: obj.add(ITEM.protectionA).readU8() +
                  obj.add(ITEM.protectionB).readU8(),
            pct: obj.add(ITEM.percent).readU8(),
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
// The other mapped fields (level, attack, protection) are plain bytes and are
// writable the same way.  They are exposed through the same command so a mod
// does not need a new one per field.
var WRITABLE = { level: [ITEM.level, 1], min: [ITEM.minLevel, 1],
                 atk: [ITEM.attack, 1], pct: [ITEM.percent, 1],
                 price: [ITEM.price, 4] };

function reshape(ref, changes) {
    var obj = objectByRef(ref);
    if (obj === null) {
        return false;
    }
    var wrote = false;
    // "The type" is both copies.  Writing one and not the other is what made
    // the first attempt a reskin, so a caller never gets to do that by
    // accident.  There is one `type` field and it means both.
    if (changes.type !== undefined) {
        var typeId = parseInt(changes.type, 10);
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
            } else {
                obj.add(field[0]).writeU8(value & 0xFF);
            }
            wrote = true;
        } catch (e) {}
    }
    return wrote;
}

command("item.info", function (f) {
    return itemFields(parseInt(f.ref, 10));
});

// Fields are named exactly as they arrive on an item event, so a mod that read
// `type` off a Pickup writes `type` back here.
command("item.reshape", function (f) {
    var ref = parseInt(f.ref, 10);
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

hook("itemStore", RVA.itemStore, {
    onEnter: function (args) {
        try {
            var fields = itemFields(args[0].toUInt32() >>> 0);
            fields.player = isHeroFull(this.context.ecx) ? 1 : 0;
            evt("item.stored", fields);
        } catch (e) {}
    }
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

// thiscall(inventory)(u16 src, u16 dst): grid slots, no item identity on this
// path.  Kept because it is the only signal that the player rearranged a bag.
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
