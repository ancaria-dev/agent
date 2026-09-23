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

// The engine keeps the slot at +0x68 and the save's display name at +0x6A
// while it writes; the name is what the save dialog shows.
hook("saveGame", RVA.saveGame, {
    onEnter: function (args) {
        try {
            var engine = this.context.ecx;
            this.fields = {
                slot: engine.add(0x68).readU16(),
                name: engine.add(0x6A).readCString(64),
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
