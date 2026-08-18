// Level.  Read on the tick, not at the write, and report only.
//
// The write itself (+0x185EBE, `mov [ebx+0x56], ax`) looks like an ideal hook
// site and is not one.  Attaching there killed the game on every load from a
// save, while a fresh level-1 character was fine -- so it was never the boost or
// the gate, both of which do the same thing either way.
//
// The shape around it is the one that has now failed three times.  The
// instruction is four bytes, so the five-byte jump swallows the one after it,
// and three bytes BEFORE it sits `mov edx, [ebx+4]` whose EDX is read twenty
// bytes later by `cmp [edx+0xc], 0x10`.  Gold died twice on exactly that: a
// short mid-function site with a scratch register loaded before it and consumed
// after.  What the trampoline actually does to that register is not proven, and
// three cases is a pattern rather than a mechanism -- but it is enough to stop
// choosing sites like this one.
//
// Nothing is lost by moving.  The level was already report-only -- it is one of
// the fields the anti-cheat mirrors XOR-encoded, and it drives the grant tables,
// so rewriting it would desync both -- and a number that only has to be noticed
// can be noticed a few milliseconds later.
var lastLevel = 0;

onTick(function () {
    if (!live(heroFull)) {
        return;
    }
    var now;
    try {
        now = heroFull.add(0x3FE).readU16();
    } catch (e) {
        return;
    }
    if (now === lastLevel || now < 1 || now > 250) {
        return;
    }
    // The first reading is where the character already was, not a level-up.
    if (lastLevel === 0) {
        lastLevel = now;
        return;
    }
    // The game's level-up loop runs to completion inside addExperience, so a
    // big grant is already several levels by the time the tick sees it.  Those
    // levels really did happen, and a mod that rewards one per level should get
    // one per level -- so the gap is reported step by step rather than as a
    // single jump from 20 to 35.
    while (lastLevel < now) {
        evt("level.changed", { prev: lastLevel, next: lastLevel + 1 });
        lastLevel += 1;
    }
    // Downwards is not a level-up: a different character, or a reload.
    lastLevel = now;
});

// A new character reuses the same process, so the baseline has to go with it.
onHero(function () {
    lastLevel = 0;
});
