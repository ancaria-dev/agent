// The wire to the host.  Two directions:
//   evt(...)  fire-and-forget, never blocks the game thread.
//   ask(...)  blocks until the host answers with a verdict.
//
// The payload field names (type/id/result/returns) are not ours.  They are
// what frida-rust's SendPayload deserializes.  Keeping that shape avoids a
// fallback parse path on the host side.

var seqCounter = 1;
var verdicts = {};
var askEnabled = true;
// What each side is doing, for the fault report in 10-core.js: the command
// Frida's thread is running and the ask the game thread is parked in.
var commandInFlight = null;
var askInFlight = null;
var commandThread = 0;

function evt(name, fields) {
    send({ type: "evt", id: 0, result: name, returns: fields || {} });
}

function note(text) {
    send({ type: "log", id: 0, result: text, returns: {} });
}

// Returns { cancel: bool, set: {...} }.  The host always answers.  It applies
// its own deadline and replies on the mod's behalf if Coderpack is slow or gone, so
// this loop cannot hang the game as long as the host is alive.
function ask(name, fields) {
    if (!askEnabled) {
        return { cancel: false, set: {} };
    }
    // Never stop the game thread while it is loading.  The mod still sees the
    // event, it just cannot answer it, which is the right trade: nobody wants
    // to multiply a character's starting gold anyway.
    if (isLoading()) {
        evt(name, fields || {});
        return { cancel: false, set: {} };
    }
    var seq = seqCounter++;
    askInFlight = name + " on thread " + Process.getCurrentThreadId();
    send({ type: "ask", id: seq, result: name, returns: fields || {} });
    while (verdicts[seq] === undefined) {
        var op = recv("verdict", function (msg) {
            verdicts[msg.seq] = msg;
        });
        op.wait();
    }
    askInFlight = null;
    var verdict = verdicts[seq];
    delete verdicts[seq];
    return { cancel: verdict.cancel === true, set: verdict.set || {} };
}

// A loading stage.  The game thread waits here while the loader starts the
// mods of that stage: each has one second, and the loader kicks out a mod
// still running at two, so the host answers within about two seconds per
// point and on the loader's behalf after five.  Not an ask: nothing is
// decided, and isLoading() does not apply, because the game is loading on
// purpose here.  With the JVM gone (asking off) it returns at once.
var stageAnswers = {};
// Threads parked in a stage right now.  While one is, there is no tick, so
// work queued for the tick would wait for nothing: commandLater and
// commandOnEngine refuse it instead.
var stageHold = 0;
// Where the loading screen's text lives during the current stage, if the game
// draws one: { at, size, saved }.  The host sends the mods' names for it.
var stageLabel = null;

function stage(point, fields, label, labelSize) {
    if (!askEnabled) {
        return;
    }
    var seq = seqCounter++;
    stageHold += 1;
    if (label) {
        try {
            stageLabel = { at: label, size: labelSize, saved: label.readByteArray(labelSize) };
        } catch (e) {
            stageLabel = null;
        }
    }
    try {
        send({ type: "stage", id: seq, result: point, returns: d12StageFields(fields || {}, true) });
        while (stageAnswers[seq] === undefined) {
            var op = recv("stage", function (msg) {
                stageAnswers[msg.seq] = true;
            });
            op.wait();
        }
        delete stageAnswers[seq];
    } finally {
        stageHold -= 1;
        if (stageLabel !== null) {
            try {
                stageLabel.at.writeByteArray(stageLabel.saved);
            } catch (e) {}
            stageLabel = null;
        }
    }
}

// A stage nothing waits for: PostWorld, the world gone, a late attach.
function stageNotice(point, fields) {
    if (askEnabled) {
        send({ type: "stage", id: 0, result: point, returns: d12StageFields(fields || {}, false) });
    }
}

// The loading screen's text while a stage holds the game: plain ASCII, cut to
// the game's buffer, NUL-terminated.  The game draws it on its own thread.
function armLabel() {
    recv("label", function (msg) {
        var target = stageLabel;
        if (target !== null) {
            var text = String(msg.text || "").replace(/[^\x20-\x7E]/g, "?");
            if (text.length === 0) {
                target.at.writeByteArray(target.saved);
            } else {
                target.at.writeAnsiString(text.substring(0, target.size - 1));
            }
        }
        armLabel();
    });
}

// Verdict helper: an integer the mod may have rewritten, clamped to int32.
function asked(verdict, key, fallback) {
    var raw = verdict.set[key];
    if (raw === undefined) {
        return fallback;
    }
    var value = parseInt(raw, 10);
    if (isNaN(value)) {
        return fallback;
    }
    return value > INT32_MAX ? INT32_MAX : value;
}

// Commands travel the other way: Coderpack asks the game to do something.  recv() is
// one-shot, so the handler re-arms itself.
var commands = {};

function command(name, fn) {
    commands[name] = fn;
}

// A command whose answer comes from the engine thread, for a caller that
// needs what a game call returned: the ref of a creature the game just made.
// `prepare` runs at once on Frida's thread, checks the fields and throws what
// is wrong with them, and returns the work.  The work runs on a later tick
// through later(), and what it returns, or the error it throws, is the reply.
// Frida's thread never waits for the tick: the reply simply leaves later,
// and the host routes it by its sequence number like any other.  Coderpack
// waits two seconds for it; a reply that comes after that is dropped there,
// and nothing runs while a world loads.
var COMMAND_LATER = {};

function commandLater(name, prepare) {
    commands[name] = function (f, seq) {
        if (stageHold > 0) {
            throw new Error("Not available while the game loads.");
        }
        var work = prepare(f);
        if (!later(function () {
            var out;
            try {
                out = work() || {};
            } catch (e) {
                out = { err: e.message };
            }
            reply(seq, name, out);
        })) {
            throw new Error("Too many game calls waiting.");
        }
        return COMMAND_LATER;
    };
}

// The same, for work the game does only on its engine thread, the one that
// handles the player's keys and clicks: moving a window, a message to a chest.
// cUI_Manager::handleEsc logs when another thread calls it.  The tick runs on
// more than one thread, so these jobs wait in their own queue until the tick
// runs on the thread the engine names at VA.engineThread.
var ENGINE_JOBS_MAX = 8;
var engineJobs = [];

function commandOnEngine(name, prepare) {
    commands[name] = function (f, seq) {
        if (stageHold > 0) {
            throw new Error("Not available while the game loads.");
        }
        var work = prepare(f);
        if (engineJobs.length >= ENGINE_JOBS_MAX) {
            throw new Error("Too many game calls waiting.");
        }
        engineJobs.push({ seq: seq, name: name, work: work });
        return COMMAND_LATER;
    };
}

onTick(function () {
    if (engineJobs.length === 0 || isLoading() ||
            Process.getCurrentThreadId() !== ptr(VA.engineThread).readU32()) {
        return;
    }
    var job = engineJobs.shift();
    var out;
    try {
        out = job.work() || {};
    } catch (e) {
        out = { err: e.message };
    }
    reply(job.seq, job.name, out);
});

function reply(seq, name, out) {
    if (out.err === undefined) {
        out.ok = true;
    }
    send({ type: "res", id: seq, result: name, returns: out });
}

function armCommands() {
    recv("cmd", function (msg) {
        // Flat, because the wire is flat.  This used to send { ok, f: {...} }
        // and the host's flatten() turned the inner object into one field
        // holding JSON, so every command answered `ok=1 f={"gold":104233}`
        // and Coderpack's .get("gold") was null.  Nothing failed loudly: the callers
        // all had a fallback, so uiString() simply always returned null.
        var out;
        commandThread = Process.getCurrentThreadId();
        commandInFlight = msg.name;
        try {
            var fn = commands[msg.name];
            out = (fn === undefined)
                ? { err: "unknown command: " + msg.name }
                : (fn(msg.f || {}, msg.seq) || {});
        } catch (e) {
            out = { err: e.message };
        }
        commandInFlight = null;
        if (out !== COMMAND_LATER) {
            reply(msg.seq, msg.name, out);
        }
        armCommands();
    });
}

// The host disarms asking when Coderpack dies, so a lost JVM degrades to
// observation instead of blocking the game on a verdict nobody will send.
function armMode() {
    recv("mode", function (msg) {
        askEnabled = msg.ask !== false;
        armMode();
    });
}

armMode();
armCommands();
armLabel();
