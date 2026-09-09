// Attributes.  The six recalc writers (+0x179B09..) are NOT hooked: they run
// for every creature during save load, and an interceptor there kills Frida
// mid-load.  Every legitimate change instead passes through the cold grant/
// spend dispatcher, so that is where Coderpack sits.
//
// There is no register to rewrite here.  The value is written inside the call.
// So the verdict is applied the only honest way: read what the game committed,
// then write the value the mod asked for.  A verdict does not have to be a
// register swap.  It has to be applied before anything else observes the field.

var ATTR_OFFSETS = [0x10, 0x12, 0x14, 0x16, 0x18, 0x1A];
var ATTR_NAMES = ["Strength", "Endurance", "Dexterity",
                  "PhysicalRegeneration", "MentalRegeneration", "Charisma"];

var ATTR_POINTS = 0x23;
var SKILL_POINTS = 0x42;

function readPoints() {
    if (!live(heroSheet)) {
        return null;
    }
    try {
        return {
            attr: heroSheet.add(ATTR_POINTS).readU8(),
            skill: heroSheet.add(SKILL_POINTS).readU16()
        };
    } catch (e) {
        return null;
    }
}

hook("statGrant", RVA.statGrant, {
    onEnter: function () {
        var ctx = this.context;
        if (!isHeroSheet(ctx.ecx)) {
            return;
        }
        this.sheet = snapPtr(ctx.ecx);
        // Stack arg: 0..5 spends a point on that attribute, 7 is the level-up
        // reward.  It is not a level writer, and treating it as one made every
        // Strength click look like a level-up.
        this.reason = ctx.esp.add(4).readU32() >>> 0;
        this.points = readPoints();
        if (this.reason <= 5) {
            this.prev = this.sheet.add(ATTR_OFFSETS[this.reason]).readU16();
        }
    },
    onLeave: function () {
        if (!this.sheet) {
            return;
        }
        var points = readPoints();
        if (this.points !== null && points !== null) {
            if (points.attr !== this.points.attr) {
                evt("attrpoints.changed",
                    { prev: this.points.attr, next: points.attr,
                      reason: this.reason });
            }
            if (points.skill !== this.points.skill) {
                evt("skillpoints.changed",
                    { prev: this.points.skill, next: points.skill,
                      reason: this.reason });
            }
        }
        if (this.reason > 5) {
            return;
        }

        var offset = ATTR_OFFSETS[this.reason];
        var committed = this.sheet.add(offset).readU16();
        var verdict = ask("attr.spend", {
            attr: this.reason, name: ATTR_NAMES[this.reason],
            prev: this.prev, next: committed
        });

        var next = verdict.cancel ? this.prev : asked(verdict, "next", committed);
        next = Math.max(0, Math.min(0xFFFF, next));
        if (next !== committed) {
            this.sheet.add(offset).writeU16(next);
        }
        evt("attr.changed", {
            attr: this.reason, name: ATTR_NAMES[this.reason],
            prev: this.prev, next: next
        });
    }
});
