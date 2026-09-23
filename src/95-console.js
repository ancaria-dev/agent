// The in-game console.  cEngine::console takes the whole typed line, narrow
// ANSI, and returns whether it handled it; on false its caller prints "Error!
// Try HELP for help...".  One call per line entered, so it is safe to ask on.
//
// A mod that vetoes the line takes it: the game is handed an empty line, which
// its tokenizer treats as nothing, and the return is forced to true so no
// error follows.  Everything else reaches the game's own commands untouched.

var consoleNothing = null;

hook("console", RVA.console, {
    onEnter: function (args) {
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
