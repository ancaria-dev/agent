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
//   "engine.frames"          every frame, at most once a millisecond: the
//                            last frame's length, the rate over the last
//                            second and the count so far
//   "engine.display"         the back buffer's size, depth or mode changed,
//                            or the refresh rate of the window's monitor
//   "engine.device_lost"     flip failed; "engine.device_restored" when it
//                            succeeds again
//   "engine.thread_started"  the render or menu thread came, or went
//   "engine.thread_ended"    (role, id)
//   "window.moved"           x, y: the client area's top left on the screen
//   "window.resized"         width, height of the client area
//   "window.minimized" / "window.restored"
//
// The game handles neither WM_MOVE nor WM_SIZE: its back buffer keeps its
// size and a window flip blits into the rectangle it computed at start-up.
// 93-input.js hands both messages here from the window procedures.
//
//   native.info              everything above, read now, and the seconds
//                            the engine's last frame moved the world
//
// The game keeps no target frame rate to read: its own limiter (0x0060ACE0)
// is switched off in memory by pHD.dll, whose PHD_FPS_LIMIT decides.

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
var NATIVE_FRAME_DELTA = 0xB0;      // [engine+0xB0], float seconds
var NATIVE_STILL_ACTIVE = 259;
// The refresh rate of the monitor the window is on: MonitorFromWindow,
// GetMonitorInfoW into a MONITORINFOEXW (104 bytes, device name at 40), then
// EnumDisplaySettingsW's current mode into a DEVMODEW (220 bytes, dmSize at
// 68, dmDriverExtra at 70, dmDisplayFrequency at 184).
var NATIVE_MONITOR_NEAREST = 2;
var NATIVE_MONITORINFO_SIZE = 104;
var NATIVE_MONITOR_DEVICE = 40;
var NATIVE_DEVMODE_SIZE = 220;
var NATIVE_DEVMODE_SIZE_AT = 68;
var NATIVE_DEVMODE_EXTRA_AT = 70;
var NATIVE_DEVMODE_FREQUENCY = 184;
var NATIVE_ENUM_CURRENT = 0xFFFFFFFF;
var NATIVE_SLOW_MS = 1000;
// The shortest gap between two "engine.frames", in microseconds.
var NATIVE_FRAMES_GAP_US = 1000;

var NATIVE_SIZE_MINIMIZED = 1;
var nativeMinimized = false;

function nativeLowWord(v) {
    var w = v & 0xFFFF;
    return w >= 0x8000 ? w - 0x10000 : w;
}

function nativeWindowMessage(msg, wParam, lParam) {
    if (msg === 0x03) {
        if (!nativeMinimized) {
            evt("window.moved", { x: nativeLowWord(lParam), y: nativeLowWord(lParam >>> 16) });
        }
        return;
    }
    var minimized = wParam === NATIVE_SIZE_MINIMIZED;
    if (minimized !== nativeMinimized) {
        nativeMinimized = minimized;
        evt(minimized ? "window.minimized" : "window.restored", {});
    }
    if (!minimized) {
        evt("window.resized", { width: lParam & 0xFFFF, height: (lParam >>> 16) & 0xFFFF });
    }
}

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
            windowRect: new NativeFunction(user32.getExportByName("GetWindowRect"), "int",
                                           ["pointer", "pointer"], { abi: "stdcall" }),
            toScreen: new NativeFunction(user32.getExportByName("ClientToScreen"), "int",
                                         ["pointer", "pointer"], { abi: "stdcall" }),
            iconic: new NativeFunction(user32.getExportByName("IsIconic"), "int", ["pointer"],
                                       { abi: "stdcall" }),
            title: new NativeFunction(user32.getExportByName("GetWindowTextW"), "int",
                                      ["pointer", "pointer", "int"], { abi: "stdcall" }),
            text: Memory.alloc(512),
            monitor: new NativeFunction(user32.getExportByName("MonitorFromWindow"), "pointer",
                                        ["pointer", "uint32"], { abi: "stdcall" }),
            monitorInfo: new NativeFunction(user32.getExportByName("GetMonitorInfoW"), "int",
                                            ["pointer", "pointer"], { abi: "stdcall" }),
            displayMode: new NativeFunction(user32.getExportByName("EnumDisplaySettingsW"), "int",
                                            ["pointer", "uint32", "pointer"], { abi: "stdcall" }),
            info: Memory.alloc(NATIVE_MONITORINFO_SIZE),
            mode: Memory.alloc(NATIVE_DEVMODE_SIZE),
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

// The frame's length is measured here, where the game presents it, on the
// render thread: the time since the previous present.  Sent with every frame
// unless the last one went out less than a millisecond ago, which only an
// uncapped menu reaches.
hook("frameFlip", RVA.frameFlip, {
    onEnter: function () {
        nativeFrames += 1;
        noteFrame();
        try {
            nativeFrame(nowMicros());
        } catch (e) {}
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

// Hertz, or 0 when Windows does not say (0 and 1 mean the hardware default).
function nativeRefresh(hwnd) {
    if (hwnd.isNull()) {
        return 0;
    }
    var n = nativeNatives();
    var monitor = n.monitor(hwnd, NATIVE_MONITOR_NEAREST);
    if (monitor.isNull()) {
        return 0;
    }
    n.info.writeU32(NATIVE_MONITORINFO_SIZE);
    if (n.monitorInfo(monitor, n.info) === 0) {
        return 0;
    }
    // A driver's extra bytes from the last call would make Windows write past
    // the buffer, so both size fields are set on every call.
    n.mode.add(NATIVE_DEVMODE_SIZE_AT).writeU16(NATIVE_DEVMODE_SIZE);
    n.mode.add(NATIVE_DEVMODE_EXTRA_AT).writeU16(0);
    if (n.displayMode(n.info.add(NATIVE_MONITOR_DEVICE), NATIVE_ENUM_CURRENT, n.mode) === 0) {
        return 0;
    }
    var hz = n.mode.add(NATIVE_DEVMODE_FREQUENCY).readU32();
    return hz > 1 ? hz : 0;
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
        fullscreen: d.add(NATIVE_FULLSCREEN).readU32() === 1 ? 1 : 0,
        refresh: nativeRefresh(d.add(NATIVE_HWND).readPointer())
    };
}

var nativeLastThreads = null;
var nativeLastDisplay = null;
var nativeFps = 0;
// When each frame of the last second was presented, in microseconds.
var nativeTimes = [];
var nativeSent = 0;

function nativeFrame(now) {
    var prev = nativeTimes.length > 0 ? nativeTimes[nativeTimes.length - 1] : 0;
    nativeTimes.push(now);
    while (nativeTimes.length > 1 && now - nativeTimes[0] > 1e6) {
        nativeTimes.shift();
    }
    var span = now - nativeTimes[0];
    if (span > 0) {
        nativeFps = Math.round((nativeTimes.length - 1) * 1e7 / span) / 10;
    }
    if (prev === 0 || now - nativeSent < NATIVE_FRAMES_GAP_US) {
        return;
    }
    nativeSent = now;
    evt("engine.frames", { fps: nativeFps, frames: nativeFrames, frameUs: Math.round(now - prev) });
}

// The display and the threads, once a second.
function nativeSlow() {
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
        nativeSlow();
    } catch (e) {}
}, NATIVE_SLOW_MS);

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
    var engine = ptr(VA.engine).readPointer();
    if (!engine.isNull()) {
        out.delta = engine.add(NATIVE_FRAME_DELTA).readFloat();
    }
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
        n.out.writeS32(0);
        n.out.add(4).writeS32(0);
        if (n.toScreen(hwnd, n.out) !== 0) {
            out.clientX = n.out.readS32();
            out.clientY = n.out.add(4).readS32();
        }
        if (n.windowRect(hwnd, n.out) !== 0) {
            out.windowX = n.out.readS32();
            out.windowY = n.out.add(4).readS32();
            out.windowWidth = n.out.add(8).readS32() - out.windowX;
            out.windowHeight = n.out.add(12).readS32() - out.windowY;
        }
        out.minimized = n.iconic(hwnd) !== 0 ? 1 : 0;
        var length = n.title(hwnd, n.text, 256);
        out.title = length > 0 ? n.text.readUtf16String(length) : "";
    }
    return out;
});
