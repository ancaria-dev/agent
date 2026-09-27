// The world's script spots: hiding places, wells, shrines, gold spots and
// signposts, one 0x58-byte record each in the interpreter's vector (see the
// scriptSpots row).  They are not objects: a hiding place's sparkle is a bit
// of the world tile it lies on.  The hidden quest triggers (setvar_*) share
// the vector and are never reported, because running one changes a quest.
//
//   world.spots        every visible spot, packed
//   world.spot_open    a hiding place, opened the way the hero's click does
//   spot.open          event: the hero or world.spot_open used a spot
//
// Opening, as traced live on the user's click: the record's script runs with
// the hero (fillScript "VERSTECK", which makes the item beside the hero), the
// record's uses go down by one unless they are endless, and at 0 the record
// is removed and, with no other spot left there, the tile's sparkle is
// cleared.  Removing a record moves every later index down by one, so a spot
// is named by its grid position, not by its index.

var SPOT_SIZE = 0x58;
var SPOT_NAME = 0x18;
var SPOT_USES = 6;
var SPOT_ENDLESS = 0x3E80;
var SPOT_SCALE = 53.66563034057617;     // the float at 0x00890150
var SPOT_HIDING_PLACE = "VERSTECK";
var SPOT_HIDDEN = /^setvar/i;
var SPOT_SPARKLE = 0x1E;                // world tile byte, bit 0x80
var spotNative = null;

function spotNatives() {
    if (spotNative === null) {
        var opts = { abi: "thiscall", exceptions: "propagate" };
        spotNative = {
            fill: new NativeFunction(at(RVA.fillScript), "void", ["pointer", "pointer", "int"],
                                     { abi: "mscdecl", exceptions: "propagate" }),
            remove: new NativeFunction(at(RVA.placeRemove), "void", ["pointer", "int"], opts),
            at: new NativeFunction(at(RVA.placeAt), "uint16",
                                   ["pointer", "uint32", "uint32", "uint32", "uint32", "int"], opts),
            tile: new NativeFunction(at(RVA.worldTile), "pointer", ["pointer", "pointer"], opts)
        };
    }
    return spotNative;
}

function spotRecords() {
    var begin = ptr(VA.scriptSpots).readPointer();
    var end = ptr(VA.scriptSpots).add(4).readPointer();
    if (begin.isNull()) {
        return { begin: begin, count: 0 };
    }
    return { begin: begin, count: Math.floor(end.sub(begin).toInt32() / SPOT_SIZE) };
}

// World units, the way the hero's click turns a grid position into its target.
function spotWorld(grid) {
    return Math.trunc((grid + 0.5) * SPOT_SCALE);
}

function spotAt(records, index) {
    var r = records.begin.add(index * SPOT_SIZE);
    return {
        index: index,
        gx: r.readU16(),
        gy: r.add(2).readU16(),
        layer: r.add(4).readU16(),
        uses: r.add(SPOT_USES).readU16(),
        name: r.add(SPOT_NAME).readCString() || "",
        record: r
    };
}

// The spot at a grid position with this script, or null.
function spotFind(gx, gy, name) {
    var records = spotRecords();
    for (var i = 0; i < records.count; i++) {
        var r = records.begin.add(i * SPOT_SIZE);
        if (r.readU16() === gx && r.add(2).readU16() === gy &&
                r.add(SPOT_NAME).readCString() === name) {
            return spotAt(records, i);
        }
    }
    return null;
}

command("world.spots", function () {
    if (!live(heroFull) || isLoading()) {
        return { spots: "" };
    }
    var records = spotRecords();
    var out = [];
    for (var i = 0; i < records.count; i++) {
        var s = spotAt(records, i);
        if (s.name === "" || SPOT_HIDDEN.test(s.name)) {
            continue;
        }
        out.push([i, s.gx, s.gy, spotWorld(s.gx), spotWorld(s.gy), s.uses, s.name].join(":"));
    }
    return { spots: out.join(";") };
});

// What a script made, as ref:type:NAME joined by ";": the items lying in the
// world, not the effects it also leaves, nor the item's template, which it
// makes first and keeps with no position (live: two objects of one type, one
// beside the hero and one at sector 0, for the player's click as for this).
function spotItems(refs) {
    var out = [];
    refs.forEach(function (ref) {
        var obj = objectByRef(ref);
        if (obj === null) {
            return;
        }
        if (obj.add(0x18).readU16() === 0) {
            return;
        }
        var type = obj.add(0x10).readU32() >>> 0;
        var name = typeName(type);
        if (name !== null && !CREATURE_TYPES.test(name) && name.indexOf("TYPE_FX_") !== 0) {
            out.push(ref + ":" + type + ":" + name);
        }
    });
    return out;
}

// The object table as it is, to tell what a script made.
function spotObjectTable() {
    var mgr = ptr(VA.objectManager).readPointer();
    var table = mgr.add(4).readPointer();
    var count = mgr.add(8).readPointer().sub(table).toInt32() >> 2;
    var slots = [];
    for (var i = 0; i < count; i++) {
        slots.push(table.add(i * 4).readU32());
    }
    return slots;
}

// The hero using a spot: the game runs its script by the name inside the
// record (see the fillScript row), so a name pointer into the spots vector
// tells a spot from a chest's fill.  What the script makes is collected by
// objCreate, and this hook is switched with it, off while a world loads.  The
// record's uses go down only after the script returns, so the uses sent are
// the ones left once the game has counted this use.
function spotOpenFields(spot, made) {
    var uses = spot.uses < SPOT_ENDLESS ? Math.max(spot.uses - 1, 0) : spot.uses;
    return {
        index: spot.index, gx: spot.gx, gy: spot.gy,
        x: spotWorld(spot.gx), y: spotWorld(spot.gy),
        uses: uses, name: spot.name, items: spotItems(made).join(";")
    };
}

spawnFollowers.push(switchable("fillScript", RVA.fillScript, {
    onEnter: function (args) {
        this.spot = null;
        try {
            var records = spotRecords();
            var offset = args[0].sub(records.begin).toInt32();
            if (records.count === 0 || offset < 0 || offset >= records.count * SPOT_SIZE ||
                    offset % SPOT_SIZE !== SPOT_NAME) {
                return;
            }
            var spot = spotAt(records, Math.floor(offset / SPOT_SIZE));
            if (spot.name === "" || SPOT_HIDDEN.test(spot.name)) {
                return;
            }
            this.spot = spot;
            this.outer = lootDropping;
            lootDropping = [];
        } catch (e) {}
    },
    onLeave: function () {
        if (this.spot === null) {
            return;
        }
        var made = lootDropping || [];
        lootDropping = this.outer;
        try {
            evt("spot.open", spotOpenFields(this.spot, made));
        } catch (e) {}
    }
}));

commandOnEngine("world.spot_open", function (f) {
    var gx = parseInt(f.gx, 10);
    var gy = parseInt(f.gy, 10);
    if (isNaN(gx) || isNaN(gy)) {
        throw new Error("world.spot_open needs the spot's gx and gy.");
    }
    if (!live(heroFull) || isLoading()) {
        throw new Error("No world loaded.");
    }
    if (spotFind(gx, gy, SPOT_HIDING_PLACE) === null) {
        throw new Error("No hiding place at " + gx + ", " + gy + ".");
    }
    return function () {
        var spot = spotFind(gx, gy, SPOT_HIDING_PLACE);
        if (spot === null) {
            throw new Error("The hiding place at " + gx + ", " + gy + " is gone.");
        }
        if (spot.uses === 0) {
            throw new Error("The hiding place at " + gx + ", " + gy + " is empty.");
        }
        var n = spotNatives();
        var interp = ptr(VA.scriptInterpreter);
        var before = spotObjectTable();
        var used = spot;
        n.fill(spot.record.add(SPOT_NAME), heroFull, 0);
        // The script may move records; find this one again before counting.
        spot = spotFind(gx, gy, SPOT_HIDING_PLACE);
        var removed = 0;
        if (spot !== null) {
            var uses = spot.uses;
            if (uses < SPOT_ENDLESS) {
                uses -= 1;
                spot.record.add(SPOT_USES).writeU16(uses);
            }
            if (uses === 0 || uses > SPOT_ENDLESS) {
                n.remove(interp, spot.index);
                removed = 1;
                var pos = Memory.alloc(16);
                pos.writeU32(0);
                pos.add(4).writeS32(gx);
                pos.add(8).writeS32(gy);
                pos.add(0xC).writeU32(spot.layer & 0xFF);
                var other = n.at(interp, pos.readU32(), pos.add(4).readU32(), pos.add(8).readU32(),
                                 pos.add(0xC).readU32(), 0);
                if (other === 0 && spot.layer === 0) {
                    var tile = n.tile(ptr(VA.objectManager).readPointer().readPointer(), pos);
                    if (!tile.isNull()) {
                        tile.add(SPOT_SPARKLE).writeU8(tile.add(SPOT_SPARKLE).readU8() & 0x7F);
                    }
                }
            }
        }
        var after = spotObjectTable();
        var made = [];
        for (var i = 0; i < after.length; i++) {
            if (after[i] !== 0 && (i >= before.length || after[i] !== before[i])) {
                made.push(i);
            }
        }
        // The fillScript hook does not see a call made from the tick.
        evt("spot.open", spotOpenFields(used, made));
        return { gx: gx, gy: gy, removed: removed, items: spotItems(made).join(";") };
    };
});
