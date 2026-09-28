// Gravestones.  A grave is no object: it is a script spot (see 47-places.js)
// whose script, setvar_<n>, sets two script variables and asks the player,
// all traced live on the user's graves (see the scriptWork row):
//
//   GNr   the grave's number, the key of its state: the variable
//         grabstein_dialog_<GNr> turns 1 once it is open, and a save keeps it;
//   GTO   what it holds, known before it opens: 1..4 only a text, 5 an item
//         beside the hero, 6 the grave's own script grab_<GNr>, which makes
//         creatures or an item.
//
// The answer "open" runs grab_ok, which reads both, marks the grave and makes
// what it holds.  The Underworld's graves do the same with GNr_uw, GTO_uw,
// grabstein_dialog_uw_<n> and grab_ok_uw.
//
//   world.graves       every grave of the world, packed
//   world.grave_open   a grave, opened the way the answer "open" does
//   grave.open         asked before grab_ok runs; a veto keeps it closed
//   grave.opened       event: a grave opened, with what came out
//
// The game keeps a script's code in FunkCode.bin, not in memory, and reads it
// on every call.  GNr and GTO are read from there the same way, once a world,
// on the engine thread that runs the scripts.

var GRAVE_FUNC_SIZE = 0x54;
var GRAVE_FUNC_OFFSET = 0x40;
var GRAVE_FUNC_LENGTH = 0x44;
var GRAVE_VAR_SIZE = 0x24;
var GRAVE_VAR_VALUE = 0x20;
var GRAVE_SCRIPT = /^setvar_/;
var GRAVE_OK = "grab_ok";
var GRAVE_OK_UW = "grab_ok_uw";
var GRAVE_CODE_MAX = 256;
var GRAVE_CLUSTER = 4;                  // grid tiles: one gravestone's records lie this close
var GRAVE_SEEK_SET = 0;
var GRAVE_SET = 0x43;                   // 'C': a variable set, as the file spells it
var GRAVE_INT = 0x0B;
var graveNative = null;
var graveCodes = null;                  // script -> { number, uw, outcome } or null, per world
var graveIndex = null;                  // function name -> index, for grab_ok, per world

function graveNatives() {
    if (graveNative === null) {
        var c = { abi: "mscdecl", exceptions: "propagate" };
        graveNative = {
            tell: new NativeFunction(at(RVA.crtTell), "int32", ["pointer"], c),
            seek: new NativeFunction(at(RVA.crtSeek), "int", ["pointer", "int32", "int"], c),
            read: new NativeFunction(at(RVA.crtRead), "uint32", ["pointer", "uint32", "uint32", "pointer"], c),
            work: new NativeFunction(at(RVA.scriptWork), "uint8", ["int", "pointer", "int"], c),
            addVar: new NativeFunction(at(RVA.scriptVarAdd), "void", ["pointer", "int"],
                                       { abi: "stdcall", exceptions: "propagate" })
        };
    }
    return graveNative;
}

onHero(function () {
    graveCodes = null;
    graveIndex = null;
});

function graveFuncs() {
    var begin = ptr(VA.scriptFuncs).readPointer();
    var end = ptr(VA.scriptFuncs).add(4).readPointer();
    if (begin.isNull()) {
        return { begin: begin, count: 0 };
    }
    return { begin: begin, count: Math.floor(end.sub(begin).toInt32() / GRAVE_FUNC_SIZE) };
}

// The name of the script function at an index, or null.
function graveFuncName(index) {
    var funcs = graveFuncs();
    if (index <= 0 || index >= funcs.count) {
        return null;
    }
    return funcs.begin.add(index * GRAVE_FUNC_SIZE).readCString();
}

// Every grave script and grab_ok by name, walking the table once a world: it
// holds about 23000 functions, and only names starting "setv" or "grab" are
// read in full.
function graveFunctions() {
    if (graveIndex !== null) {
        return graveIndex;
    }
    var funcs = graveFuncs();
    var found = {};
    for (var i = 1; i < funcs.count; i++) {
        var r = funcs.begin.add(i * GRAVE_FUNC_SIZE);
        var head = r.readU32();
        if (head !== 0x76746573 && head !== 0x62617267) {    // "setv", "grab"
            continue;
        }
        var name = r.readCString();
        if (GRAVE_SCRIPT.test(name) || name === GRAVE_OK || name === GRAVE_OK_UW) {
            found[name] = { index: i, offset: r.add(GRAVE_FUNC_OFFSET).readU32(),
                            length: r.add(GRAVE_FUNC_LENGTH).readU32() };
        }
    }
    graveIndex = found;
    return found;
}

// A script's code, read from the game's own stream the way the interpreter
// does, and the stream put back where it was.  Engine thread only.
function graveCode(fn) {
    var file = ptr(VA.scriptFile).readPointer();
    if (file.isNull() || fn.length === 0 || fn.length > GRAVE_CODE_MAX) {
        return null;
    }
    var n = graveNatives();
    var buf = Memory.alloc(fn.length);
    var pos = n.tell(file);
    try {
        if (n.seek(file, fn.offset, GRAVE_SEEK_SET) !== 0) {
            return null;
        }
        var got = n.read(buf, 1, fn.length, file);
        return new Uint8Array(buf.readByteArray(got));
    } finally {
        n.seek(file, pos, GRAVE_SEEK_SET);
    }
}

// The int32 a script's code sets a variable to: 'C' 00 len 00 01 name 00 0B
// value, or null when it does not.
function graveSetIn(code, name) {
    for (var i = 0; i + name.length + 11 <= code.length; i++) {
        if (code[i] !== GRAVE_SET || code[i + 4] !== 1) {
            continue;
        }
        var match = true;
        for (var k = 0; k < name.length && match; k++) {
            match = code[i + 5 + k] === name.charCodeAt(k);
        }
        var tail = i + 5 + name.length;
        if (!match || code[tail] !== 0 || code[tail + 1] !== GRAVE_INT) {
            continue;
        }
        return (code[tail + 2] | (code[tail + 3] << 8) | (code[tail + 4] << 16) | (code[tail + 5] << 24));
    }
    return null;
}

// What the grave scripts set, once a world.  A setvar_ script without a GNr
// (a few only show a text) is no grave the game keeps a state for.
function graveScripts() {
    if (graveCodes !== null) {
        return graveCodes;
    }
    var fns = graveFunctions();
    var out = {};
    for (var name in fns) {
        if (!GRAVE_SCRIPT.test(name)) {
            continue;
        }
        var code = graveCode(fns[name]);
        var grave = null;
        if (code !== null) {
            var number = graveSetIn(code, "GNr");
            var uw = false;
            if (number === null) {
                number = graveSetIn(code, "GNr_uw");
                uw = true;
            }
            if (number !== null) {
                var outcome = graveSetIn(code, uw ? "GTO_uw" : "GTO");
                grave = { number: number, uw: uw, outcome: outcome === null ? 0 : outcome };
            }
        }
        out[name] = grave;
    }
    graveCodes = out;
    return out;
}

// The script variables, by name.
function graveVars() {
    var begin = ptr(VA.scriptVars).readPointer();
    var end = ptr(VA.scriptVars).add(4).readPointer();
    var out = {};
    if (begin.isNull()) {
        return out;
    }
    var count = Math.floor(end.sub(begin).toInt32() / GRAVE_VAR_SIZE);
    for (var i = 0; i < count; i++) {
        var r = begin.add(i * GRAVE_VAR_SIZE);
        out[r.readCString()] = r.add(GRAVE_VAR_VALUE);
    }
    return out;
}

function graveStateName(number, uw) {
    return (uw ? "grabstein_dialog_uw_" : "grabstein_dialog_") + number;
}

// A missing variable is a grave nobody opened: the game makes it on first use.
function graveOpened(vars, number, uw) {
    var v = vars[graveStateName(number, uw)];
    return v !== undefined && v.readS32() === 1;
}

// The spots of the grave scripts, gathered into gravestones: a stone covers
// two to six neighbouring tiles, and a few scripts serve two stones far apart
// that share one state.
function graveStones() {
    var records = spotRecords();
    var byScript = {};
    for (var i = 0; i < records.count; i++) {
        var s = spotAt(records, i);
        if (!GRAVE_SCRIPT.test(s.name)) {
            continue;
        }
        var stones = byScript[s.name] || (byScript[s.name] = []);
        var stone = null;
        for (var k = 0; k < stones.length && stone === null; k++) {
            if (Math.abs(stones[k].gx - s.gx) <= GRAVE_CLUSTER &&
                    Math.abs(stones[k].gy - s.gy) <= GRAVE_CLUSTER) {
                stone = stones[k];
            }
        }
        if (stone === null) {
            stones.push({ script: s.name, gx: s.gx, gy: s.gy, sx: s.gx, sy: s.gy, n: 1 });
        } else {
            stone.sx += s.gx;
            stone.sy += s.gy;
            stone.n += 1;
        }
    }
    var out = [];
    for (var name in byScript) {
        byScript[name].forEach(function (stone) {
            stone.x = Math.trunc((stone.sx / stone.n + 0.5) * SPOT_SCALE);
            stone.y = Math.trunc((stone.sy / stone.n + 0.5) * SPOT_SCALE);
            out.push(stone);
        });
    }
    return out;
}

// Every grave with its state, as script, number, place and what it holds.
function graveList() {
    var scripts = graveScripts();
    var vars = graveVars();
    var out = [];
    graveStones().forEach(function (stone) {
        var g = scripts[stone.script];
        if (!g) {
            return;
        }
        out.push({
            script: stone.script, number: g.number, uw: g.uw ? 1 : 0,
            gx: stone.gx, gy: stone.gy, x: stone.x, y: stone.y,
            opened: graveOpened(vars, g.number, g.uw) ? 1 : 0, outcome: g.outcome
        });
    });
    return out;
}

function gravePack(g) {
    return [g.script, g.number, g.uw, g.gx, g.gy, g.x, g.y, g.opened, g.outcome].join(":");
}

commandOnEngine("world.graves", function () {
    if (!live(heroFull) || isLoading()) {
        throw new Error("No world loaded.");
    }
    return function () {
        return { graves: graveList().map(gravePack).join(";") };
    };
});

// What a grave let out, from the refs made while grab_ok ran: creatures as
// ref:type:level:hp:maxHp:x:y:cclass:NAME and items as ref:type:NAME, each
// joined by ";", effects left out.  Only items lying in the world: a creature
// comes with the weapon it holds (live: grave 21's skeleton made a dagger that
// never lay on the ground).
function graveContents(made) {
    var creatures = [];
    made.forEach(function (ref) {
        var c = creatureFields(ref);
        if (c !== null) {
            creatures.push([c.ref, c.type, c.level, c.hp, c.maxHp, c.x, c.y, c.cclass, c.name].join(":"));
        }
    });
    return { creatures: creatures.join(";"), items: spotItems(made).join(";") };
}

// The grave grab_ok is about to open: the stone of the script whose GNr is
// set that lies nearest the hero, who clicked it.
function graveNow(uw) {
    var vars = graveVars();
    var nr = vars[uw ? "GNr_uw" : "GNr"];
    var gto = vars[uw ? "GTO_uw" : "GTO"];
    if (nr === undefined) {
        return null;
    }
    var number = nr.readS32();
    var fields = {
        script: "", number: number, uw: uw ? 1 : 0, gx: 0, gy: 0, x: 0, y: 0,
        outcome: gto === undefined ? 0 : gto.readS32()
    };
    // The scripts are read on the engine thread, the one grab_ok runs on.
    if (graveCodes === null && Process.getCurrentThreadId() === ptr(VA.engineThread).readU32()) {
        graveScripts();
    }
    if (graveCodes !== null && live(heroFull)) {
        var hx = heroFull.add(0x1C).readS32();
        var hy = heroFull.add(0x20).readS32();
        var best = -1;
        graveStones().forEach(function (stone) {
            var g = graveCodes[stone.script];
            if (!g || g.number !== number || g.uw !== uw) {
                return;
            }
            var d = Math.pow(stone.x - hx, 2) + Math.pow(stone.y - hy, 2);
            if (best < 0 || d < best) {
                best = d;
                fields.script = stone.script;
                fields.gx = stone.gx;
                fields.gy = stone.gy;
                fields.x = stone.x;
                fields.y = stone.y;
            }
        });
    }
    return fields;
}

// The player's answer "open": grab_ok is asked about on entry, and a veto
// turns its index into 0, which the runner refuses at once, so the grave is
// neither marked nor emptied.  grab_ok shows dialogs and makes creatures, a
// call the game may leave by an exception, so it is tracked with callOpen
// rather than onLeave; what objCreate makes deeper in its stack is what the
// grave let out.  Switched with objCreate, off while a world loads.  grab_ok
// runs the grave's own script from inside, a nested call this hook lets pass.
var GRAVE_SWEEP_MS = 50;
var graveCalls = [];

spawnFollowers.push(switchable("scriptWork", RVA.scriptWork, {
    onEnter: function (args) {
        var name;
        try {
            name = graveFuncName(args[0].toInt32());
        } catch (e) {
            return;
        }
        if (name !== GRAVE_OK && name !== GRAVE_OK_UW) {
            return;
        }
        var fields;
        try {
            fields = graveNow(name === GRAVE_OK_UW);
        } catch (e) {
            fields = null;
        }
        if (fields === null) {
            return;
        }
        if (ask("grave.open", fields).cancel) {
            args[0] = ptr(0);
            return;
        }
        callOpen(graveCalls, this.context, { fields: fields, made: [] });
    }
}));

createWatchers.push(function (ref, ctx) {
    var tid = Process.getCurrentThreadId();
    for (var i = 0; i < graveCalls.length; i++) {
        var call = graveCalls[i];
        if (call.tid === tid && call.at.compare(ctx.esp) > 0 && callRunning(call)) {
            call.data.made.push(ref);
        }
    }
});

setInterval(function () {
    callSweep(graveCalls, function (open) {
        var out = graveContents(open.made);
        open.fields.creatures = out.creatures;
        open.fields.items = out.items;
        evt("grave.opened", open.fields);
    });
}, GRAVE_SWEEP_MS);

// Sets a script variable, adding it the way the game's own variable sync does
// when it does not exist yet.
function graveSetVar(name, value) {
    var v = graveVars()[name];
    if (v !== undefined) {
        v.writeS32(value);
        return;
    }
    var rec = Memory.alloc(GRAVE_VAR_SIZE);
    for (var i = 0; i < GRAVE_VAR_SIZE; i += 4) {
        rec.add(i).writeU32(0);
    }
    rec.writeAnsiString(name);
    rec.add(GRAVE_VAR_VALUE).writeS32(value);
    graveNatives().addVar(rec, 0);
}

// Opening a grave the way the answer "open" does: the grave's GNr and GTO, as
// its own script sets them on the click, then grab_ok.  The question is not
// shown; the text an outcome of 1..4 shows is, as it is after the player's
// answer.  The scriptWork hook does not see a call made from the tick, so its
// event is sent here.
commandOnEngine("world.grave_open", function (f) {
    var script = f.script;
    if (typeof script !== "string" || !GRAVE_SCRIPT.test(script)) {
        throw new Error("world.grave_open needs a grave's script, such as setvar_012.");
    }
    if (!live(heroFull) || isLoading()) {
        throw new Error("No world loaded.");
    }
    return function () {
        var g = graveScripts()[script];
        if (!g) {
            throw new Error("No grave runs " + script + ".");
        }
        if (graveOpened(graveVars(), g.number, g.uw)) {
            throw new Error("The grave of " + script + " is already open.");
        }
        var ok = graveFunctions()[g.uw ? GRAVE_OK_UW : GRAVE_OK];
        if (ok === undefined) {
            throw new Error("This world has no " + (g.uw ? GRAVE_OK_UW : GRAVE_OK) + ".");
        }
        var stone = null;
        graveStones().forEach(function (s) {
            if (s.script === script && stone === null) {
                stone = s;
            }
        });
        graveSetVar(g.uw ? "GNr_uw" : "GNr", g.number);
        graveSetVar(g.uw ? "GTO_uw" : "GTO", g.outcome);
        var before = spotObjectTable();
        graveNatives().work(ok.index, ptr(0), 0);
        var after = spotObjectTable();
        var made = [];
        for (var i = 0; i < after.length; i++) {
            if (after[i] !== 0 && (i >= before.length || after[i] !== before[i])) {
                made.push(i);
            }
        }
        var fields = {
            script: script, number: g.number, uw: g.uw ? 1 : 0,
            gx: stone === null ? 0 : stone.gx, gy: stone === null ? 0 : stone.gy,
            x: stone === null ? 0 : stone.x, y: stone === null ? 0 : stone.y,
            outcome: g.outcome
        };
        var out = graveContents(made);
        fields.creatures = out.creatures;
        fields.items = out.items;
        evt("grave.opened", fields);
        fields.opened = graveOpened(graveVars(), g.number, g.uw) ? 1 : 0;
        return fields;
    };
});
