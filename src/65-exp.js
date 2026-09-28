// Experience.  EAX holds the new total, ESI the gain, EBX the sheet, so the
// gain is recovered by subtraction and the total is what gets rewritten.
// The total is unsigned: the game's own ceiling, 0x9A31718F, lies above
// INT32_MAX, so it is read unsigned and a mod's answer is held to that
// ceiling rather than to asked()'s int32 cap.
var EXP_MAX = 0x9A31718F;

function expAsked(verdict, fallback) {
    var value = parseInt(verdict.set.next, 10);
    if (isNaN(value)) {
        return fallback;
    }
    return Math.max(0, Math.min(EXP_MAX, value));
}

hook("expWrite", RVA.expWrite, {
    onEnter: function () {
        var ctx = this.context;
        noteHeroSheet(ctx.ebx);
        if (!isHeroSheet(ctx.ebx)) {
            return;
        }
        var total = ctx.eax.toUInt32() >>> 0;
        var gain = ctx.esi.toInt32();
        var prev = total - gain;

        var verdict = ask("exp.gain", { gain: gain, prev: prev, next: total });
        var next = verdict.cancel ? prev : expAsked(verdict, total);
        if (next !== total) {
            ctx.eax = ptr(next);
        }
        // The site is the store itself (`mov [ebx+0x0C], eax`), so what EAX
        // holds now is what the game writes.  No onLeave: this is the middle of
        // addExperience, where [esp] is not a return address and Frida's
        // return trampoline would overwrite a local.
        evt("exp.changed", { prev: prev, next: next });
    }
});
