// Skills.  Every slot goes through ONE generic write, so a single hook covers
// all of them -- but NOT at the write itself.
//
// `mov [eax+edi+0x2c], cl` at +0x1827DA is four bytes long, so Frida's five-byte
// trampoline spills onto the next instruction, and two jumps from the
// clamp-to-0 / clamp-to-255 branches land exactly there.  A character with empty
// skill slots takes those branches while loading, jumps into the middle of the
// trampoline and the process dies.  That is what crashed the game on load, and
// `branch_targets_into.py` in the research repository says so without running anything.
//
// So the hook sits one instruction later, where the byte is already stored and
// EAX (slot), EDI (sheet) and EBX (delta) are all still live.  The verdict is
// applied by writing the byte, the same way attributes work.
//
// Slots are reported by index, never by name: the skill set differs per class
// and per character, so a fixed index-to-name table would be wrong for most.

var SKILLS_AT = 0x2C;

hook("skillWrite", RVA.skillWrite, {
    onEnter: function () {
        var ctx = this.context;
        if (!isHeroSheet(ctx.edi)) {
            return;
        }
        var delta = ctx.ebx.toUInt32() & 0xFF;
        if (delta === 0) {
            return;
        }
        var slot = ctx.eax.toUInt32() & 0xFF;
        var field = ctx.edi.add(SKILLS_AT + slot);
        var stored;
        try {
            stored = field.readU8();
        } catch (e) {
            return;
        }

        var verdict = ask("skill.change", {
            slot: slot, delta: delta, prev: stored - delta, next: stored
        });
        var wanted = verdict.cancel ? stored - delta
                                    : asked(verdict, "next", stored);
        wanted = Math.max(0, Math.min(0xFF, wanted));
        if (wanted !== stored) {
            field.writeU8(wanted);
        }
        evt("skill.changed", { slot: slot, next: wanted });
    }
});

// Remaining skill points, further down the same function.  Report only: this is
// a budget the UI spends against, and multiplying it once wrapped a live save's
// counter to 65535.
hook("skillPoints", RVA.skillPoints, {
    onEnter: function () {
        var ctx = this.context;
        if (isHeroSheet(ctx.edi)) {
            evt("skillpoints.changed", { next: ctx.eax.toUInt32() & 0xFFFF });
        }
    }
});
