// The player's keys, mouse buttons and wheel, and the window's focus.
//
// All of it is read in the main window's procedure, before the game sees the
// message.  The game has two: the menus' (0x00812440), which the window is
// registered with, and the world's (0x00811270), which the menus' swaps in
// once a world runs.  Both turn the messages into key and mouse events for
// the kernel's queue, but only the presses reach cUI_Manager::receive_event
// (see STRUCTURES in mappings): releases, the wheel and the mouse's moves do
// not, so the uiEvent hook cannot report them.  The procedure runs on the
// thread that owns the window, not the engine thread, and a message it is
// handed with id 0 (WM_NULL) reaches nothing, which is the veto.
//
//   "key.press"      a key went down, asked; a veto keeps the key, its
//                    repeats, its characters and its release from the game.
//                    A repeat is reported, never asked.
//   "key.release"    a key came up.
//   "key.type"       the character a press typed, for a press not vetoed.
//   "mouse.press"    a button went down, asked; a veto keeps the button and
//                    its release from the game.
//   "mouse.release"  a button came up.
//   "mouse.wheel"    the wheel turned.
//   "window.focus"   the game's window became active (1) or not (0).
//
// Asking stops the window's thread, not the engine's: the world keeps
// running while a mod decides.  Keys the game polls with GetAsyncKeyState
// (Shift and Ctrl for its attack modes, among others) are read past this
// and a veto cannot keep them.  A click on a mod's layer is the layer's,
// never the game's and never a mouse.press: 99-overlay.js takes it.

var INPUT_ACTIVATEAPP = 0x1C;
var INPUT_KEYDOWN = 0x100;
var INPUT_KEYUP = 0x101;
var INPUT_CHAR = 0x102;
var INPUT_SYSKEYDOWN = 0x104;
var INPUT_SYSKEYUP = 0x105;
var INPUT_SYSCHAR = 0x106;
var INPUT_MOUSEMOVE = 0x200;
var INPUT_MOUSEWHEEL = 0x20A;
var INPUT_NULL = 0;

// Button messages: down, up, double click.  X buttons name theirs in wParam.
var INPUT_BUTTONS = {
    0x201: [1, "down"], 0x202: [1, "up"], 0x203: [1, "double"],
    0x204: [2, "down"], 0x205: [2, "up"], 0x206: [2, "double"],
    0x207: [3, "down"], 0x208: [3, "up"], 0x209: [3, "double"],
    0x20B: [4, "down"], 0x20C: [4, "up"], 0x20D: [4, "double"]
};
var INPUT_XBUTTON = 4;

var INPUT_SHIFT = 1;
var INPUT_CONTROL = 2;
var INPUT_ALT = 4;

// Keys whose press was vetoed, until their release; buttons the same.
var inputKeysHeld = {};
var inputButtonsHeld = {};
// The characters TranslateMessage made of a vetoed press come right after it.
var inputSwallowChars = false;
var inputUser = null;

function inputNatives() {
    if (inputUser === null) {
        var user32 = Process.getModuleByName("user32.dll");
        inputUser = {
            keyState: new NativeFunction(user32.getExportByName("GetKeyState"), "int16", ["int"],
                                         { abi: "stdcall" }),
            clientRect: new NativeFunction(user32.getExportByName("GetClientRect"), "int",
                                           ["pointer", "pointer"], { abi: "stdcall" }),
            screenToClient: new NativeFunction(user32.getExportByName("ScreenToClient"), "int",
                                               ["pointer", "pointer"], { abi: "stdcall" }),
            rect: Memory.alloc(16),
            point: Memory.alloc(8)
        };
    }
    return inputUser;
}

function inputMods() {
    var n = inputNatives();
    var mods = 0;
    if (n.keyState(0x10) < 0) {
        mods |= INPUT_SHIFT;
    }
    if (n.keyState(0x11) < 0) {
        mods |= INPUT_CONTROL;
    }
    if (n.keyState(0x12) < 0) {
        mods |= INPUT_ALT;
    }
    return mods;
}

function inputKeyFields(wParam, lParam, mods) {
    return {
        vk: wParam & 0xFF,
        scan: (lParam >>> 16) & 0xFF,
        ext: (lParam >>> 24) & 1,
        mods: mods
    };
}

// A client point in the game's own pixels: the back buffer's size over the
// client area's, which differ when a wrapper stretches the window.
function inputGamePoint(hwnd, cx, cy) {
    var n = inputNatives();
    var x = cx;
    var y = cy;
    try {
        var driver = ptr(VA.dxDriver).readPointer();
        if (!driver.isNull() && n.clientRect(hwnd, n.rect) !== 0) {
            var cw = n.rect.add(8).readS32();
            var ch = n.rect.add(12).readS32();
            var gw = driver.add(0x20).readU16();
            var gh = driver.add(0x1C).readU16();
            if (cw > 0 && ch > 0 && gw > 0 && gh > 0) {
                x = Math.floor(cx * gw / cw);
                y = Math.floor(cy * gh / ch);
            }
        }
    } catch (e) {}
    return { x: x, y: y };
}

function inputLowWord(v) {
    var w = v & 0xFFFF;
    return w >= 0x8000 ? w - 0x10000 : w;
}

function inputHighWord(v) {
    return inputLowWord(v >>> 16);
}

function inputOverlay(kind, button, point, delta, mods) {
    if (typeof overlayPointer !== "function") {
        return false;
    }
    return overlayPointer(kind, button, point.x, point.y, delta, mods);
}

// What one message means, and whether the game still gets it.  Returns false
// to keep it from the game.
function inputMessage(hwnd, msg, wParam, lParam) {
    if (msg === INPUT_KEYDOWN || msg === INPUT_SYSKEYDOWN) {
        var down = inputKeyFields(wParam, lParam, inputMods());
        var repeat = ((lParam >>> 30) & 1) === 1;
        inputSwallowChars = false;
        if (repeat) {
            down.repeat = 1;
            evt("key.press", down);
            if (inputKeysHeld[down.vk]) {
                inputSwallowChars = true;
                return false;
            }
            return true;
        }
        down.repeat = 0;
        if (ask("key.press", down).cancel) {
            inputKeysHeld[down.vk] = true;
            inputSwallowChars = true;
            return false;
        }
        return true;
    }
    if (msg === INPUT_CHAR || msg === INPUT_SYSCHAR) {
        if (inputSwallowChars) {
            return false;
        }
        evt("key.type", { ch: wParam & 0xFFFF, mods: inputMods() });
        return true;
    }
    if (msg === INPUT_KEYUP || msg === INPUT_SYSKEYUP) {
        inputSwallowChars = false;
        var up = inputKeyFields(wParam, lParam, inputMods());
        var held = inputKeysHeld[up.vk] === true;
        delete inputKeysHeld[up.vk];
        up.vetoed = held ? 1 : 0;
        evt("key.release", up);
        return !held;
    }
    var button = INPUT_BUTTONS[msg];
    if (button !== undefined) {
        var id = button[0];
        if (id === INPUT_XBUTTON) {
            id = ((wParam >>> 16) & 0xFFFF) === 2 ? 5 : 4;
        }
        var point = inputGamePoint(hwnd, inputLowWord(lParam), inputHighWord(lParam));
        var mods = inputMods();
        if (button[1] === "up") {
            if (inputOverlay("release", id, point, 0, mods)) {
                return false;
            }
            var vetoed = inputButtonsHeld[id] === true;
            delete inputButtonsHeld[id];
            evt("mouse.release", { button: id, x: point.x, y: point.y, mods: mods,
                                   vetoed: vetoed ? 1 : 0 });
            return !vetoed;
        }
        if (inputOverlay("press", id, point, 0, mods)) {
            return false;
        }
        var fields = { button: id, x: point.x, y: point.y, mods: mods,
                       double: button[1] === "double" ? 1 : 0 };
        if (ask("mouse.press", fields).cancel) {
            inputButtonsHeld[id] = true;
            return false;
        }
        return true;
    }
    if (msg === INPUT_MOUSEMOVE) {
        // The game draws its own cursor from these, so a move always reaches it.
        inputOverlay("move", 0, inputGamePoint(hwnd, inputLowWord(lParam), inputHighWord(lParam)),
                     0, 0);
        return true;
    }
    if (msg === INPUT_MOUSEWHEEL) {
        var n = inputNatives();
        n.point.writeS32(inputLowWord(lParam));
        n.point.add(4).writeS32(inputHighWord(lParam));
        n.screenToClient(hwnd, n.point);
        var at = inputGamePoint(hwnd, n.point.readS32(), n.point.add(4).readS32());
        var delta = inputHighWord(wParam);
        var wheelMods = inputMods();
        if (inputOverlay("wheel", 0, at, delta, wheelMods)) {
            return false;
        }
        evt("mouse.wheel", { delta: delta, x: at.x, y: at.y, mods: wheelMods });
        return true;
    }
    if (msg === INPUT_ACTIVATEAPP) {
        var active = wParam !== 0;
        if (!active) {
            // Nothing held down survives the switch: the releases go elsewhere.
            inputKeysHeld = {};
            inputButtonsHeld = {};
            inputSwallowChars = false;
            inputOverlay("leave", 0, { x: -1, y: -1 }, 0, 0);
        }
        evt("window.focus", { active: active ? 1 : 0 });
    }
    return true;
}

function inputProcedure(name, rva) {
    hook(name, rva, {
        onEnter: function (args) {
            var msg = args[1].toUInt32();
            if (msg === 0 || (msg !== INPUT_ACTIVATEAPP && (msg < INPUT_KEYDOWN || msg > 0x20D))) {
                return;
            }
            var keep;
            try {
                keep = inputMessage(args[0], msg, args[2].toUInt32(), args[3].toUInt32());
            } catch (e) {
                return;
            }
            if (!keep) {
                args[1] = ptr(INPUT_NULL);
            }
        }
    });
}

inputProcedure("wndProcWorld", RVA.wndProcWorld);
inputProcedure("wndProcMenu", RVA.wndProcMenu);
