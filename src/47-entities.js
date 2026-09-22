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
