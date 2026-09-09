// World / hero lifecycle.  These are the windows other modules attach in:
// cObjectManager::load() unpacks ~3000 objects and any interceptor on a
// per-object path inside that loop kills Frida, so only the function ENTRIES
// are hooked here, never anything in their bodies.

var worldLoaded = false;

hook("worldLoad", RVA.worldLoad, {
    onEnter: function () {
        worldLoaded = false;
        evt("session.world_loading", {});
    },
    onLeave: function () {
        worldLoaded = true;
        evt("session.world_loaded", {});
    }
});

hook("heroLoad", RVA.heroLoad, {
    onLeave: function () {
        if (live(heroFull)) {
            evt("session.hero_loaded", heroState());
        }
    }
});

hook("heroTerminate", RVA.heroTerminate, {
    onEnter: function () {
        evt("session.hero_terminated", {});
        heroFull = null;
        heroSheet = null;
    }
});

// Every read here can fault, and on the way back to the main menu they do: the
// game frees the hero while getLocalHero is still handing out the pointer, so
// the object passes looksLikeHero one moment and is unmapped the next.  That
// was six identical access violations at 0x2b3d24a0 on every exit to the menu.
// A half-read state is worth nothing, so a fault gives up on the whole thing.
function heroState() {
    if (!live(heroFull)) {
        return {};
    }
    try {
        var classId = heroFull.add(0x10).readU32() >>> 0;
        return {
            cls: classId,
            clsName: CLASSES[classId] || ("unknown" + classId),
            level: heroFull.add(0x3FE).readU16(),
            hp: heroFull.add(0x4D8).readU32() >>> 0,
            maxHp: heroFull.add(0x4D4).readU32() >>> 0,
            gold: heroFull.add(0x3EE).readU32() >>> 0,
            exp: heroFull.add(0x3B4).readU32() >>> 0,
            x: heroFull.add(0x1C).readS32(),
            y: heroFull.add(0x20).readS32()
        };
    } catch (e) {
        // The hero went away underneath us.  The terminate hook will say so.
        heroFull = null;
        heroSheet = null;
        return {};
    }
}

onHero(function () {
    evt("hero.captured", heroState());
});
