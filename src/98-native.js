// The game's native side: its window, threads, DirectDraw objects and frames.
//
// The DirectDraw 7 / Direct3D 7 driver is one object at [VA.dxDriver] (layout
// under STRUCTURES in mappings): the window handle, the DirectDraw and
// Direct3D objects, the front and back surfaces and the device.  A pointer
// into the game means nothing to another process, so Java gets them as
// numbers to name, not to call; the window handle and the thread ids are
// system-wide and do work from there.
//
// Frames are counted at cDxDriver7::flip, which presents every frame the
// game draws: the world's, the menu thread's, the load screen's and the
// videos'.  Nothing is sent per frame.  The rest is sampled once a second on
// Frida's own thread, where reading memory is safe:
//
//   "engine.frames"          every five seconds while frames come: the rate
//                            and the count so far
//   "engine.display"         the back buffer's size, depth or mode changed
//   "engine.device_lost"     flip failed; "engine.device_restored" when it
//                            succeeds again
//   "engine.thread_started"  the render or menu thread came, or went
//   "engine.thread_ended"    (role, id)
//
//   native.info              everything above, read now

var NATIVE_HEIGHT = 0x1C;
var NATIVE_WIDTH = 0x20;
var NATIVE_FULLSCREEN = 0x90;
var NATIVE_BPP = 0x94;
var NATIVE_HWND = 0xB0;
var NATIVE_DDRAW = 0xB4;
var NATIVE_FRONT = 0xB8;
var NATIVE_BACK = 0xBC;
var NATIVE_D3D = 0xC8;
var NATIVE_DEVICE = 0xCC;
var NATIVE_MENU_THREAD = 0x0C;      // [uiManager+0x0C], the menu thread's handle
var NATIVE_STILL_ACTIVE = 259;
var NATIVE_REPORT_MS = 5000;

var nativeFrames = 0;
var nativeLost = false;
var nativeWin = null;

function nativeNatives() {
    if (nativeWin === null) {
        var k32 = Process.getModuleByName("kernel32.dll");
        var user32 = Process.getModuleByName("user32.dll");
        nativeWin = {
            threadId: new NativeFunction(k32.getExportByName("GetThreadId"), "uint32", ["pointer"],
                                         { abi: "stdcall" }),
            exitCode: new NativeFunction(k32.getExportByName("GetExitCodeThread"), "int",
                                         ["pointer", "pointer"], { abi: "stdcall" }),
            windowThread: new NativeFunction(user32.getExportByName("GetWindowThreadProcessId"),
                                             "uint32", ["pointer", "pointer"], { abi: "stdcall" }),
            foreground: new NativeFunction(user32.getExportByName("GetForegroundWindow"), "pointer", [],
                                           { abi: "stdcall" }),
            clientRect: new NativeFunction(user32.getExportByName("GetClientRect"), "int",
                                           ["pointer", "pointer"], { abi: "stdcall" }),
            out: Memory.alloc(16)
        };
    }
    return nativeWin;
}

function nativeDriver() {
    var d = ptr(VA.dxDriver).readPointer();
    return d.isNull() ? null : d;
}

function nativeHex(p) {
    return p.isNull() ? "0" : p.toString();
}

hook("frameFlip", RVA.frameFlip, {
    onEnter: function () {
        nativeFrames += 1;
    },
    onLeave: function (retval) {
        var failed = retval.toInt32() < 0;
        if (failed !== nativeLost) {
            nativeLost = failed;
            evt(failed ? "engine.device_lost" : "engine.device_restored",
                failed ? { hr: (retval.toUInt32() >>> 0).toString(16) } : {});
        }
    }
});

// The render thread's id is the engine's own global; the menu thread is found
// through its handle, which outlives it, so it counts only while it runs.
function nativeThreads() {
    var threads = { render: ptr(VA.engineThread).readU32(), menu: 0 };
    var mgr = ptr(VA.uiManager).readPointer();
    if (!mgr.isNull()) {
        var handle = mgr.add(NATIVE_MENU_THREAD).readPointer();
        if (!handle.isNull()) {
            var n = nativeNatives();
            if (n.exitCode(handle, n.out) !== 0 && n.out.readU32() === NATIVE_STILL_ACTIVE) {
                threads.menu = n.threadId(handle);
            }
        }
    }
    return threads;
}

function nativeDisplay() {
    var d = nativeDriver();
    if (d === null) {
        return null;
    }
    return {
        width: d.add(NATIVE_WIDTH).readU16(),
        height: d.add(NATIVE_HEIGHT).readU16(),
        bpp: d.add(NATIVE_BPP).readU32(),
        fullscreen: d.add(NATIVE_FULLSCREEN).readU32() === 1 ? 1 : 0
    };
}

var nativeLastThreads = null;
var nativeLastDisplay = null;
var nativeFps = 0;
var nativeSampledFrames = 0;
var nativeSampledAt = Date.now();
var nativeReportedAt = Date.now();

function nativeSample() {
    var now = Date.now();
    var frames = nativeFrames;
    if (now > nativeSampledAt) {
        nativeFps = Math.round((frames - nativeSampledFrames) * 10000 / (now - nativeSampledAt)) / 10;
    }
    nativeSampledFrames = frames;
    nativeSampledAt = now;
    if (now - nativeReportedAt >= NATIVE_REPORT_MS) {
        nativeReportedAt = now;
        if (nativeFps > 0) {
            evt("engine.frames", { fps: nativeFps, frames: frames });
        }
    }

    var display = nativeDisplay();
    if (display !== null) {
        var shown = JSON.stringify(display);
        if (nativeLastDisplay !== null && shown !== nativeLastDisplay) {
            evt("engine.display", display);
        }
        nativeLastDisplay = shown;
    }

    var threads = nativeThreads();
    if (nativeLastThreads !== null) {
        ["render", "menu"].forEach(function (role) {
            var before = nativeLastThreads[role];
            var after = threads[role];
            if (before === after) {
                return;
            }
            if (before !== 0) {
                evt("engine.thread_ended", { role: role, id: before });
            }
            if (after !== 0) {
                evt("engine.thread_started", { role: role, id: after });
            }
        });
    }
    nativeLastThreads = threads;
}

setInterval(function () {
    try {
        nativeSample();
    } catch (e) {}
}, 1000);

command("native.info", function () {
    var n = nativeNatives();
    var out = {
        pid: Process.id,
        base: nativeHex(base),
        fps: nativeFps,
        frames: nativeFrames,
        lost: nativeLost ? 1 : 0,
        threads: Process.enumerateThreads().map(function (t) {
            return t.id;
        }).join(",")
    };
    var threads = nativeThreads();
    out.render = threads.render;
    out.menu = threads.menu;
    var d = nativeDriver();
    if (d === null) {
        return out;
    }
    var hwnd = d.add(NATIVE_HWND).readPointer();
    out.hwnd = nativeHex(hwnd);
    out.ddraw = nativeHex(d.add(NATIVE_DDRAW).readPointer());
    out.d3d = nativeHex(d.add(NATIVE_D3D).readPointer());
    out.device = nativeHex(d.add(NATIVE_DEVICE).readPointer());
    out.front = nativeHex(d.add(NATIVE_FRONT).readPointer());
    out.back = nativeHex(d.add(NATIVE_BACK).readPointer());
    var display = nativeDisplay();
    for (var k in display) {
        out[k] = display[k];
    }
    if (!hwnd.isNull()) {
        out.window = n.windowThread(hwnd, NULL);
        out.focused = n.foreground().equals(hwnd) ? 1 : 0;
        if (n.clientRect(hwnd, n.out) !== 0) {
            out.clientWidth = n.out.add(8).readS32();
            out.clientHeight = n.out.add(12).readS32();
        }
    }
    return out;
});
