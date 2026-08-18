// Combat health.  All four writes live in one huge function (+0x16B3E0) and
// address current HP through the SHEET pointer in EBP, not the full object:
// sheet+0x130 == full+0x4D8.  Every earlier scan looked for displacement 0x4D8
// only, which is why the whole melee path was invisible for so long.
//
// onEnter only, deliberately: these are mid-function addresses, so [esp] is not
// a return address and an onLeave would make Frida track a bogus return site.
//
// Cold enough to ask on: a counter-only probe measured 34 executions in 22s of
// real combat, peak 5/s, 7 of them the player.  The regen writer touches the
// same field ~10 times a second per creature and is deliberately not hooked.

var HP_CUR = 0x130;
var HP_MAX = 0x12C;
var NEAR_DEATH = 0.15;

function hpKind(delta) {
    return delta < 0 ? "damage" : (delta > 0 ? "heal" : "noop");
}

function nearDeath(value, maxHp) {
    return value > 0 && (value <= 1 || value <= maxHp * NEAR_DEATH);
}

function entityHp(sheet, next, kind, damage) {
    var e = describe(sheet.sub(SHEET_EMBED));
    if (e === null) {
        return;
    }
    var delta = (next | 0) - (e.hp | 0);
    if (delta === 0 && kind !== "lethal") {
        return;
    }
    var payload = {
        type: e.typeId, name: e.name, level: e.level,
        prev: e.hp, next: next, max: e.maxHp,
        damage: damage, kind: kind
    };
    evt("entity.damage", payload);
    if (next <= 0 && e.hp > 0) {
        evt("entity.death", payload);
    }
}

function attachHp(name, rva, opts) {
    hook(name, rva, function () {
        var ctx = this.context;
        var sheet = ctx.ebp;
        var kind = opts.kind || null;
        var damage = opts.damageReg ? ctx[opts.damageReg].toInt32() : 0;

        var next;
        try {
            next = opts.valueReg === null
                ? opts.immediate
                : (ctx[opts.valueReg].toUInt32() >>> 0);
        } catch (e) {
            return;
        }

        if (!isHeroSheet(sheet)) {
            // Same layout for every creature, so a hit on a mob is reported
            // rather than dropped -- this is what makes Player : Entity real.
            entityHp(sheet, next, kind || hpKind(next), damage);
            return;
        }

        var prev, maxHp;
        try {
            prev = sheet.add(HP_CUR).readU32() >>> 0;
            maxHp = sheet.add(HP_MAX).readU32() >>> 0;
        } catch (e) {
            return;
        }

        var delta = (next | 0) - (prev | 0);
        if (delta === 0 && kind === null) {
            return;
        }
        kind = kind || hpKind(delta);

        var committed = next;
        if (opts.mutable === true) {
            var verdict = ask("health.damage", {
                kind: kind, damage: damage,
                prev: prev, next: next, max: maxHp
            });
            committed = verdict.cancel ? prev : asked(verdict, "next", next);
            if (committed < 0) {
                committed = 0;
            }
            if (committed > maxHp) {
                committed = maxHp;   // the game clamps right after us anyway
            }
            if (committed !== next) {
                ctx[opts.valueReg] = ptr(committed);
            }
        } else {
            evt("health.changing", {
                kind: kind, damage: damage,
                prev: prev, next: next, max: maxHp
            });
        }

        evt("health.changed", {
            kind: kind, prev: prev, next: committed, max: maxHp
        });
        entityHp(sheet, committed, kind, damage);

        if (committed <= 0 && prev > 0) {
            evt("health.death", { prev: prev, max: maxHp, blow: damage });
        } else if (nearDeath(committed, maxHp) && !nearDeath(prev, maxHp)) {
            evt("health.near_death", {
                next: committed, prev: prev, max: maxHp,
                percent: Math.round((committed * 100) / maxHp)
            });
        }
    });
}

// EAX already holds HP - damage and ECX the damage: the one site worth asking.
attachHp("hpDamage", RVA.hpDamage,
         { valueReg: "eax", damageReg: "ecx", mutable: true });
// Lethal hit. ESI is a zero constant the death path reuses two instructions
// later (cmp eax, esi), so rewriting it would corrupt the death path.
attachHp("hpLethal", RVA.hpLethal,
         { valueReg: "esi", kind: "lethal", mutable: false });
// Survive-with-1 effect: an immediate operand, nothing to rewrite.
attachHp("hpSurvive", RVA.hpSurvive,
         { valueReg: null, immediate: 1, kind: "survive", mutable: false });
attachHp("hpClamp", RVA.hpClamp,
         { valueReg: "eax", kind: "clamp", mutable: false });

// Max HP is recomputed, not written on a hot path: the gear/level stat commit
// is cold and is the honest place to notice it changed.
var lastMaxHp = 0;

hook("maxHpCommit", RVA.commitStats, {
    onEnter: function () {
        this.mine = isHeroSheet(this.context.ecx);
    },
    onLeave: function () {
        if (!this.mine || !live(heroSheet)) {
            return;
        }
        try {
            var maxHp = heroSheet.add(HP_MAX).readU32() >>> 0;
            if (maxHp !== lastMaxHp) {
                evt("health.max_changed", { prev: lastMaxHp, next: maxHp });
                lastMaxHp = maxHp;
            }
        } catch (e) {}
    }
});
