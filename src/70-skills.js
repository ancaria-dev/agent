// Skills.  Every slot goes through ONE function, the one the character screen's
// buttons call, and the hook sits at its entry.
//
// Not at the write inside it.  `mov [eax+edi+0x2c], cl` at +0x1827DA is four
// bytes long, so Frida's five-byte trampoline spills onto the next instruction,
// and two jumps from the clamp-to-0 / clamp-to-255 branches land exactly there:
// a character with empty skill slots crashed on load.  The instruction after it,
// +0x1827DE, together with the hook on cUI_Manager::receive_event, crashed the
// game on every skill point spent, even with empty callbacks.  The entry did
// neither.
//
// The entry has what the write had: the sheet, the slot and the delta.  The
// base level moves only when the call spends points and there are enough of
// them; it becomes the old value plus the delta, held to 0..255.  The verdict
// is applied through the delta for a veto (0 changes nothing and spends
// nothing) and by writing the level once the call is over for a change, the
// same way attributes work, so a mod's number never alters the points spent.
//
// Slots are reported by index, never by name: the skill set differs per class
// and per character, so a fixed index-to-name table would be wrong for most.

var SKILLS_AT = 0x2C;
var SKILL_POINTS_AT = 0x42;
var SKILL_SLOTS = 8;
var SKILL_SWEEP_MS = 50;

// Raises in progress, as calls (see callOpen), each holding what to report.
var skillCalls = [];
var skillCommitFn = null;

hook("skillRaise", RVA.skillRaise, function (args) {
    var sheet = snapPtr(this.context.ecx);
    if (!isHeroSheet(sheet)) {
        return;
    }
    var slot = args[0].toInt32();
    var delta = (args[1].toInt32() << 16) >> 16;
    var spends = (args[2].toUInt32() & 0xFF) !== 0;
    if (slot < 0 || slot >= SKILL_SLOTS || delta === 0 || !spends) {
        return;
    }
    var prev;
    var points;
    try {
        prev = sheet.add(SKILLS_AT + slot).readU8();
        points = sheet.add(SKILL_POINTS_AT).readU16();
    } catch (e) {
        return;
    }
    if (points < delta) {
        return;
    }
    var next = Math.max(0, Math.min(0xFF, prev + delta));

    var verdict = ask("skill.change", { slot: slot, delta: delta, prev: prev, next: next });
    if (verdict.cancel) {
        args[1] = ptr(0);
        return;
    }
    var wanted = Math.max(0, Math.min(0xFF, asked(verdict, "next", next)));
    callOpen(skillCalls, this.context, {
        sheet: sheet, slot: slot, points: points, wanted: wanted === next ? null : wanted
    });
});

// Once a raise is over: the level a mod asked for, then what the game now holds.
function skillDone(raise) {
    if (raise.wanted !== null) {
        later(function () {
            raise.sheet.add(SKILLS_AT + raise.slot).writeU8(raise.wanted);
            if (skillCommitFn === null) {
                skillCommitFn = new NativeFunction(at(RVA.commitStats), "void",
                                                   ["pointer"], { abi: "thiscall" });
            }
            skillCommitFn(raise.sheet);
            evt("skill.changed", { slot: raise.slot, next: raise.wanted });
        });
    } else {
        evt("skill.changed", { slot: raise.slot,
                               next: raise.sheet.add(SKILLS_AT + raise.slot).readU8() });
    }
    // Remaining skill points: report only.  This is a budget the UI spends
    // against, and multiplying it once wrapped a live save's counter to 65535.
    var now = raise.sheet.add(SKILL_POINTS_AT).readU16();
    if (now !== raise.points) {
        evt("skillpoints.changed", { prev: raise.points, next: now });
    }
}

setInterval(function () {
    callSweep(skillCalls, skillDone);
}, SKILL_SWEEP_MS);
