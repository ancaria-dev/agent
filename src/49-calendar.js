// The calendar: the world's date and time of day.
//
// cCalendar keeps year, month, day, hour, minute and second and advances them
// by real seconds times its scale, 24, so a game day lasts an hour.  While the
// hour is 7..19 it uses its day speed factor and otherwise its night factor,
// which is the only place the game itself divides day from night, so the same
// split is used here.
//
// Sampled on the tick.  A new hour is asked about and can be refused or moved;
// the hour that stands and the turn of day and night are then reported.

var CALENDAR_TIME = 0x18;
var CALENDAR_DAY_FIRST = 7;
var CALENDAR_DAY_LAST = 19;

function calendarObject() {
    if (!live(heroFull)) {
        return null;
    }
    var c = ptr(VA.calendar).readPointer();
    return c.isNull() ? null : c;
}

function calendarIsDay(hour) {
    return hour >= CALENDAR_DAY_FIRST && hour <= CALENDAR_DAY_LAST;
}

function calendarTime() {
    var c = calendarObject();
    if (c === null) {
        return null;
    }
    var t = c.add(CALENDAR_TIME);
    var hour = t.add(8).readU16();
    return {
        year: t.readU32(),
        month: t.add(4).readU16(),
        day: t.add(6).readU16(),
        hour: hour,
        minute: t.add(10).readU16(),
        second: t.add(12).readU16(),
        daytime: calendarIsDay(hour) ? 1 : 0,
        scale: c.add(0x0C).readFloat()
    };
}

command("world.time", function () {
    var t = calendarTime();
    if (t === null) {
        throw new Error("No world loaded.");
    }
    return t;
});

// Through the game's own setter, which takes the whole time by value: sixteen
// bytes, passed here as four dwords.  Engine thread only.
var calendarSetFn = null;
var calendarScaleFn = null;
// The hour the loader itself last set, so the sampler does not ask mods about
// a jump another mod asked for.
var calendarOwnHour = -1;

function calendarWrite(t) {
    var c = calendarObject();
    if (c === null) {
        return;
    }
    if (calendarSetFn === null) {
        calendarSetFn = new NativeFunction(at(RVA.calendarSet), "void",
                                           ["pointer", "uint32", "uint32", "uint32", "uint32"],
                                           { abi: "thiscall" });
    }
    calendarOwnHour = t.hour;
    calendarSetFn(c, t.year >>> 0, (t.month | (t.day << 16)) >>> 0,
                  (t.hour | (t.minute << 16)) >>> 0, t.second >>> 0);
}

function calendarField(f, key, now, low, high) {
    if (f[key] === undefined) {
        return now;
    }
    var v = parseInt(f[key], 10);
    if (isNaN(v) || v < low || v > high) {
        throw new Error(key + " must be " + low + ".." + high + ".");
    }
    return v;
}

// Fields left out keep their value.
command("world.time_set", function (f) {
    var now = calendarTime();
    if (now === null) {
        throw new Error("No world loaded.");
    }
    var t = {
        year: calendarField(f, "year", now.year, 0, 65535),
        month: calendarField(f, "month", now.month, 1, 12),
        day: calendarField(f, "day", now.day, 1, 31),
        hour: calendarField(f, "hour", now.hour, 0, 23),
        minute: calendarField(f, "minute", now.minute, 0, 59),
        second: calendarField(f, "second", now.second, 0, 59)
    };
    if (!later(function () { calendarWrite(t); })) {
        throw new Error("Too many game calls waiting.");
    }
    return t;
});

// Game seconds per real second, 24 as the game starts it.  0 stops the clock.
// The game's own setter writes it unchecked; the day and night factors it also
// has are clamped to 0.2..5 and cannot stop anything.
command("world.time_scale", function (f) {
    var scale = parseFloat(f.scale);
    if (isNaN(scale) || scale < 0 || scale > 3600) {
        throw new Error("The scale must be 0..3600.");
    }
    if (calendarObject() === null) {
        throw new Error("No world loaded.");
    }
    var queued = later(function () {
        var c = calendarObject();
        if (c === null) {
            return;
        }
        if (calendarScaleFn === null) {
            calendarScaleFn = new NativeFunction(at(RVA.calendarScale), "void",
                                                 ["pointer", "float"], { abi: "thiscall" });
        }
        calendarScaleFn(c, scale);
    });
    if (!queued) {
        throw new Error("Too many game calls waiting.");
    }
    return { scale: scale };
});

var calendarLast = null;

// A new hour is asked about on the frame that sees it, on the engine thread.  A
// veto sends the clock back to the start of the hour that ended, so that hour
// runs again; a change sends it to the start of the hour the mod chose.  A
// jump the loader made itself is only reported.
onSample(SAMPLE_FREQUENT, ["world.hour_change", "world.hour", "world.daytime"], function () {
    if (isLoading()) {
        calendarLast = null;
        return;
    }
    var t;
    try {
        t = calendarTime();
    } catch (e) {
        return;
    }
    if (t === null) {
        calendarLast = null;
        return;
    }
    var before = calendarLast;
    calendarLast = t;
    // The first reading after a load is where the clock already stood.
    if (before === null || before.hour === t.hour) {
        return;
    }
    if (t.hour !== calendarOwnHour) {
        var verdict = ask("world.hour_change", { hour: t.hour, prev: before.hour, day: t.day,
                                                 daytime: t.daytime });
        var wanted = asked(verdict, "hour", t.hour);
        if (verdict.cancel) {
            calendarWrite({ year: before.year, month: before.month, day: before.day,
                            hour: before.hour, minute: 0, second: 0 });
            calendarLast = before;
            return;
        }
        if (wanted !== t.hour && wanted >= 0 && wanted <= 23) {
            calendarWrite({ year: t.year, month: t.month, day: t.day,
                            hour: wanted, minute: 0, second: 0 });
            t = calendarTime();
            calendarLast = t;
        }
    }
    calendarOwnHour = -1;
    evt("world.hour", { hour: t.hour, prev: before.hour, day: t.day, daytime: t.daytime });
    if (calendarIsDay(before.hour) !== calendarIsDay(t.hour)) {
        evt("world.daytime", { daytime: t.daytime, hour: t.hour });
    }
});

onHero(function () {
    calendarLast = null;
});
