// The generic particle effect, TYPE_FX_GENERIC, made the way the quest
// script command Partikel makes it (0x004A8F90): a world object of that type,
// then a cEventFX with id 0x50, a colour and a preset (0..12) handed to the
// object's handleEvent.  On an object the effect follows it; at a point it
// sits at the point's render-space vector.
//
// Presets 6 and 9 cast the event's target to a creature and read through it
// unchecked: preset 6 at a point crashed the game (+0x396FB0).  They are
// refused anywhere but on a creature.  Preset 3, the quest arrow, stays until
// removed; the others fade by themselves.
//
// All on the engine thread, with exceptions: "propagate", like the spawns in
// 44-spawn.js.  Nothing is hooked.

var FX_TYPE_NAME = "TYPE_FX_GENERIC";
var FX_START = 0x50;
var FX_PRESETS = 13;
var FX_CREATURE_PRESETS = [6, 9];
var FX_POS = 0x18;
var FX_POS_SIZE = 16;
var FX_EVENT_SIZE = 0x100;
var FX_OBJECT_TYPE = 0x10;
// objFlags bit: placed in the world.
var FX_PLACED = 2;

var fxNative = null;

function fxFns() {
    if (fxNative === null) {
        var opts = { abi: "thiscall", exceptions: "propagate" };
        var eventArgs = ["pointer"];
        for (var i = 0; i < 17; i++) {
            eventArgs.push("uint32");
        }
        fxNative = {
            create: new NativeFunction(at(RVA.createByType), "uint32",
                                       ["pointer", "int", "pointer", "int", "int", "int"], opts),
            fix: new NativeFunction(at(RVA.fixSector), "uint8", ["pointer", "pointer"], opts),
            height: new NativeFunction(at(RVA.fxHeight), "float", ["pointer", "pointer"], opts),
            space: new NativeFunction(at(RVA.worldToSpace), "void", ["pointer", "pointer"],
                                      { abi: "mscdecl", exceptions: "propagate" }),
            event: new NativeFunction(at(RVA.fxEventInit), "pointer", eventArgs, opts),
            flags: new NativeFunction(at(RVA.objFlags), "int", ["pointer", "int", "int"], opts),
            place: new NativeFunction(at(RVA.objPlace), "uint8", ["pointer", "int"], opts),
            destroy: new NativeFunction(at(RVA.objDestroy), "void", ["pointer", "int", "int", "int", "int"], opts),
            // The event lives in our memory, one per call, kept for the
            // effect's life: whether the object holds on to it is not known.
            events: []
        };
    }
    return fxNative;
}

function fxType() {
    var id = typeIds()[FX_TYPE_NAME];
    if (id === undefined) {
        throw new Error("The game has no " + FX_TYPE_NAME + ".");
    }
    return id;
}

// Hands the start event to a fresh effect: owner and target are the object it
// follows (0 at a point), space the render-space vector (zero on an object).
function fxStart(ref, target, space, argb, preset) {
    var fns = fxFns();
    var effect = objectByRef(ref);
    if (effect === null) {
        throw new Error("The game made no effect.");
    }
    var ev = Memory.alloc(FX_EVENT_SIZE);
    fns.events.push(ev);
    if (fns.events.length > 256) {
        fns.events.shift();
    }
    fns.event(ev, FX_START, target, target, 0, 0, 0, 0,
              space[0], space[1], space[2], 0, 0, 0, argb >>> 0, preset, 0, 0);
    var handle = new NativeFunction(effect.readPointer().add(0x18).readPointer(), "void",
                                    ["pointer", "pointer"], { abi: "thiscall", exceptions: "propagate" });
    handle(effect, ev);
}

function fxInt(f, key, min, max) {
    var v = parseInt(f[key], 10);
    if (isNaN(v) || v < min || v > max) {
        throw new Error("Bad " + key + " " + f[key] + ".");
    }
    return v;
}

// Fields: preset 0..12; argb as a signed or unsigned 32-bit number; then ref,
// the object it follows, or x and y in world units.  Answers the effect's ref.
commandOnEngine("world.fx", function (f) {
    if (!live(heroFull) || isLoading()) {
        throw new Error("No world loaded.");
    }
    var preset = fxInt(f, "preset", 0, FX_PRESETS - 1);
    var argb = fxInt(f, "argb", -0x80000000, 0xFFFFFFFF);
    var onObject = f.ref !== undefined;
    var ref = onObject ? fxInt(f, "ref", 1, INT32_MAX) : 0;
    var x = onObject ? 0 : fxInt(f, "x", -INT32_MAX, INT32_MAX);
    var y = onObject ? 0 : fxInt(f, "y", -INT32_MAX, INT32_MAX);
    var creatureOnly = FX_CREATURE_PRESETS.indexOf(preset) >= 0;
    if (creatureOnly && !onObject) {
        throw new Error("Preset " + preset + " works only on a creature.");
    }
    var hero = heroFull;
    return function () {
        if (!same(hero, heroFull)) {
            throw new Error("The world changed before the effect was made.");
        }
        var fns = fxFns();
        var mgr = ptr(VA.objectManager).readPointer();
        var type = fxType();
        var pos = Memory.alloc(FX_POS_SIZE);
        if (onObject) {
            var anchor = objectByRef(ref);
            if (anchor === null) {
                throw new Error("No object " + ref + ".");
            }
            if (creatureOnly && creatureFields(ref) === null) {
                throw new Error("Preset " + preset + " works only on a creature.");
            }
            Memory.copy(pos, anchor.add(FX_POS), FX_POS_SIZE);
            var made = fns.create(mgr, type, pos, 0, 1, 0) >>> 0;
            if (made === 0) {
                throw new Error("The game made no effect.");
            }
            fxStart(made, ref, [0, 0, 0], argb, preset);
            return { ref: made };
        }
        // The hero's own position record with the new point, as Partikel
        // builds one: sector 0, the game looks it up again.
        Memory.copy(pos, hero.add(FX_POS), FX_POS_SIZE);
        pos.writeU16(0);
        pos.add(4).writeS32(x);
        pos.add(8).writeS32(y);
        fns.fix(mgr.readPointer(), pos);
        var placed = fns.create(mgr, type, pos, 0, 0, 0) >>> 0;
        var effect = placed === 0 ? null : objectByRef(placed);
        if (effect === null) {
            throw new Error("The game made no effect there.");
        }
        var inp = Memory.alloc(12);
        var out = Memory.alloc(12);
        inp.writeFloat(pos.add(4).readS32());
        inp.add(4).writeFloat(pos.add(8).readS32());
        inp.add(8).writeFloat(fns.height(effect, pos));
        fns.space(out, inp);
        fxStart(placed, 0, [out.readU32(), out.add(4).readU32(), out.add(8).readU32()], argb, preset);
        return { ref: placed };
    };
});

// Fields: ref of an effect this API made.  Removes it the way Partikel does
// (0x004A94DA), after checking the ref still holds a generic effect: once one
// fades, the game gives its ref to the next object it makes.
commandOnEngine("world.fx_remove", function (f) {
    if (!live(heroFull) || isLoading()) {
        throw new Error("No world loaded.");
    }
    var ref = fxInt(f, "ref", 1, INT32_MAX);
    return function () {
        var effect = objectByRef(ref);
        if (effect === null || !effect.readPointer().equals(ptr(VA.fxVtable)) ||
                (effect.add(FX_OBJECT_TYPE).readU32() >>> 0) !== fxType()) {
            return { removed: 0 };
        }
        var fns = fxFns();
        var mgr = ptr(VA.objectManager).readPointer();
        if (fns.flags(mgr, ref, FX_PLACED) === 0) {
            fns.place(mgr, ref);
            if (fns.flags(mgr, ref, FX_PLACED) === 0) {
                return { removed: 0 };
            }
        }
        fns.destroy(mgr, ref, 1, 0, 0);
        return { removed: 1 };
    };
});
