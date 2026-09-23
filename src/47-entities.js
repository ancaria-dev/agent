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
// hundreds of them.  Records are ref:type:level:hp:maxHp:x:y:player joined by
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
                  c.player].join(":"));
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
    var c = creatureFields(parseInt(f.ref, 10));
    if (c === null) {
        throw new Error("No creature at ref " + f.ref + ".");
    }
    return c;
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
