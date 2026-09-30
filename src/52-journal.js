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
    sinceDeath: 0x570C,
    flags: 0x5704,
    created: 0x5720
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
    // The day the hero was made, set once from GetLocalTime (0x00423F50):
    // the year's low byte plus 0x44, then month, then day.
    var yearByte = block.add(JOURNAL.created).readU8();
    var month = block.add(JOURNAL.created + 1).readU8();
    var day = block.add(JOURNAL.created + 2).readU8();
    var created = "";
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
        created = (0x700 | ((yearByte - 0x44) & 0xFF)) + "-" + pad(month) + "-" + pad(day);
    }
    // The difficulties an exported hero is offered, the hero select's rule
    // (0x006F4ED0, 0x0070FDF0) over the same six flags: the highest set flag
    // k (1..6) opens difficulties up to k, at least Silver, at most Niobium.
    var unlocked = 1;
    for (var k = 1; k <= 6; k++) {
        if (block.add(JOURNAL.flags + k - 1).readU8() !== 0) {
            unlocked = k;
        }
    }
    return {
        unlocked: Math.min(unlocked, 4),
        created: created,
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

// The journal's resurrections and the clock the survival bonus runs on, both
// plain counters of the statistics block: the game keeps no copy of them
// elsewhere, and its own death handler (incrementResurrections) writes them
// the same way.  sinceDeath is in milliseconds, as the game counts it.
command("player.journal_set", function (f) {
    var block = journalBlock();
    if (f.resurrections !== undefined) {
        var n = parseInt(f.resurrections, 10);
        if (isNaN(n) || n < 0) {
            throw new Error("Bad resurrection count " + f.resurrections + ".");
        }
        block.add(JOURNAL.resurrections).writeU32(n >>> 0);
    }
    if (f.sinceDeath !== undefined) {
        var ms = parseInt(f.sinceDeath, 10);
        if (isNaN(ms) || ms < 0 || ms > 0x7FFFFFFF) {
            throw new Error("Bad time since death " + f.sinceDeath + ".");
        }
        block.add(JOURNAL.sinceDeath).writeU32(ms >>> 0);
    }
    return { ok: 1 };
});

// Sets the difficulties an exported hero will be offered the way the finale
// does it (0x004AEE30 raises the current difficulty's count, 0x00424CF0):
// the difficulty below the wanted one counts as completed at least once, and
// every count above it is cleared.  f.level is 1 (Silver) .. 4 (Niobium).
command("player.unlock", function (f) {
    var level = parseInt(f.level, 10);
    if (isNaN(level) || level < 1 || level > 4) {
        throw new Error("No difficulty " + f.level + " to unlock up to.");
    }
    var block = journalBlock();
    for (var k = level; k < 6; k++) {
        block.add(JOURNAL.flags + k).writeU8(0);
    }
    if (level > 1 && block.add(JOURNAL.flags + level - 1).readU8() === 0) {
        block.add(JOURNAL.flags + level - 1).writeU8(1);
    }
    return { ok: 1 };
});

// Completed difficulties and the survival bonus, compared about once a second.
// Neither has a place to hook: the finale raises a count through a script
// command (0x004AEE30) and the console through cheats, and the bonus is a
// curve over a millisecond clock nothing announces.  One sampler reads six
// bytes and a dword of the statistics block.  The first reading after a hero
// arrives is where they start, not a change.
var journalCountsLast = null;
var journalSurvivalLast = null;

function journalUnlocked(counts) {
    var unlocked = 1;
    for (var k = 1; k <= counts.length; k++) {
        if (counts[k - 1] !== 0) {
            unlocked = k;
        }
    }
    return Math.min(unlocked, 4);
}

onSample(SAMPLE_SLOW, ["hero.difficulty_completed", "hero.survival_changed"], function () {
    if (isLoading() || !live(heroFull)) {
        journalCountsLast = null;
        journalSurvivalLast = null;
        return;
    }
    var block;
    try {
        block = journalBlock();
    } catch (e) {
        return;
    }
    var counts = [];
    for (var k = 0; k < 6; k++) {
        counts.push(block.add(JOURNAL.flags + k).readU8());
    }
    var before = journalCountsLast;
    journalCountsLast = counts;
    if (before !== null) {
        for (var d = 0; d < 5; d++) {
            if (counts[d] > before[d]) {
                evt("hero.difficulty_completed", { difficulty: d, count: counts[d],
                                                   unlocked: journalUnlocked(counts) });
            }
        }
    }
    var since = block.add(JOURNAL.sinceDeath).readU32() >>> 0;
    // Whole minutes, as the character screen feeds the curve (0x006A7E63).
    var bonus = survivalCurve(0.0, Math.floor(since / 60000), 120.0, 50.0);
    var last = journalSurvivalLast;
    journalSurvivalLast = bonus;
    if (last !== null && Math.floor(bonus) !== Math.floor(last)) {
        evt("hero.survival_changed", { bonus: bonus, prev: last, sinceDeath: since });
    }
});

onHero(function () {
    journalCountsLast = null;
    journalSurvivalLast = null;
});

// The kill recorder's entry, `this` = cStats.  Its first argument is the
// victim's type, and its third the value the game keeps as a per-type maximum,
// sent raw as `a2` until it is confirmed to be the victim's level.  Every call
// reaches the counter, which it raises by one unless it is at INT32_MAX.
// Not at the counter's write itself: an interceptor there, even an empty one,
// made every kill grant 74063647 experience.
var KILLS_MAX = 0x7FFFFFFF;

hook("recordKill", RVA.recordKill, function (args) {
    try {
        var type = args[0].toUInt32() >>> 0;
        var kills = this.context.ecx.add(JOURNAL.kills).readU32() >>> 0;
        evt("journal.kill", {
            total: kills === KILLS_MAX ? kills : kills + 1,
            type: type,
            name: typeName(type),
            a2: args[2].toUInt32() & 0xFFFF
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
