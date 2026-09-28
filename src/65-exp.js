// Experience.  EAX holds the new total, ESI the gain, EBX the sheet, so the
// gain is recovered by subtraction and the total is what gets rewritten.
// The game clamps the total to 0x9A31718F itself, but a boosted value can still
// overflow int32 on the way there, so asked() caps it.

hook("expWrite", RVA.expWrite, {
    onEnter: function () {
        var ctx = this.context;
        noteHeroSheet(ctx.ebx);
        if (!isHeroSheet(ctx.ebx)) {
            return;
        }
        var total = ctx.eax.toInt32();
        var gain = ctx.esi.toInt32();
        var prev = total - gain;

        var verdict = ask("exp.gain", { gain: gain, prev: prev, next: total });
        var next = verdict.cancel ? prev : asked(verdict, "next", total);
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
