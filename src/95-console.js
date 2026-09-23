// The in-game console.  cEngine::console takes the whole typed line, narrow
// ANSI, and returns whether it handled it; on false its caller prints "Error!
// Try HELP for help...".  One call per line entered, so it is safe to ask on.
//
// A mod that vetoes the line takes it: the game is handed an empty line, which
// its tokenizer treats as nothing, and the return is forced to true so no
// error follows.  Everything else reaches the game's own commands untouched.

var consoleNothing = null;
var consoleThread = null;

hook("console", RVA.console, {
    onEnter: function (args) {
        consoleThread = Process.getCurrentThreadId();
        this.claimed = false;
        var line;
        try {
            line = args[0].readAnsiString();
        } catch (e) {
            return;
        }
        if (!line) {
            return;
        }
        var verdict = ask("console.line", { text: line });
        if (verdict.cancel) {
            if (consoleNothing === null) {
                consoleNothing = Memory.alloc(4);   // zeroed: an empty string
            }
            args[0] = consoleNothing;
            this.claimed = true;
        }
    },
    onLeave: function (retval) {
        if (this.claimed) {
            retval.replace(ptr(1));
        }
    }
});

// Printing into it.  The game has no print function: every line it puts there,
// HELP's list and the "Error!" reply included, is a text event (id 0x26, to the
// window "UI_WND_CONSOLE") that cKernel::receive_event delivers at once to the
// console window.  Coderpack builds the same event with the game's own
// constructor, sends it with the same (1, 0) and destroys it the same way.
//
// Never from the command handler itself.  Commands run on Frida's thread, and
// nothing on the send path takes a lock: the kernel walks its handler list, the
// console window its lines, and the constructor and destructor go through the
// game's allocator.  So the command only queues the text and the tick sends it,
// which puts it on the engine thread: cEngine::renderThread calls getLocalHero
// in its own loop.  Once a line has been typed, the flush is also pinned to the
// thread that ran cEngine::console, the one the game prints HELP from.  Sending
// from inside whatever function asked for the hero is what the game does
// itself: the kill log sends its console event from the middle of the kill.

var CONSOLE_EVENT = 0x26;
var CONSOLE_EVENT_SIZE = 0x174;
var CONSOLE_TEXT_MAX = 255;     // copied unbounded to +0x74, 256 bytes to the end
var CONSOLE_QUEUE_MAX = 64;
var CONSOLE_FLUSH_MAX = 8;      // per tick, so a burst of prints cannot stall a frame

var consoleQueue = [];
var consoleNative = null;

function consoleNatives() {
    if (consoleNative === null) {
        consoleNative = {
            build: new NativeFunction(at(RVA.consolePrint), "pointer",
                                      ["pointer", "int", "pointer", "pointer", "pointer"],
                                      { abi: "thiscall" }),
            kernel: new NativeFunction(at(RVA.kernelInstance), "pointer", [],
                                       { abi: "mscdecl" }),
            send: new NativeFunction(at(RVA.kernelSend), "void",
                                     ["pointer", "pointer", "int", "int"],
                                     { abi: "thiscall" }),
            destroy: new NativeFunction(at(RVA.eventDestroy), "void", ["pointer"],
                                        { abi: "thiscall" }),
            // The constructor copies both names, so these are ours, not the game's.
            event: Memory.alloc(CONSOLE_EVENT_SIZE),
            to: Memory.allocAnsiString("UI_WND_CONSOLE"),
            from: Memory.alloc(4)
        };
    }
    return consoleNative;
}

function consoleSend(text) {
    var n = consoleNatives();
    // ANSI in the system code page, which is what the game reads.  A multibyte
    // code page can make it longer than the characters counted, so cut again.
    var line = Memory.allocAnsiString(text);
    var end = 0;
    while (end < CONSOLE_TEXT_MAX && line.add(end).readU8() !== 0) {
        end++;
    }
    line.add(end).writeU8(0);
    var ev = n.build(n.event, CONSOLE_EVENT, n.to, n.from, line);
    try {
        var kernel = n.kernel();
        if (!kernel.isNull()) {
            n.send(kernel, ev, 1, 0);
        }
    } finally {
        n.destroy(ev);
    }
}

onTick(function () {
    if (consoleQueue.length === 0 || isLoading()) {
        return;
    }
    if (consoleThread !== null && Process.getCurrentThreadId() !== consoleThread) {
        return;
    }
    for (var i = 0; i < CONSOLE_FLUSH_MAX && consoleQueue.length > 0; i++) {
        var text = consoleQueue.shift();
        try {
            consoleSend(text);
        } catch (e) {
            console.log("console.print failed: " + e.message);
        }
    }
});

command("console.print", function (f) {
    var text = (f.text === undefined || f.text === null) ? "" : String(f.text);
    // One line: a line break or a tab means nothing to the console window.
    text = text.replace(/[\x00-\x1f\x7f]/g, " ");
    if (text.trim() === "") {
        throw new Error("Nothing to print.");
    }
    if (text.length > CONSOLE_TEXT_MAX) {
        text = text.substring(0, CONSOLE_TEXT_MAX);
    }
    if (consoleQueue.length >= CONSOLE_QUEUE_MAX) {
        throw new Error("The console queue is full.");
    }
    consoleQueue.push(text);
    return { queued: consoleQueue.length };
});
