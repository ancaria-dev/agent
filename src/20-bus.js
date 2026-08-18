// The wire to the host.  Two directions:
//   evt(...)  fire-and-forget, never blocks the game thread;
//   ask(...)  blocks until the host answers with a verdict.
//
// The payload field names (type/id/result/returns) are not ours -- they are
// what frida-rust's SendPayload deserializes.  Keeping that shape avoids a
// fallback parse path on the host side.

var seqCounter = 1;
var verdicts = {};
var askEnabled = true;

function evt(name, fields) {
    send({ type: "evt", id: 0, result: name, returns: fields || {} });
}

function note(text) {
    send({ type: "log", id: 0, result: text, returns: {} });
}

// Returns { cancel: bool, set: {...} }.  The host always answers -- it applies
// its own deadline and replies on the mod's behalf if Coderpack is slow or gone, so
// this loop cannot hang the game as long as the host is alive.
function ask(name, fields) {
    if (!askEnabled) {
        return { cancel: false, set: {} };
    }
    // Never stop the game thread while it is loading.  The mod still sees the
    // event, it just cannot answer it -- which is the right trade: nobody wants
    // to multiply a character's starting gold anyway.
    if (isLoading()) {
        evt(name, fields || {});
        return { cancel: false, set: {} };
    }
    var seq = seqCounter++;
    send({ type: "ask", id: seq, result: name, returns: fields || {} });
    while (verdicts[seq] === undefined) {
        var op = recv("verdict", function (msg) {
            verdicts[msg.seq] = msg;
        });
        op.wait();
    }
    var verdict = verdicts[seq];
    delete verdicts[seq];
    return { cancel: verdict.cancel === true, set: verdict.set || {} };
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

function armCommands() {
    recv("cmd", function (msg) {
        // Flat, because the wire is flat.  This used to send { ok, f: {...} }
        // and the host's flatten() turned the inner object into one field
        // holding JSON -- so every command answered `ok=1 f={"gold":104233}`
        // and Coderpack's .get("gold") was null.  Nothing failed loudly: the callers
        // all had a fallback, so uiString() simply always returned null.
        var out;
        try {
            var fn = commands[msg.name];
            out = (fn === undefined)
                ? { err: "unknown command: " + msg.name }
                : (fn(msg.f || {}) || {});
        } catch (e) {
            out = { err: e.message };
        }
        if (out.err === undefined) {
            out.ok = true;
        }
        send({ type: "res", id: msg.seq, result: msg.name, returns: out });
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
