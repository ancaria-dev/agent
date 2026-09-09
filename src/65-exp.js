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
        this.sheet = snapPtr(ctx.ebx);
        this.prev = prev;
    },
    onLeave: function () {
        if (!this.sheet) {
            return;
        }
        try {
            evt("exp.changed", {
                prev: this.prev,
                next: this.sheet.add(0x0C).readU32() >>> 0
            });
        } catch (e) {}
    }
});
