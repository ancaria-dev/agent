// Experience.  Decided at addExperience's entry, reported at the write.
//
// A verdict changes the amount the game is about to add, never the total it
// writes: experience is mirrored by the anti-cheat, and rewriting the committed
// total at the write made the game crash after a quest reward.  The entry is
// thiscall, ECX the sheet and args[0] the amount.  The game ignores a negative
// amount, so a mod can raise the total or keep it, never lower it.
//
// The total is unsigned: the game's own ceiling, 0x9A31718F, lies above
// INT32_MAX, so it is read unsigned and a mod's answer is held to that
// ceiling rather than to asked()'s int32 cap.
var EXP_MAX = 0x9A31718F;
var EXP_TOTAL_AT = 0x0C;

function expAsked(verdict, fallback) {
    var value = parseInt(verdict.set.next, 10);
    if (isNaN(value)) {
        return fallback;
    }
    return Math.max(0, Math.min(EXP_MAX, value));
}

hook("expGain", RVA.addExperience, function (args) {
    var sheet = snapPtr(this.context.ecx);
    noteHeroSheet(sheet);
    if (!isHeroSheet(sheet)) {
        return;
    }
    var gain = args[0].toInt32();
    if (gain <= 0) {
        return;
    }
    var prev;
    try {
        prev = sheet.add(EXP_TOTAL_AT).readU32() >>> 0;
    } catch (e) {
        return;
    }
    var total = Math.min(EXP_MAX, prev + gain);

    var verdict = ask("exp.gain", { gain: gain, prev: prev, next: total });
    var next = verdict.cancel ? prev : Math.max(prev, expAsked(verdict, total));
    if (next !== total) {
        args[0] = ptr(Math.min(INT32_MAX, next - prev));
    }
});

// The write itself, `mov [ebx+0x0C], eax`: EAX holds the new total, ESI the
// amount, EBX the sheet.  Read only.  No onLeave: this is the middle of
// addExperience, where [esp] is not a return address.
hook("expWrite", RVA.expWrite, {
    onEnter: function () {
        var ctx = this.context;
        noteHeroSheet(ctx.ebx);
        if (!isHeroSheet(ctx.ebx)) {
            return;
        }
        var total = ctx.eax.toUInt32() >>> 0;
        evt("exp.changed", { prev: total - ctx.esi.toInt32(), next: total });
    }
});
