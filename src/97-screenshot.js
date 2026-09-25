// Screenshots.  Ctrl+B makes the renderer save the frame through one cdecl
// function (0x00648B30): with index -1 it picks the next free
// .\Capture\shotNNNN.tga, writes it and starts a thread that adds a .jpg.
// The game's video capture calls the same function every frame with a
// capture index of its own, and that is left alone: asking about each frame
// would stall the game.
//
// A single shot is asked about first and can be refused; the file it wrote
// is reported after, with the path the game built in its own buffer.

var SHOT_SINGLE = -1;

replaced("screenshot", RVA.screenshot, "void", ["pointer", "int", "int"], function (original) {
    return function (surface, arg, index) {
        if (index !== SHOT_SINGLE) {
            original(surface, arg, index);
            return;
        }
        if (ask("ui.screenshot", {}).cancel) {
            return;
        }
        original(surface, arg, index);
        var path = "";
        try {
            path = ptr(VA.screenshotPath).readCString() || "";
        } catch (e) {}
        evt("ui.screenshot_taken", { path: path });
    };
}, "mscdecl");
