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
//                    The window is an ANSI one (CreateWindowExA), so WM_CHAR
//                    carries a byte in the code page of the keyboard layout,
//                    not UTF-16: a Russian "ф" arrives as 0xF4.  The byte is
//                    turned into UTF-16 through that code page, and a
//                    double-byte character's two messages into one.
//   "mouse.press"    a button went down, asked; a veto keeps the button and
//                    its release from the game.
//   "mouse.release"  a button came up.
//   "mouse.wheel"    the wheel turned.
//   "window.focus"   the game's window became active (1) or not (0).
//
// While a mod's layer holds the keyboard (99-overlay.js), its keys go to the
// layer instead, and neither the game nor a KeyPress sees them:
//
//   "layer.key_press"    layer, and the fields of "key.press"
//   "layer.key_release"  layer, and the fields of "key.release"; the release
//                        of a key the layer took goes to that layer even
//                        after the focus has moved
//   "layer.key_type"     layer, ch, mods
//
// Alt's combinations (WM_SYSKEYDOWN) still reach the game, so Alt+Tab and
// Alt+F4 keep working.
//
//   input.down       whether a key (vk) or a mouse button (button, 1..5) is
//                    held now, for a mod that polls: GetAsyncKeyState, and
//                    never while another window is the active one.
//   input.cursor     where the game draws its cursor, in back-buffer pixels
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
// Keys a layer took, by the layer that took them, until their release.
var inputLayerKeys = {};
var inputButtonsHeld = {};
// The characters TranslateMessage made of a vetoed press come right after it.
var inputSwallowChars = false;
var inputUser = null;
var inputPages = {};
var inputLead = -1;

function inputNatives() {
    if (inputUser === null) {
        var user32 = Process.getModuleByName("user32.dll");
        inputUser = {
            keyState: new NativeFunction(user32.getExportByName("GetKeyState"), "int16", ["int"],
                                         { abi: "stdcall" }),
            asyncState: new NativeFunction(user32.getExportByName("GetAsyncKeyState"), "int16", ["int"],
                                           { abi: "stdcall" }),
            foreground: new NativeFunction(user32.getExportByName("GetForegroundWindow"), "pointer", [],
                                           { abi: "stdcall" }),
            metric: new NativeFunction(user32.getExportByName("GetSystemMetrics"), "int", ["int"],
                                       { abi: "stdcall" }),
            unicode: new NativeFunction(user32.getExportByName("IsWindowUnicode"), "int", ["pointer"],
                                        { abi: "stdcall" }),
            layout: new NativeFunction(user32.getExportByName("GetKeyboardLayout"), "pointer", ["uint32"],
                                       { abi: "stdcall" }),
            locale: new NativeFunction(Process.getModuleByName("kernel32.dll").getExportByName("GetLocaleInfoW"),
                                       "int", ["uint32", "uint32", "pointer", "int"], { abi: "stdcall" }),
            lead: new NativeFunction(Process.getModuleByName("kernel32.dll").getExportByName("IsDBCSLeadByteEx"),
                                     "int", ["uint32", "uint8"], { abi: "stdcall" }),
            widen: new NativeFunction(Process.getModuleByName("kernel32.dll").getExportByName("MultiByteToWideChar"),
                                      "int", ["uint32", "uint32", "pointer", "int", "pointer", "int"],
                                      { abi: "stdcall" }),
            bytes: Memory.alloc(4),
            wide: Memory.alloc(8),
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

// The keyboard layout's ANSI code page, which WM_CHAR's byte is in.
var INPUT_LOCALE_ANSI_PAGE = 0x1004 | 0x20000000;   // LOCALE_IDEFAULTANSICODEPAGE | LOCALE_RETURN_NUMBER

function inputCodePage(n) {
    var language = n.layout(0).toUInt32() & 0xFFFF;
    var page = inputPages[language];
    if (page === undefined) {
        page = n.locale(language, INPUT_LOCALE_ANSI_PAGE, n.wide, 2) !== 0 ? n.wide.readU32() : 0;
        inputPages[language] = page;
    }
    return page;
}

// WM_CHAR's wParam as UTF-16 code units: none while a double-byte
// character's first half waits for its second.
function inputChars(hwnd, wParam) {
    var n = inputNatives();
    if (n.unicode(hwnd) !== 0) {
        return [wParam & 0xFFFF];
    }
    var b = wParam & 0xFF;
    var page = inputCodePage(n);
    var count = 1;
    if (inputLead >= 0) {
        n.bytes.writeU8(inputLead);
        n.bytes.add(1).writeU8(b);
        count = 2;
        inputLead = -1;
    } else if (n.lead(page, b) !== 0) {
        inputLead = b;
        return [];
    } else {
        n.bytes.writeU8(b);
    }
    var made = n.widen(page, 0, n.bytes, count, n.wide, 2);
    var out = [];
    for (var i = 0; i < made; i++) {
        out.push(n.wide.add(2 * i).readU16());
    }
    return out.length > 0 ? out : [b];
}

function inputKeyFields(wParam, lParam, mods) {
    return {
        vk: wParam & 0xFF,
        scan: (lParam >>> 16) & 0xFF,
        ext: (lParam >>> 24) & 1,
        mods: mods
    };
}

// Where the cursor is, in the game's own pixels: the point the game draws its
// cursor at, read through its own function (0x0066E6E0).  A message's lParam
// is not that point: in fullscreen a wrapper such as dgVoodoo redirects the
// game's cursor calls, and a layer hit-tested with lParam took clicks far
// from where the cursor was drawn.
var inputCursorFn = null;

function inputGamePoint(hwnd) {
    var n = inputNatives();
    if (inputCursorFn === null) {
        inputCursorFn = new NativeFunction(at(RVA.cursorClient), "void", ["pointer", "pointer"],
                                           { abi: "mscdecl" });
    }
    inputCursorFn(hwnd, n.point);
    return { x: n.point.readS32(), y: n.point.add(4).readS32() };
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

function inputKeyboard() {
    return typeof overlayKeyboard === "function" ? overlayKeyboard() : null;
}

// A key for the layer that holds the keyboard: false to keep it from the
// game, null when no layer wants it.  Esc goes to the layer and takes the
// focus from it, and its character is kept from the game as well.
function inputLayerKey(hwnd, msg, wParam, lParam) {
    if (msg === INPUT_KEYDOWN) {
        var id = inputKeyboard();
        if (id === null) {
            return null;
        }
        var down = inputKeyFields(wParam, lParam, inputMods());
        down.layer = id;
        down.repeat = ((lParam >>> 30) & 1) === 1 ? 1 : 0;
        inputLayerKeys[down.vk] = id;
        inputSwallowChars = false;
        evt("layer.key_press", down);
        if (down.vk === 0x1B) {
            overlayLoseFocus(id);
            inputSwallowChars = true;
        }
        return false;
    }
    if (msg === INPUT_CHAR) {
        if (inputSwallowChars) {
            return false;
        }
        var holder = inputKeyboard();
        if (holder === null) {
            return null;
        }
        var typed = inputChars(hwnd, wParam);
        var mods = inputMods();
        for (var c = 0; c < typed.length; c++) {
            evt("layer.key_type", { layer: holder, ch: typed[c], mods: mods });
        }
        return false;
    }
    if (msg === INPUT_KEYUP) {
        var vk = wParam & 0xFF;
        var owner = inputLayerKeys[vk];
        if (owner === undefined) {
            return null;
        }
        delete inputLayerKeys[vk];
        inputSwallowChars = false;
        var up = inputKeyFields(wParam, lParam, inputMods());
        up.layer = owner;
        evt("layer.key_release", up);
        return false;
    }
    return null;
}

// What one message means, and whether the game still gets it.  Returns false
// to keep it from the game.
function inputMessage(hwnd, msg, wParam, lParam) {
    var layerKey = inputLayerKey(hwnd, msg, wParam, lParam);
    if (layerKey !== null) {
        return layerKey;
    }
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
        var typed = inputChars(hwnd, wParam);
        var typedMods = inputMods();
        for (var c = 0; c < typed.length; c++) {
            evt("key.type", { ch: typed[c], mods: typedMods });
        }
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
        var point = inputGamePoint(hwnd);
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
        inputOverlay("move", 0, inputGamePoint(hwnd), 0, 0);
        return true;
    }
    if (msg === INPUT_MOUSEWHEEL) {
        var at = inputGamePoint(hwnd);
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
            inputLayerKeys = {};
            inputButtonsHeld = {};
            inputSwallowChars = false;
            inputOverlay("leave", 0, { x: -1, y: -1 }, 0, 0);
        }
        evt("window.focus", { active: active ? 1 : 0 });
    }
    return true;
}

var INPUT_MOVE = 0x03;
var INPUT_SIZE = 0x05;

function inputProcedure(name, rva) {
    hook(name, rva, {
        onEnter: function (args) {
            var msg = args[1].toUInt32();
            if (msg === INPUT_MOVE || msg === INPUT_SIZE) {
                // The window's own moves are 98-native.js's; the game ignores them.
                if (typeof nativeWindowMessage === "function") {
                    try {
                        nativeWindowMessage(msg, args[2].toUInt32(), args[3].toUInt32());
                    } catch (e) {}
                }
                return;
            }
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

// Virtual-key codes of the mouse buttons, by the wire's button number.
// GetAsyncKeyState reads the physical buttons, the window's messages the
// logical ones, so a left-handed setup swaps the first two.
var INPUT_BUTTON_KEYS = { 1: 0x01, 2: 0x02, 3: 0x04, 4: 0x05, 5: 0x06 };
var INPUT_SWAPPED = 23;             // SM_SWAPBUTTON
var INPUT_WINDOW = 0xB0;

command("input.down", function (f) {
    var vk;
    if (f.button !== undefined) {
        vk = INPUT_BUTTON_KEYS[parseInt(f.button, 10)];
    } else {
        vk = parseInt(f.vk, 10);
    }
    if (vk === undefined || isNaN(vk) || vk < 1 || vk > 0xFE) {
        throw new Error("No key " + (f.vk || f.button) + ".");
    }
    var n = inputNatives();
    if ((vk === 1 || vk === 2) && f.button !== undefined && n.metric(INPUT_SWAPPED) !== 0) {
        vk = 3 - vk;
    }
    var driver = ptr(VA.dxDriver).readPointer();
    if (driver.isNull() || !n.foreground().equals(driver.add(INPUT_WINDOW).readPointer())) {
        return { down: 0, focused: 0 };
    }
    return { down: n.asyncState(vk) < 0 ? 1 : 0, focused: 1 };
});

var INPUT_MOUSE_X = 0x04;

// The mouse object's point, which the game draws its cursor at and moves on
// every WM_MOUSEMOVE: back-buffer pixels, like a layer's position.
command("input.cursor", function () {
    var mouse = ptr(VA.mouse).readPointer();
    if (mouse.isNull()) {
        return {};
    }
    return { x: mouse.add(INPUT_MOUSE_X).readS32(), y: mouse.add(INPUT_MOUSE_X + 4).readS32() };
});
