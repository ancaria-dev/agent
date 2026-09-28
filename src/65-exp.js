// Experience.  Decided at addExperience's entry, reported once the call is over.
//
// No hook inside addExperience.  The old one sat on the write of the total,
// `mov [ebx+0x0C], eax`, and with a hooked call further up the stack the game
// crashed: after a quest reward that followed a kill, and on every kill once
// the entry was hooked too.  The skill write did the same with receive_event.
//
// A verdict changes the amount the game is about to add, never the total it
// writes: experience is mirrored by the anti-cheat.  The entry is thiscall,
// ECX the sheet and args[0] the amount.  The game ignores a negative amount,
// so a mod can raise the total or keep it, never lower it.
//
// The total is unsigned: the game's own ceiling, 0x9A31718F, lies above
// INT32_MAX, so it is read unsigned and a mod's answer is held to that
// ceiling rather than to asked()'s int32 cap.
var EXP_MAX = 0x9A31718F;
var EXP_TOTAL_AT = 0x0C;
var EXP_SWEEP_MS = 50;

// Gains in progress, as calls (see callOpen), each holding the sheet and the
// totals before and after it.  The total after is worked out here, the way the
// game adds and caps, because gains can follow each other within one check:
// a quest reward right after a kill is two in a row.
var expCalls = [];

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
        var amount = Math.min(INT32_MAX, next - prev);
        args[0] = ptr(amount);
        next = Math.min(EXP_MAX, prev + amount);
    }
    callOpen(expCalls, this.context, { sheet: sheet, prev: prev, next: next });
});

setInterval(function () {
    callSweep(expCalls, function (gain) {
        // Only a gain that landed: a call the game left early wrote nothing.
        var now = gain.sheet.add(EXP_TOTAL_AT).readU32() >>> 0;
        if (gain.next !== gain.prev && now >= gain.next) {
            evt("exp.changed", { prev: gain.prev, next: gain.next });
        }
    });
}, EXP_SWEEP_MS);
