// The game's videos: the start-up logos, the intro, the acts and the endings.
//
// Every video opens its file through one function (0x006A0EF0, the ANSI path
// its first argument) and then runs the player's loop (0x006A1010) until the
// film ends or the player skips it, when the loop returns -1.  Both run a few
// times a session.
//
//   "video.started"  file: the path as the game wrote it, .\MOVIE\INTRO.WMV
//   "video.ended"    file, skipped: 1 when the player or a mod skipped it
//
//   video.skip       skips the video playing now, as Esc does; skipped: 0
//                    when none plays
//
// The loop reads the keys with GetAsyncKeyState through the game's import
// (VA.asyncKeyImport).  A skip points the import at a function that answers
// "Esc is down" once, to the loop alone (by return address), and puts the
// import back as it does; every other caller gets the real answer.  The
// function stays alive for good: the loop keeps its address in a register
// while it waits for Esc to come up.

var VIDEO_ESC = 0x1B;
var VIDEO_DOWN = -32768;            // the high bit: held now

var videoFile = null;
var videoPlaying = null;
var videoShot = false;
var videoReal = null;
var videoFake = null;
var videoSaved = null;

function videoRestore() {
    if (videoSaved === null) {
        return;
    }
    var slot = ptr(VA.asyncKeyImport);
    var range = Process.findRangeByAddress(slot);
    var protection = range === null ? "r--" : range.protection;
    Memory.protect(slot, 4, "rw-");
    slot.writePointer(videoSaved);
    Memory.protect(slot, 4, protection);
    videoSaved = null;
}

function videoArm() {
    if (videoFake === null) {
        videoReal = new NativeFunction(Process.getModuleByName("user32.dll").getExportByName("GetAsyncKeyState"),
                                       "int16", ["int"], { abi: "stdcall" });
        var from = at(RVA.videoPlay);
        var to = at(RVA.videoPlayFile);
        videoFake = new NativeCallback(function (vk) {
            if (videoShot && vk === VIDEO_ESC) {
                var back = this.returnAddress;
                if (back.compare(from) >= 0 && back.compare(to) < 0) {
                    videoShot = false;
                    try {
                        videoRestore();
                    } catch (e) {}
                    return VIDEO_DOWN;
                }
            }
            return videoReal(vk);
        }, "int16", ["int"], "stdcall");
    }
    if (videoSaved !== null) {
        return;
    }
    var slot = ptr(VA.asyncKeyImport);
    var range = Process.findRangeByAddress(slot);
    var protection = range === null ? "r--" : range.protection;
    videoSaved = slot.readPointer();
    Memory.protect(slot, 4, "rw-");
    slot.writePointer(videoFake);
    Memory.protect(slot, 4, protection);
}

hook("videoOpen", RVA.videoOpen, {
    onEnter: function (args) {
        try {
            videoFile = args[0].readCString();
        } catch (e) {
            videoFile = null;
        }
    }
});

hook("videoPlay", RVA.videoPlay, {
    onEnter: function () {
        videoPlaying = videoFile || "";
        evt("video.started", { file: videoPlaying });
    },
    onLeave: function (retval) {
        var file = videoPlaying;
        videoPlaying = null;
        videoShot = false;
        try {
            videoRestore();
        } catch (e) {}
        evt("video.ended", { file: file || "", skipped: retval.toInt32() === -1 ? 1 : 0 });
    }
});

command("video.skip", function () {
    if (videoPlaying === null) {
        return { skipped: 0 };
    }
    videoShot = true;
    videoArm();
    return { skipped: 1 };
});
