// Combat arts.  The real store is a std::vector of 22-byte records on the
// sheet, [sheet+0x102] begin and [sheet+0x106] end, one record per art the
// character owns:
//
//   +0x04 art id    per class: the same name has a different id on another class
//   +0x05 aspect    which group the art is in; key on (id, aspect), never on id
//   +0x06 base level  what a rune raises
//   +0x07 gear bonus  added on top for the tooltip
//
// The UI draws from a 16-byte display cache that the game refills from this
// vector about sixty times a second, which is why writing the cache looked like
// it worked and then quietly undid itself.
//
// Record order is not UI order, and art names are not in the record: they come
// from per-class tables the research repository harvested, not from here.

var ARTS_BEGIN = 0x102;
var ARTS_END = 0x106;
var ART_SIZE = 22;
var ART = { id: 0x04, aspect: 0x05, level: 0x06, bonus: 0x07 };

// The hero's vector as [begin, end), or null when there is no hero.
function heroArtSpan() {
    if (!live(heroSheet)) {
        return null;
    }
    try {
        var begin = heroSheet.add(ARTS_BEGIN).readPointer();
        var end = heroSheet.add(ARTS_END).readPointer();
        if (begin.isNull() || end.compare(begin) < 0) {
            return null;
        }
        return [begin, end];
    } catch (e) {
        return null;
    }
}

// Which of the hero's records this is, or -1 when it is someone else's, or not
// on a record boundary at all.
function heroArtIndex(record) {
    var span = heroArtSpan();
    if (span === null || record.compare(span[0]) < 0 ||
            record.compare(span[1]) >= 0) {
        return -1;
    }
    var offset = record.sub(span[0]).toUInt32();
    return offset % ART_SIZE === 0 ? offset / ART_SIZE : -1;
}

function artFields(record, index) {
    return {
        index: index,
        id: record.add(ART.id).readU8(),
        aspect: record.add(ART.aspect).readU8(),
        level: record.add(ART.level).readU8(),
        bonus: record.add(ART.bonus).readU8()
    };
}

// `mov [eax+6], bl`: EAX is the record, BL the new base level already summed,
// CL the step.  One call per rune click, so it is cold enough to ask on.  The
// store is inside the patch and runs after this callback, so a rewritten BL is
// what the game keeps.  onEnter only: this is a mid-function site.
//
// A veto keeps the old level, and the rune is still spent: consuming it happens
// on a path this hook does not see.
hook("artRaise", RVA.artRaise, function () {
    var ctx = this.context;
    var record = ctx.eax;
    var index = heroArtIndex(record);
    if (index < 0) {
        return;
    }
    var art;
    try {
        art = artFields(record, index);
    } catch (e) {
        return;
    }
    var ebx = ctx.ebx.toUInt32() >>> 0;
    var next = ebx & 0xFF;
    var verdict = ask("art.raise", {
        index: index, id: art.id, aspect: art.aspect,
        prev: art.level, next: next, step: ctx.ecx.toUInt32() & 0xFF
    });
    var wanted = verdict.cancel ? art.level : asked(verdict, "next", next);
    wanted = Math.max(0, Math.min(0xFF, wanted));
    if (wanted !== next) {
        ctx.ebx = ptr(((ebx & 0xFFFFFF00) | wanted) >>> 0);
    }
    evt("art.changed", {
        index: index, id: art.id, aspect: art.aspect,
        prev: art.level, next: wanted
    });
});

// Every art the hero owns, in vector order, one record per `;`:
// index:id:aspect:level:bonus.
command("player.arts", function () {
    var span = heroArtSpan();
    if (span === null) {
        throw new Error("No hero found. Load a world first.");
    }
    var count = span[1].sub(span[0]).toUInt32() / ART_SIZE;
    var out = [];
    for (var i = 0; i < count; i++) {
        var art = artFields(span[0].add(i * ART_SIZE), i);
        out.push([art.index, art.id, art.aspect, art.level, art.bonus].join(":"));
    }
    return { n: out.length, arts: out.join(";") };
});

// The base level, written where a rune writes it.  The game sets bit 0 of
// +0x08 right after its own write, so this does too.
command("player.art", function (f) {
    var span = heroArtSpan();
    var index = parseInt(f.index, 10);
    if (span === null || isNaN(index) || index < 0 ||
            span[0].add((index + 1) * ART_SIZE).compare(span[1]) > 0) {
        throw new Error("No combat art at index " + f.index + ".");
    }
    var record = span[0].add(index * ART_SIZE);
    var level = Math.max(0, Math.min(0xFF, parseInt(f.level, 10) || 0));
    record.add(ART.level).writeU8(level);
    record.add(0x08).writeU8(record.add(0x08).readU8() | 1);
    var art = artFields(record, index);
    return { index: index, id: art.id, aspect: art.aspect,
             level: art.level, bonus: art.bonus };
});
