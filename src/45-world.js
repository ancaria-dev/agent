// Regions and sectors: where the hero is, in the game's own map cells.
//
// All three are function entries on the script interpreter, and cold: enter
// and exit run once per region crossing.  Region ids are map cells (1777..1999
// seen in one area), not the named areas of the map screen, and no key from an
// id to a localized name has been found, so none is sent.
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
        if (typeof journalBlock === "function") {
            try {
                out.hardcore = journalBlock().add(WORLD_HARDCORE).readU8() !== 0 ? 1 : 0;
            } catch (e) {}
        }
    }
    return out;
});
