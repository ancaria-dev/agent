// Regions and sectors: where the hero is, in the game's own map cells.
//
// All three are function entries on the script interpreter, and cold: enter
// and exit run once per region crossing.  Region ids are sector numbers: one
// crossing enters the nine sectors of the 3x3 ring around the hero at once.
// The named areas of the map screen are a different table, read further down.
//
// thiscall, so args[0] is the first stack argument.  Both region functions
// NULL-check args[0] and args[1] at the top and return, so a zero id is the
// game's own "nothing happened" and is not reported either.

var worldRegion = 0;
var worldSector = null;

hook("regionEnter", RVA.regionEnter, {
    onEnter: function (args) {
        var id;
        try {
            id = args[0].toUInt32() >>> 0;
            if (id === 0 || args[1].isNull()) {
                return;
            }
        } catch (e) {
            return;
        }
        var from = worldRegion;
        worldRegion = id;
        evt("world.region_enter", { id: id, from: from });
    }
});

hook("regionExit", RVA.regionExit, {
    onEnter: function (args) {
        var id;
        try {
            id = args[0].toUInt32() >>> 0;
            if (id === 0 || args[1].isNull()) {
                return;
            }
        } catch (e) {
            return;
        }
        evt("world.region_exit", { id: id });
    }
});

hook("sectorEnter", RVA.sectorEnter, {
    onEnter: function (args) {
        var x, y;
        try {
            x = args[0].toInt32();
            y = args[1].toInt32();
        } catch (e) {
            return;
        }
        worldSector = { x: x, y: y };
        evt("world.sector_enter", { x: x, y: y });
    }
});

// Areas: the named regions Sacred Gold counts kills in, Northern Core Region
// and the rest.  The game keeps nine in a table of 0x40-byte entries: the
// area bytes each covers, its key, the kills it needs and the kills left.  A
// sector carries its area byte, [[sector+0x17C]+0xD7], so the hero's area is
// read through the hero's sector the way the world map's panel reads it.  The
// key is stable and English; uiString turns it into what the map shows.
var AREA_ENTRIES = 32;
var AREA_SIZE = 0x40;
var AREA_BYTES = 16;

function areaByteHere() {
    if (!live(heroFull)) {
        return 0;
    }
    var world = ptr(VA.objectManager).readPointer().readPointer();
    if (world.isNull()) {
        return 0;
    }
    var id = heroFull.add(0x18).readU16();
    var begin = world.add(0x240).readPointer();
    var end = world.add(0x244).readPointer();
    if (id === 0 || id >= ((end.toUInt32() - begin.toUInt32()) >> 2)) {
        return 0;
    }
    var sector = begin.add(id * 4).readPointer();
    if (sector.isNull()) {
        return 0;
    }
    var info = sector.add(0x17C).readPointer();
    return info.isNull() ? 0 : info.add(0xD7).readU8();
}

// The table is sampled twice a second and its names never change in a session.
var areaNames = {};

function areaName(key) {
    if (areaNames[key] === undefined) {
        var name = uiString(key);
        if (!name) {
            return "";
        }
        areaNames[key] = name;
    }
    return areaNames[key];
}

// The key fills a 32-byte field padded with 0xFF, not always NUL-terminated,
// and an unused entry is all padding.
function areaKey(e) {
    var key = "";
    for (var i = 0; i < 32; i++) {
        var b = e.add(0x10 + i).readU8();
        if (b === 0 || b >= 0x80) {
            break;
        }
        key += String.fromCharCode(b);
    }
    return key;
}

function areaEntry(index) {
    var e = ptr(VA.areas).add(index * AREA_SIZE);
    var key = areaKey(e);
    if (!key) {
        return null;
    }
    return {
        index: index,
        key: key,
        name: areaName(key),
        needed: e.add(0x30).readU32(),
        left: e.add(0x38).readU32(),
        finale: e.add(0x34).readU8() ? 1 : 0
    };
}

// The first entry listing the byte, which is what the game's own lookups take:
// bytes 13 and 16 are listed twice.
function areaOf(byte) {
    if (byte === 0) {
        return null;
    }
    for (var i = 0; i < AREA_ENTRIES; i++) {
        var e = ptr(VA.areas).add(i * AREA_SIZE);
        for (var j = 0; j < AREA_BYTES; j++) {
            if (e.add(j).readU8() === byte) {
                return areaEntry(i);
            }
        }
    }
    return null;
}

function areaFields(a) {
    return a === null ? {} : {
        area: a.key, areaName: a.name, areaIndex: a.index,
        areaNeeded: a.needed, areaLeft: a.left, areaFinale: a.finale
    };
}

// Every area, one record each: index:key:needed:left:finale joined by ';', and
// the localized names as key=name joined by '|' (a name can hold a comma).
command("world.areas", function () {
    var out = [];
    var names = [];
    for (var i = 0; i < AREA_ENTRIES; i++) {
        var a = areaEntry(i);
        if (a !== null) {
            out.push([a.index, a.key, a.needed, a.left, a.finale].join(":"));
            names.push(a.key + "=" + a.name);
        }
    }
    return { n: out.length, areas: out.join(";"), names: names.join("|") };
});

// Sampled, not hooked: the hero's area follows its sector, and an area is
// cleared inside the kill statistics.  A kill counts in the victim's area,
// which is why every area is watched, not only the hero's.
var areaLastKey = null;
var areaLastCounts = null;

onTickEvery(500, function () {
    if (isLoading() || !live(heroFull)) {
        areaLastKey = null;
        areaLastCounts = null;
        return;
    }
    var here;
    var counts = {};
    try {
        here = areaOf(areaByteHere());
        for (var i = 0; i < AREA_ENTRIES; i++) {
            var a = areaEntry(i);
            if (a !== null) {
                counts[a.key] = a;
            }
        }
    } catch (e) {
        return;
    }
    var key = here === null ? "" : here.key;
    if (areaLastKey !== null && key !== areaLastKey) {
        var before = areaLastCounts === null ? undefined : areaLastCounts[areaLastKey];
        var fields = areaFields(here);
        fields.prev = areaLastKey;
        fields.prevName = before === undefined ? "" : before.name;
        evt("world.area", fields);
    }
    if (areaLastCounts !== null) {
        for (var k in counts) {
            var was = areaLastCounts[k];
            var now = counts[k];
            if (was === undefined) {
                continue;
            }
            if (now.left === 0 && was.left > 0) {
                evt("world.area_cleared", areaFields(now));
            }
        }
    }
    areaLastKey = key;
    areaLastCounts = counts;
});

// The final battle announcement.  The kill count (thiscall(entry)(u16 kills))
// announces UI_REGION_FINALBATTLE the first time an area's kills left drop
// under 1000, and only while its +0x34 flag is clear.  The entry works out
// whether this call will announce and asks first: a veto sets the flag, and
// the game then believes it already announced.  Once per kill, never while
// loading.
var AREA_FINALE_BELOW = 1000;

hook("areaKill", RVA.areaKill, {
    onEnter: function (args) {
        this.announce = null;
        try {
            var entry = snapPtr(this.context.ecx);
            var kills = args[0].toUInt32() & 0xFFFF;
            var left = entry.add(0x38).readU32();
            var after = left >= kills ? left - kills : 0;
            if (after === 0 || after >= AREA_FINALE_BELOW || entry.add(0x34).readU8() !== 0) {
                return;
            }
            var index = entry.sub(ptr(VA.areas)).toInt32() / AREA_SIZE;
            var fields = areaFields(areaEntry(index));
            fields.areaLeft = after;
            var verdict = ask("world.area_finale", fields);
            if (verdict.cancel) {
                entry.add(0x34).writeU8(1);
                return;
            }
            this.announce = fields;
        } catch (e) {}
    },
    onLeave: function () {
        if (this.announce !== null) {
            evt("world.area_finale_shown", this.announce);
        }
    }
});

// What the hooks above last saw.  Nothing is known until the hero has crossed
// into a region or sector since the agent attached, and 0 / an absent sector
// says so rather than guessing.
//
// The campaign and the difficulty are the game's own globals: cEngine::load
// sets both from the save, the main menu and the hero select from their
// choices.  Outside a world they only remember the last choice, so they are
// sent while there is a hero.  Hardcore is the save's flag in the player's
// statistics block (cStats flag 4), read through the journal's own lookup
// when that module is loaded.
var WORLD_HARDCORE = 0x5708;       // cStats flag 4

command("world.state", function () {
    var out = { region: worldRegion };
    if (worldSector !== null) {
        out.sx = worldSector.x;
        out.sy = worldSector.y;
    }
    if (live(heroFull)) {
        out.campaign = ptr(VA.campaign).readU16();
        out.difficulty = ptr(VA.difficulty).readU32();
        try {
            var area = areaOf(areaByteHere());
            var fields = areaFields(area);
            for (var k in fields) {
                out[k] = fields[k];
            }
        } catch (e) {}
        if (typeof journalBlock === "function") {
            try {
                out.hardcore = journalBlock().add(WORLD_HARDCORE).readU8() !== 0 ? 1 : 0;
            } catch (e) {}
        }
    }
    return out;
});
