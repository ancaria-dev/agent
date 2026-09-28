// Saving and loading a game.  Both are cEngine entries, thiscall with the
// file path first, called once per save or load, and both open with the same
// `push -1 / push imm32` SEH prologue nothing branches into.
//
// The slot is in the file name: GAME03.PAK is slot 3, and slot 0 is the
// quicksave.  SAVE02.PAK is what initGame loads to start a new game, so it is
// reported as fresh rather than as slot 2.

function saveSlot(path) {
    var m = /GAMEF?(\d+)\.PAK/i.exec(path || "");
    return m === null ? -1 : parseInt(m[1], 10);
}

// The display name sits in a fixed 64-byte field.  readCString(64) does not
// stop at the terminator, so "QUICKSAVE" came back with the rest of the field
// behind it: find the NUL first and read only that far.
function fieldString(p, size) {
    var bytes = new Uint8Array(p.readByteArray(size));
    var n = bytes.indexOf(0);
    n = n < 0 ? size : n;
    return n === 0 ? "" : p.readAnsiString(n);
}

// The engine keeps the slot at +0x68 and the save's display name at +0x6A
// while it writes; the name is what the save dialog shows.
hook("saveGame", RVA.saveGame, {
    onEnter: function (args) {
        try {
            var engine = this.context.ecx;
            this.fields = {
                slot: engine.add(0x68).readU16(),
                name: fieldString(engine.add(0x6A), 64),
                path: args[0].readCString()
            };
        } catch (e) {
            this.fields = null;
        }
    },
    onLeave: function (retval) {
        if (this.fields) {
            this.fields.ok = (retval.toUInt32() & 0xFF) ? 1 : 0;
            evt("session.saved", this.fields);
        }
    }
});

hook("loadGame", RVA.loadGame, {
    onEnter: function (args) {
        try {
            var path = args[0].readCString();
            this.fields = {
                path: path,
                slot: saveSlot(path),
                fresh: /SAVE02\.PAK/i.test(path) ? 1 : 0
            };
        } catch (e) {
            this.fields = null;
            return;
        }
        evt("session.load_start", this.fields);
    },
    onLeave: function () {
        if (this.fields) {
            evt("session.load_done", this.fields);
        }
    }
});

// Saving and loading for a mod, the way the game's own menus ask for it: a
// cEvent_engine with id 0xF sent through the kernel, which runs the engine's
// handler at once.  The handler only records the request, the slot at +0x68
// and bit 0x40 (save) or 0x200 (load) in the word at +0x54; the engine thread
// writes or reads the file on its next frame, through the saveGame and
// loadGame entries above, which report it as always.
//
// It runs on the engine thread, where the game handles F9 and F8 too.  A save
// asks for the thumbnail and for the game's own check, as F9 does: with a
// merchant, a blacksmith, a master, a chest, a trade or a dialog open the
// handler refuses and sets no bit, and that is the answer.  A load has no
// check in the game, like F8, so the file must exist before it is asked for:
// a missing one sends the engine to GAMEF<n+1>.PAK and then to a failed load.
var SAVE_EVENT = 0xF;
var SAVE_EVENT_SIZE = 0x24;
var SAVE_MODE_LOAD = 1;
var SAVE_MODE_SAVE = 2;
var SAVE_BITS_SAVE = 0xC0;
var SAVE_BITS_LOAD = 0x200;
var SAVE_SLOT_NEW = 0xFFFF;
var SAVE_SLOT_LAST = 0x1FE;     // the next free slot search stops before 0x1FF
var SAVE_NAME_MAX = 63;         // the engine's field is 64 bytes with the NUL

var saveNative = null;

function saveNatives() {
    if (saveNative === null) {
        saveNative = {
            kernel: new NativeFunction(at(RVA.kernelInstance), "pointer", [],
                                       { abi: "mscdecl" }),
            send: new NativeFunction(at(RVA.kernelSend), "void",
                                     ["pointer", "pointer", "int", "int"],
                                     { abi: "thiscall" }),
            event: Memory.alloc(SAVE_EVENT_SIZE)
        };
    }
    return saveNative;
}

function saveEngine() {
    var engine = ptr(VA.engine).readPointer();
    if (engine.isNull() || !live(heroFull) || isLoading()) {
        throw new Error("There is no world to save or load in.");
    }
    return engine;
}

function saveFileExists(slot) {
    var dir = gameMod.path.replace(/[\\/][^\\/]*$/, "");
    var name = "GAME" + (slot < 10 ? "0" : "") + slot + ".PAK";
    try {
        new File(dir + "\SAVE\\" + name, "rb").close();
        return true;
    } catch (e) {
        return false;
    }
}

commandOnEngine("save.request", function (f) {
    var mode = f.mode === "load" ? SAVE_MODE_LOAD
             : f.mode === "save" ? SAVE_MODE_SAVE : 0;
    if (mode === 0) {
        throw new Error("A request is a save or a load.");
    }
    var slot = parseInt(f.slot, 10);
    var fresh = mode === SAVE_MODE_SAVE && slot === -1;
    if (fresh) {
        slot = SAVE_SLOT_NEW;
    } else if (!(slot >= 0 && slot <= SAVE_SLOT_LAST)) {
        throw new Error("No save slot " + f.slot + ".");
    }
    var name = f.name === undefined || f.name === null ? "" : String(f.name);
    name = name.replace(/[\x00-\x1f\x7f]/g, " ");
    if (name.length > SAVE_NAME_MAX) {
        name = name.substring(0, SAVE_NAME_MAX);
    }
    if (mode === SAVE_MODE_LOAD && !saveFileExists(slot)) {
        throw new Error("Slot " + slot + " holds no save.");
    }
    return function () {
        var engine = saveEngine();
        var word = engine.add(0x54);
        if (word.readU32() & (SAVE_BITS_SAVE | SAVE_BITS_LOAD)) {
            throw new Error("The game is already saving or loading.");
        }
        var n = saveNatives();
        var ev = n.event;
        for (var i = 0; i < SAVE_EVENT_SIZE; i += 4) {
            ev.add(i).writeU32(0);
        }
        // Ours, not the game's: the sender owns the name and frees it, and
        // the handler copies it to +0x6A before the send returns.
        var text = Memory.allocAnsiString(name);
        ev.writePointer(ptr(VA.engineEventVtable));
        ev.add(0x04).writeU32(SAVE_EVENT);
        ev.add(0x08).writeU32(mode);
        ev.add(0x0C).writeU32(slot);
        if (mode === SAVE_MODE_SAVE) {
            ev.add(0x14).writeU32(1);
            ev.add(0x18).writeU32(1);
            ev.add(0x20).writePointer(text);
        }
        var kernel = n.kernel();
        if (kernel.isNull()) {
            throw new Error("The game has no event kernel.");
        }
        n.send(kernel, ev, 0, 0);
        var bits = word.readU32() & (mode === SAVE_MODE_SAVE ? SAVE_BITS_SAVE : SAVE_BITS_LOAD);
        return {
            accepted: bits !== 0 ? 1 : 0,
            slot: engine.add(0x68).readU16(),
            name: fieldString(engine.add(0x6A), 64)
        };
    };
});
