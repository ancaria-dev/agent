// The journal: opponents defeated, resurrections, areas discovered.
//
// None of it lives on the hero.  The counters sit in a statistics block the
// Statistics page reads (cStats, one per player, 0x00AA4518 in single player),
// and the obvious setters only run on save and load, so the hooks are on the
// three places play actually bumps them.  All three are cold.

var JOURNAL = {
    graph: 0x56E8,
    discovered: 0x56EC,
    kills: 0x56F0,
    resurrections: 0x56F4,
    hours: 0x56F8,
    minutes: 0x56FC,
    millis: 0x5700,
    sinceDeath: 0x570C
};

var getGameState = new NativeFunction(at(RVA.getGameState), "pointer", [],
                                      { abi: "mscdecl" });
var getPlayerStats = new NativeFunction(at(RVA.getPlayerStats), "pointer",
                                        ["int"], { abi: "mscdecl" });
var survivalCurve = new NativeFunction(at(RVA.survivalCurve), "float",
                                       ["float", "float", "float", "float"],
                                       { abi: "mscdecl" });

// The block the Statistics page reads, found the way the page finds it: the
// game state's player id, then that player's block.  0x00AA4518 in single
// player, but asking is what keeps this right if that ever differs.
function journalBlock() {
    var state = getGameState();
    if (state.isNull()) {
        throw new Error("No game state yet.");
    }
    var block = getPlayerStats(state.add(0x14).readS32());
    if (block.isNull()) {
        throw new Error("No statistics block for this player.");
    }
    return block;
}

// Everything on the Statistics page, plus the survival bonus the character
// sheet shows, computed by the game's own curve: minutes since the last death
// in, a percentage out, with the constants the game itself passes.
command("player.stats", function () {
    var block = journalBlock();
    var u32 = function (offset) {
        return block.add(offset).readU32() >>> 0;
    };
    var sinceDeath = u32(JOURNAL.sinceDeath);
    return {
        kills: u32(JOURNAL.kills),
        resurrections: u32(JOURNAL.resurrections),
        areas: u32(JOURNAL.discovered),
        graph: u32(JOURNAL.graph),
        playMillis: ((u32(JOURNAL.hours) * 60 + u32(JOURNAL.minutes)) * 60000) +
                    u32(JOURNAL.millis),
        sinceDeath: sinceDeath,
        survival: survivalCurve(0.0, sinceDeath / 60000, 120.0, 50.0)
    };
});

// Mid-function, inside the kill recorder: `mov [ebp+0x56F0], eax` with EAX
// already incremented.  EBX still holds the recorder's first argument, the
// victim's type, and [esp+0x2C] its third, which the game keeps as a
// per-type maximum.  That one is sent raw as `a2` until it is confirmed to be
// the victim's level.  onEnter only: this is not a function entry.
hook("killCount", RVA.killCount, function () {
    var ctx = this.context;
    try {
        var type = ctx.ebx.toUInt32() >>> 0;
        evt("journal.kill", {
            total: ctx.eax.toUInt32() >>> 0,
            type: type,
            name: typeName(type),
            a2: ctx.esp.add(0x2C).readU16()
        });
    } catch (e) {}
});

// A whole function, `this` = cStats.  It also zeroes the milliseconds since
// the last death, which is what the survival bonus counts.
hook("resurrect", RVA.resurrect, function () {
    try {
        var count = this.context.ecx.add(JOURNAL.resurrections).readU32() >>> 0;
        evt("journal.resurrection", { count: count + 1 });
    } catch (e) {}
});

// `inc [ecx+0x56EC] / ret`, and nothing else.
hook("discover", RVA.discover, function () {
    try {
        var areas = this.context.ecx.add(JOURNAL.discovered).readU32() >>> 0;
        evt("journal.discovery", { areas: areas + 1 });
    } catch (e) {}
});
