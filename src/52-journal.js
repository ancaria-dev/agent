// The journal: opponents defeated, resurrections, areas discovered.
//
// None of it lives on the hero.  The counters sit in a statistics block the
// Statistics page reads (cStats, one per player, 0x00AA4518 in single player),
// and the obvious setters only run on save and load, so the hooks are on the
// three places play actually bumps them.  All three are cold.

var JOURNAL = {
    discovered: 0x56EC,
    kills: 0x56F0,
    resurrections: 0x56F4
};

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
