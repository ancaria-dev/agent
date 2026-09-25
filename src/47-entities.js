// Creatures appearing in and leaving the world.
//
// cObjectManager::create and ::destroy see every object: items, effects,
// projectiles, scenery.  About half the calls in play are creatures, and only
// those are reported, so the wire carries what a mod can use.  Both are
// thiscall on the manager with the ref as the first stack argument, checked
// live rather than derived: create's frame arithmetic points at the second
// argument and is wrong.
//
// Both run once per object while a world loads (~3000 calls in a burst) and
// again while it is torn down, and a per-object interceptor inside that burst
// is what killed Frida before.  So these are switched off on the way into a
// load and at hero termination, and back on once the world is up.  One full
// reload did survive with them attached, but the switch costs nothing and the
// failure it prevents is a hard crash.

// Refs created while a loot drop runs, or null outside one.  See lootDrop.
var lootDropping = null;

var spawnHook = switchable("objCreate", RVA.objCreate, {
    // The object is built inside create, so it is read on the way out.
    onEnter: function (args) {
        try {
            this.ref = args[0].toUInt32() >>> 0;
        } catch (e) {
            this.ref = 0;
        }
    },
    onLeave: function () {
        if (!this.ref) {
            return;
        }
        if (lootDropping !== null) {
            lootDropping.push(this.ref);
        }
        var fields = creatureFields(this.ref);
        if (fields !== null) {
            evt("entity.spawn", fields);
        }
    }
});

var despawnHook = switchable("objDestroy", RVA.objDestroy, {
    // Gone by the time destroy returns, so read on the way in.
    onEnter: function (args) {
        var ref;
        try {
            ref = args[0].toUInt32() >>> 0;
        } catch (e) {
            return;
        }
        var fields = creatureFields(ref);
        if (fields !== null) {
            evt("entity.despawn", fields);
        }
    }
});

function spawnWatch(wanted) {
    if (wanted) {
        spawnHook.on();
        despawnHook.on();
    } else {
        spawnHook.off();
        despawnHook.off();
    }
}

hook("spawnGateLoad", RVA.worldLoad, {
    onEnter: function () {
        spawnWatch(false);
    },
    onLeave: function () {
        spawnWatch(true);
    }
});

hook("spawnGateEnd", RVA.heroTerminate, {
    onEnter: function () {
        spawnWatch(false);
    }
});

// Attaching to a game that is already running: the load finished long ago.
onHero(function () {
    if (!isLoading()) {
        spawnWatch(true);
    }
});

// Every creature the object manager holds, as one frame: a mod asking "what is
// around" wants the whole answer, and a round-trip per creature would be
// hundreds of them.  Records are ref:type:level:hp:maxHp:x:y:player:cclass joined by
// `;`, and each type name is sent once, as type=NAME joined by `,`.  Names are
// TYPE_ plus capitals, digits and underscores, so neither separator can occur
// inside one.
//
// With x, y and radius, only the creatures within that distance of the point,
// in world units, which is how a mod asks for "near the hero" without paying
// for the whole map.
function packCreatures(f) {
    var mgr = ptr(VA.objectManager).readPointer();
    if (mgr.isNull()) {
        return { n: 0, creatures: "", names: "" };
    }
    var count = (mgr.add(8).readPointer().toUInt32() -
                 mgr.add(4).readPointer().toUInt32()) >> 2;
    var near = f.radius !== undefined;
    var cx = parseInt(f.x, 10);
    var cy = parseInt(f.y, 10);
    var r2 = Math.pow(parseInt(f.radius, 10) || 0, 2);
    var out = [];
    var names = {};
    for (var ref = 1; ref < count; ref++) {
        var c = creatureFields(ref);
        if (c === null) {
            continue;
        }
        if (near && Math.pow(c.x - cx, 2) + Math.pow(c.y - cy, 2) > r2) {
            continue;
        }
        out.push([c.ref, c.type, c.level, c.hp, c.maxHp, c.x, c.y,
                  c.player, c.cclass].join(":"));
        names[c.type] = c.name;
    }
    var named = [];
    for (var type in names) {
        named.push(type + "=" + names[type]);
    }
    return { n: out.length, creatures: out.join(";"), names: named.join(",") };
}

command("world.creatures", packCreatures);

command("world.creature", function (f) {
    var ref = parseInt(f.ref, 10);
    var c = creatureFields(ref);
    if (c === null) {
        throw new Error("No creature at ref " + f.ref + ".");
    }
    c.display = objectDisplayName(objectByRef(ref)) || "";
    return c;
});

// The name the player reads, for any object: the game's cItem::getName reads
// the object's own name text (+0x3C) when it has one and its type's otherwise,
// and both fields exist on creatures as on items.  Seen live: "Quinn, Agent of
// the Crown" on a TYPE_NPC_THIEF_FEM, "Blood Bear" on a bear with no own name.
// It goes through the game's text cache, on Frida's thread, as ui.string does.
var objectNameFn = null;

function objectDisplayName(obj) {
    if (obj === null) {
        return null;
    }
    if (objectNameFn === null) {
        objectNameFn = new NativeFunction(at(RVA.itemName), "pointer", ["pointer"],
                                          { abi: "thiscall" });
    }
    try {
        var p = objectNameFn(obj);
        return p.isNull() ? null : p.readUtf16String(200);
    } catch (e) {
        return null;
    }
}

command("world.name", function (f) {
    var obj = objectByRef(parseInt(f.ref, 10));
    if (obj === null) {
        throw new Error("No object at ref " + f.ref + ".");
    }
    return { ref: f.ref, name: objectDisplayName(obj) || "" };
});

// Every object, not only creatures.  What an object is comes from its type's
// family, the byte the game's own debug dump counts objects by (itemTypeFamily,
// 0x00426220): 3 every creature, 4 chests and barrels, 5 weapons, 10 doors, 12
// effects, 28 runes.  Read here rather than called, one byte per type.
var OBJECT_TYPE_LIMIT = 0x7E60;
var OBJECT_RECORD = 0x80;
var OBJECT_FAMILY = 0x2E;
var OBJECT_SECTOR = 0x18;
var FAMILY_CREATURE = 3;
var FAMILY_CONTAINER = 4;
var EQUIPMENT = 0x1A4;
var EQUIPMENT_SLOTS = 19;

function objectFamily(typeId) {
    if (typeId <= 0 || typeId >= OBJECT_TYPE_LIMIT) {
        return 0;
    }
    try {
        return ptr(VA.itemTypes).readPointer()
            .add(typeId * OBJECT_RECORD + OBJECT_FAMILY).readU8();
    } catch (e) {
        return 0;
    }
}

// Who holds a carried object: the creature wearing it or carrying it in its
// bag, or the chest it lies in.  The game keeps no back pointer, so the
// holders are walked once per question.  An object in none of them (a
// merchant's stock, the cursor) stays without an owner.
function objectOwners(table, count) {
    var owners = {};
    for (var ref = 1; ref < count; ref++) {
        var obj = table.add(ref * 4).readPointer();
        if (obj.isNull()) {
            continue;
        }
        try {
            var family = objectFamily(obj.add(0x10).readU32() >>> 0);
            if (family === FAMILY_CREATURE) {
                for (var s = 0; s < EQUIPMENT_SLOTS; s++) {
                    var worn = obj.add(EQUIPMENT + s * 4).readU32() >>> 0;
                    if (worn) {
                        owners[worn] = ref;
                    }
                }
            } else if (family === FAMILY_CONTAINER) {
                var begin = obj.add(0x1E4).readPointer();
                var end = obj.add(0x1E8).readPointer();
                for (var p = begin; !begin.isNull() && p.compare(end) < 0; p = p.add(4)) {
                    owners[p.readU32() >>> 0] = ref;
                }
            }
        } catch (e) {}
    }
    // Bags: the manager's 32, each owned by the creature whose ref is its
    // index.  Only the top-left cell of an item holds its ref.
    try {
        var bags = ptr(VA.inventories).readPointer();
        for (var i = 1; !bags.isNull() && i < 32 && i < count; i++) {
            var bag = bags.add(i * 0x1180);
            var holder = table.add(i * 4).readPointer();
            if (bag.add(0x1160).readU16() !== i || holder.isNull() ||
                    objectFamily(holder.add(0x10).readU32() >>> 0) !== FAMILY_CREATURE) {
                continue;
            }
            var cells = bag.add(0x115C).readU16() * bag.add(0x115E).readU16();
            for (var c = 0; c < cells && c < 368; c++) {
                var held = bag.add(0x18 + c * 12).readU32() >>> 0;
                if (held) {
                    owners[held] = i;
                }
            }
        }
    } catch (e) {}
    return owners;
}

// ref:type:kind:sector:x:y:owner, owner -1 when none is known.  A sector of 0
// means the object is not lying in the world: carried, worn or in a chest.
function objectRecord(ref, obj, owners) {
    var type = obj.add(0x10).readU32() >>> 0;
    var owner = owners === null ? undefined : owners[ref];
    return {
        ref: ref,
        type: type,
        kind: objectFamily(type),
        sector: obj.add(OBJECT_SECTOR).readU16(),
        x: obj.add(0x1C).readS32(),
        y: obj.add(0x20).readS32(),
        owner: owner === undefined ? -1 : owner
    };
}

// The whole table is thousands of objects (3600 in a town), so one frame with
// each type's name sent once, the way world.creatures packs.  With x, y and
// radius, only objects lying in the world near that point, and no owner walk.
// With kind, only that family.
function packObjects(f) {
    var mgr = ptr(VA.objectManager).readPointer();
    if (mgr.isNull()) {
        return { n: 0, objects: "", names: "" };
    }
    var table = mgr.add(4).readPointer();
    var count = (mgr.add(8).readPointer().toUInt32() - table.toUInt32()) >> 2;
    var near = f.radius !== undefined;
    var cx = parseInt(f.x, 10);
    var cy = parseInt(f.y, 10);
    var r2 = Math.pow(parseInt(f.radius, 10) || 0, 2);
    var kind = f.kind === undefined ? -1 : parseInt(f.kind, 10);
    var owners = near ? null : objectOwners(table, count);
    var out = [];
    var names = {};
    for (var ref = 1; ref < count; ref++) {
        var obj = table.add(ref * 4).readPointer();
        if (obj.isNull()) {
            continue;
        }
        try {
            var o = objectRecord(ref, obj, owners);
            if (kind >= 0 && o.kind !== kind) {
                continue;
            }
            if (near && (o.sector === 0 ||
                         Math.pow(o.x - cx, 2) + Math.pow(o.y - cy, 2) > r2)) {
                continue;
            }
            out.push([o.ref, o.type, o.kind, o.sector, o.x, o.y, o.owner].join(":"));
            if (names[o.type] === undefined) {
                names[o.type] = typeName(o.type) || "";
            }
        } catch (e) {}
    }
    var named = [];
    for (var type in names) {
        if (names[type] !== "") {
            named.push(type + "=" + names[type]);
        }
    }
    return { n: out.length, objects: out.join(";"), names: named.join(",") };
}

command("world.objects", packObjects);

command("world.object", function (f) {
    var ref = parseInt(f.ref, 10);
    var obj = objectByRef(ref);
    if (obj === null) {
        throw new Error("No object at ref " + f.ref + ".");
    }
    var mgr = ptr(VA.objectManager).readPointer();
    var table = mgr.add(4).readPointer();
    var count = (mgr.add(8).readPointer().toUInt32() - table.toUInt32()) >> 2;
    var o = objectRecord(ref, obj, objectOwners(table, count));
    o.name = typeName(o.type) || "";
    return o;
});

// The same call the game's sudden-death action makes.  Nothing but creatures:
// an item has no HP table, and the index would land in the middle of it.
function creatureAt(ref) {
    var c = creatureFields(ref);
    if (c === null) {
        throw new Error("No creature at ref " + ref + ".");
    }
    return objectByRef(ref);
}

command("world.hp", function (f) {
    var ref = parseInt(f.ref, 10);
    setCreatureStat(creatureAt(ref), parseInt(f.value, 10), STAT_CURRENT_HP);
    return creatureFields(ref);
});

command("world.kill", function (f) {
    var ref = parseInt(f.ref, 10);
    setCreatureStat(creatureAt(ref), 0, STAT_CURRENT_HP);
    return creatureFields(ref);
});

// Loot.  A creature's drop is created inside cCreature's loot function, so the
// items are not its arguments: every object cObjectManager::create makes
// between its entry and its return is what it dropped.  That borrows the
// create hook above, and so shares its window: nothing is reported while a
// world loads.  Chests are simpler, their contents already exist as a vector
// of refs on the chest when it opens.
//
// Items travel as ref:type:NAME joined by `;`.

function lootItems(refs) {
    var out = [];
    for (var i = 0; i < refs.length; i++) {
        var obj = objectByRef(refs[i]);
        if (obj === null) {
            continue;
        }
        try {
            var type = obj.add(0x10).readU32() >>> 0;
            var name = typeName(type);
            // Loot, not the effects and sounds a death also creates.
            if (name !== null && !CREATURE_TYPES.test(name) &&
                    name.indexOf("TYPE_FX_") !== 0) {
                out.push(refs[i] + ":" + type + ":" + name);
            }
        } catch (e) {}
    }
    return out;
}

function objectRef(obj) {
    try {
        return obj.add(0x0C).readU32() >>> 0;
    } catch (e) {
        return 0;
    }
}

hook("lootDrop", RVA.lootDrop, {
    onEnter: function () {
        this.outer = lootDropping;
        lootDropping = [];
        this.source = snapPtr(this.context.ecx);
    },
    onLeave: function () {
        var made = lootDropping || [];
        lootDropping = this.outer;
        var items = lootItems(made);
        if (items.length === 0) {
            return;
        }
        // The type straight off the object; its ref at +0x0C is what items
        // carry there, and on a creature is still to be seen in play.
        var source = 0;
        var type = 0;
        if (live(this.source)) {
            source = objectRef(this.source);
            try {
                type = this.source.add(0x10).readU32() >>> 0;
            } catch (e) {}
        }
        evt("loot.drop", {
            source: source,
            type: type,
            name: type ? (typeName(type) || "") : "",
            chest: 0,
            items: items.join(";")
        });
    }
});

hook("chestDrop", RVA.chestDrop, {
    onEnter: function () {
        try {
            var chest = this.context.ecx;
            var begin = chest.add(0x1E4).readPointer();
            var end = chest.add(0x1E8).readPointer();
            var refs = [];
            for (var p = begin; !begin.isNull() && p.compare(end) < 0; p = p.add(4)) {
                refs.push(p.readU32() >>> 0);
            }
            var items = lootItems(refs);
            var type = chest.add(0x10).readU32() >>> 0;
            evt("loot.drop", {
                source: objectRef(chest), type: type, name: typeName(type) || "",
                chest: 1, items: items.join(";")
            });
        } catch (e) {}
    }
});
