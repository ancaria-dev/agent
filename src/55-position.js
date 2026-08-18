// Position.  The HUD number is trunc(world / 53.66563), the divisor being a
// float in the PE that the game's own converter reads -- so it is read from
// there rather than hardcoded.
//
// There is no cheap "player moved" writer: full+0x1C is sampled instead, at
// three points the game already calls often enough to look continuous.  The
// event only fires when the HUD number actually changes.

var POS_SCALE = at(RVA.posScale).readFloat();
var lastX = -1;
var lastY = -1;

function samplePosition(source) {
    if (!live(heroFull)) {
        return;
    }
    try {
        var x = heroFull.add(0x1C).readS32();
        var y = heroFull.add(0x20).readS32();
        var uiX = Math.trunc(x / POS_SCALE);
        var uiY = Math.trunc(y / POS_SCALE);
        if (uiX === lastX && uiY === lastY) {
            return;
        }
        lastX = uiX;
        lastY = uiY;
        evt("pos.changed", { x: x, y: y, uiX: uiX, uiY: uiY, src: source });
    } catch (e) {}
}

onHero(function () {
    samplePosition("capture");
});

hook("posHero", RVA.getLocalHero, {
    onLeave: function (retval) {
        if (!retval.isNull() && isHeroFull(retval)) {
            samplePosition("hero");
        }
    }
});

// The world->HUD converter, but only when it is converting OUR coordinates
// (arg0 == hero+0x18); it runs for other objects too.
hook("posConvert", RVA.posConvert, {
    onEnter: function () {
        this.mine = false;
        if (!live(heroFull)) {
            return;
        }
        try {
            this.mine = same(this.context.esp.add(4).readPointer(),
                             heroFull.add(0x18));
        } catch (e) {}
    },
    onLeave: function () {
        if (this.mine) {
            samplePosition("ppos");
        }
    }
});

// Camera pan. Its arguments are NOT player coordinates -- it is only a cue to
// resample, because inventory nudges the view without moving the hero.
hook("posCamera", RVA.posCamera, {
    onEnter: function () {
        samplePosition("camera");
    }
});
