// Weather: rain, fog and snow, read from the game's weather object and changed
// the way the game changes it.
//
// showWorld decides the weather on timers and tells cWeather through a message
// (cEventWeather: +8 what, +0x0C how much, 0..100).  cWeather stores a target
// per kind and a flag bit, and its tick moves the visible strength toward the
// target.  A stop only zeroes the target; the bit stays until the weather has
// faded.  So "it is raining" here means the game has decided on rain, the
// moment it prints RainStart, and the strengths say how much is visible.
//
// Nothing is hooked.  The object is sampled on the tick, a change is asked
// about and then reported; showWorld's print sites sit mid-function.

var WEATHER_FLAGS = 0x10;
var WEATHER_KINDS = {
    // subtype, flag bit, strength now, target, target per unit of value
    rain: { what: 2, bit: 0x01, now: 0x1C, target: 0x20, unit: 30 },
    fog: { what: 3, bit: 0x02, now: 0x17C, target: 0x178, unit: 2 },
    snow: { what: 5, bit: 0x10, now: 0x9154, target: 0x9158, unit: 30 }
};
var WEATHER_EVENT_SIZE = 0x1C;

function weatherObject() {
    if (!live(heroFull)) {
        return null;
    }
    var w = ptr(VA.weather).readPointer();
    return w.isNull() ? null : w;
}

function weatherPercent(value, unit) {
    var p = Math.round(value / unit);
    return p < 0 ? 0 : (p > 100 ? 100 : p);
}

// Flat fields: rain, fog, snow as 0/1, and <kind>Now / <kind>Target as 0..100.
function weatherState() {
    var w = weatherObject();
    if (w === null) {
        return null;
    }
    var out = {};
    for (var kind in WEATHER_KINDS) {
        var k = WEATHER_KINDS[kind];
        var target = w.add(k.target).readS32();
        out[kind] = target > 0 ? 1 : 0;
        out[kind + "Now"] = weatherPercent(w.add(k.now).readS32(), k.unit);
        out[kind + "Target"] = weatherPercent(target, k.unit);
    }
    return out;
}

command("world.weather", function () {
    var state = weatherState();
    if (state === null) {
        throw new Error("No world loaded.");
    }
    return state;
});

// The same message showWorld sends, built in our own memory and handed to the
// game's handler on the engine thread.  The game's own timers keep running, so
// the weather it picks next replaces this one.
var weatherNative = null;

function weatherSend(what, value) {
    if (weatherNative === null) {
        weatherNative = {
            receive: new NativeFunction(at(RVA.weatherEvent), "void",
                                        ["pointer", "pointer"], { abi: "thiscall" }),
            message: Memory.alloc(WEATHER_EVENT_SIZE)
        };
    }
    var w = weatherObject();
    if (w === null) {
        return;
    }
    var m = weatherNative.message;
    for (var i = 0; i < WEATHER_EVENT_SIZE; i += 4) {
        m.add(i).writeU32(0);
    }
    m.writePointer(ptr(VA.weatherEventVtable));
    m.add(8).writeU32(what);
    m.add(0x0C).writeU32(value);
    weatherNative.receive(w, m);
}

command("world.weather_set", function (f) {
    var k = WEATHER_KINDS[f.kind];
    if (k === undefined) {
        throw new Error("Unknown weather " + f.kind + ". Use rain, fog or snow.");
    }
    var value = parseInt(f.value, 10);
    if (isNaN(value)) {
        throw new Error("No strength given.");
    }
    value = value < 0 ? 0 : (value > 100 ? 100 : value);
    if (weatherObject() === null) {
        throw new Error("No world loaded.");
    }
    if (!later(function () {
        var state = weatherState();
        var on = value > 0 ? 1 : 0;
        if (state !== null && state[f.kind] !== on) {
            weatherOwn[f.kind] = on;
        }
        weatherSend(k.what, value);
    })) {
        throw new Error("Too many game calls waiting.");
    }
    return { kind: f.kind, value: value };
});

var weatherLast = null;
// Kinds the loader itself just switched, so mods are not asked about a change
// another mod asked for.
var weatherOwn = {};

// A turn of rain, fog or snow is asked about on the frame that sees it, on
// the engine thread, one frame after showWorld decided it.  A veto sends the
// game the opposite message at once: back to the strength it had, or to none,
// so the refused weather may show for that frame.  The weather that stands is
// then reported.
onSample(SAMPLE_FREQUENT, ["weather.change", "weather.changed"], function () {
    if (isLoading()) {
        weatherLast = null;
        return;
    }
    var now;
    try {
        now = weatherState();
    } catch (e) {
        return;
    }
    if (now === null) {
        weatherLast = null;
        return;
    }
    var before = weatherLast;
    weatherLast = now;
    // The first reading after a load is how the world already was.
    if (before === null) {
        return;
    }
    var changed = false;
    for (var kind in WEATHER_KINDS) {
        if (now[kind] === before[kind]) {
            continue;
        }
        if (weatherOwn[kind] !== now[kind]) {
            var verdict = ask("weather.change", { kind: kind, on: now[kind],
                                                  target: now[kind + "Target"] });
            if (verdict.cancel) {
                weatherSend(WEATHER_KINDS[kind].what, now[kind] ? 0 : before[kind + "Target"]);
                now[kind] = before[kind];
                continue;
            }
        }
        delete weatherOwn[kind];
        changed = true;
    }
    if (changed) {
        evt("weather.changed", {
            rain: now.rain, fog: now.fog, snow: now.snow,
            wasRain: before.rain, wasFog: before.fog, wasSnow: before.snow
        });
    }
});

onHero(function () {
    weatherLast = null;
});
