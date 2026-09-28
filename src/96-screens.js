// Windows: the menus, and the world's own (inventory, merchant, journal, map).
//
// Every window opens and closes the same way.  A UI event (cEventUI2) names
// it in [ev+0x48], id 0x11 shows, 0x12 hides, 0x13 toggles, and the window
// whose name at [window+0x30] matches calls its onShow(bool).  Each move is
// reported in two halves:
//
//   "ui.show" / "ui.hide"      asked before the game acts; a veto keeps the
//                              window as it was.  Only where SCREEN_ASKS says
//                              the game can still refuse, so the API has a
//                              deciding class for exactly those moves.
//   "ui.shown" / "ui.hidden"   the fact, from onShow, for every move however
//                              it came about.  This is the one that lines up
//                              with the rest of the game's events.
//
// Three hooks do it:
//
//   uiEvent     cUI_Manager::receive_event, the funnel.  The kernel delivers
//               here and the manager's own hotkeys (journal, world map) call it
//               directly, so this is where a world window's move is asked
//               about.  A veto rewrites the id to one nothing handles for the
//               call.  Never a menu's: Options' Cancel and the hero select's
//               Back send their pair straight from their own code, one event at
//               a time, and a refused half is a black screen.
//   uiCommand   a menu button.  One click is a pair, show the next window and
//               hide this one, and vetoing half of it leaves a black screen, so
//               the whole click is asked about here and refused as a whole.
//   windowShow  the base onShow, which says what really happened.
//
// Only real windows are reported.  Tooltips run onShow constantly, the minimap
// is shown again thirty times a second, the inventory's two side panels arrive
// with it, and the hero select shows a 3D panel per slot; none of that is a
// screen anyone asked for.  The horse window has its own onShow that skips the
// base one, so it cannot be tracked here.  The portal list is a mode of the
// yes/no dialog, DEFAULT_BUSYDLG, and is reported with that mode.
//
// Quit, and leaving the world for the menu, are asked as "ui.quit", travel
// through a portal as "ui.portal" and reported as "ui.portal_used", and
// starting the game from the hero select is asked as "hero.chosen".  Entering
// and leaving the world are reported as "game.start" and "game.stop".

var SCREEN_SHOW = 0x11;
var SCREEN_HIDE = 0x12;
var SCREEN_TOGGLE = 0x13;
var SCREEN_PAGE = 0x37;            // the main menu's sub-pages; [ev+0xC] is the page
var SCREEN_NOTHING = 0x7FFF;       // an id no window handles
var SCREEN_MULTIPLAYER_PAGE = 1;
var SCREEN_MAIN_MENU = "UI_MAINMENU";
var SCREEN_HERO_SELECT = "UI_CHARACTER";
var SCREEN_DIALOG = "DEFAULT_BUSYDLG";
var SCREEN_DIALOG_MODE = 0x154;
var SCREEN_PORTALS = 5;            // the dialog's mode while it lists Ancaria's portals
var SCREEN_PORTALS_UW = 6;         // and while it lists the Underworld's

// Which moves the game can still refuse, as [show, hide], each one seen asked
// and refused in the game.  A window missing here is asked both ways.  The API
// has a deciding class for exactly these, so keep the two in step.
var SCREEN_ASKS = {
    "UI_MAINMENU": [false, true],
    "UI_WND_OPTIONS": [true, false],
    "UI_CHARACTER": [true, false],
    "UI_WND_SAVEGAME": [true, false],
    "UI_WND_ESCMENU": [true, true],
    "UI_WND_INVENTORY": [true, true],
    "UI_WND_MERCHANT": [true, true],
    "UI_WND_BLACKSMITH": [true, true],
    "UI_WND_MASTER": [true, true],
    "UI_WND_CHEST": [false, true],
    "UI_WND_CUBE": [false, false],
    "UI_WND_MEGAMAP": [true, false],
    "UI_WND_QUESTBOOK": [true, true],
    "UI_WND_CONSOLE": [true, true]
};

// Only a button can refuse these, because only a button's pair is seen whole.
var SCREEN_MENUS = [SCREEN_MAIN_MENU, SCREEN_HERO_SELECT, "UI_WND_OPTIONS", "UI_WND_SAVEGAME"];

var SCREEN_IGNORED = [
    "UI_WND_TOOLTIP", "UI_WND_OVERVIEWMAP", "UI_WND_TASKBAR", "UI_WND_NETPORTRAIT",
    "UI_WND_STATS_CHAR", "UI_WND_EQUIPMENT", "UI_WND_TEXTLINES", "UI_WND_HORSE",
    "UI_WND_GRANNY"
];

// What onShow last said about each window.  Unknown means hidden: a close for
// a window never seen open is the world load tidying up, not a screen closing.
var screenVisible = {};
// Running button commands and armaPlay or armaStop, as calls (see callOpen):
// a window moved inside one is not asked about on its own.  Inside armaPlay or
// armaStop the world is already coming or going, and a refused window would be
// left over it.  A command's data is its main menu pages, reported once it is
// over.
var screenOuter = [];
// Vetoed events, their calls holding { ev, id } until receive_event's
// epilogue puts the id back.
var screenVetoes = [];
// Portal travels in progress, their calls holding the portal's id.
var screenPortals = [];
var screenPage = 0;
var screenUi2 = null;
// A command with nothing in it: its loop runs zero times.
var screenEmptyCommand = null;

function screenReported(name) {
    return (name === SCREEN_MAIN_MENU || name === SCREEN_HERO_SELECT ||
            name.indexOf("UI_WND_") === 0) && SCREEN_IGNORED.indexOf(name) < 0;
}

function screenAskable(change) {
    if (change.multiplayer) {
        return true;
    }
    var asks = SCREEN_ASKS[change.name];
    return asks === undefined || asks[change.open ? 0 : 1];
}

function screenIsUiEvent(ev) {
    if (screenUi2 === null) {
        screenUi2 = ptr(VA.eventUi2);
    }
    try {
        return ev.readPointer().equals(screenUi2);
    } catch (e) {
        return false;
    }
}

function screenFields(name, open) {
    var fields = { window: name };
    if (name === SCREEN_HERO_SELECT && open) {
        try {
            fields.campaign = ptr(VA.campaign).readU16();
        } catch (e) {}
    }
    return fields;
}

// What an event would change, or null when it changes nothing reported.  A
// button's own window is visible even when its onShow came before the agent
// did, so inside a command a close of an unknown window counts.
function screenChange(ev, inCommand) {
    var id = ev.add(4).readU32();
    if (id === SCREEN_PAGE) {
        if (ev.add(8).readU32() !== 1) {
            return null;
        }
        var page = ev.add(0xC).readU32();
        var multiplayer = page === SCREEN_MULTIPLAYER_PAGE;
        if (multiplayer === (screenPage === SCREEN_MULTIPLAYER_PAGE)) {
            return { page: page };
        }
        return { name: SCREEN_MAIN_MENU, page: page, multiplayer: true, open: multiplayer };
    }
    if (id !== SCREEN_SHOW && id !== SCREEN_HIDE && id !== SCREEN_TOGGLE) {
        return null;
    }
    var name = ev.add(0x48).readCString();
    if (!name || !screenReported(name)) {
        return null;
    }
    var known = screenVisible[name];
    var visible = known === undefined ? inCommand && id === SCREEN_HIDE : known;
    var open = id === SCREEN_SHOW ? true : id === SCREEN_HIDE ? false : !visible;
    return open === visible ? null : { name: name, open: open };
}

// No onLeave here: with one, spending a skill point crashed the game in the
// next onLeave on the thread, the way a call left by an exception does (see
// callOpen).  A vetoed id is put back in the
// epilogue below, which an exception simply skips.
hook("uiEvent", RVA.uiEvent, {
    onEnter: function (args) {
        callSweep(screenVetoes);
        // A button's events were decided as one click; see uiCommand.
        if (callInside(screenOuter, this.context)) {
            return;
        }
        var ev = args[0];
        if (!screenIsUiEvent(ev)) {
            return;
        }
        var change;
        try {
            change = screenChange(ev, false);
        } catch (e) {
            return;
        }
        if (change === null || change.name === undefined || change.multiplayer ||
                SCREEN_MENUS.indexOf(change.name) >= 0 || !screenAskable(change)) {
            return;
        }
        var verdict = ask(change.open ? "ui.show" : "ui.hide",
                          screenFields(change.name, change.open));
        if (verdict.cancel) {
            callOpen(screenVetoes, this.context, { ev: ev, id: ev.add(4).readU32() });
            ev.add(4).writeU32(SCREEN_NOTHING);
        }
    }
});

// receive_event's one epilogue: three pops, `add esp, 0x3E4`, `ret 4`.  Here
// ESP is the entry's minus 0x3F0, which names the call a veto was made in.
var SCREEN_EVENT_FRAME = 0x3F0;

hook("uiEventReturn", RVA.uiEventReturn, function () {
    if (screenVetoes.length === 0) {
        return;
    }
    var tid = Process.getCurrentThreadId();
    var entry = this.context.esp.add(SCREEN_EVENT_FRAME);
    for (var i = 0; i < screenVetoes.length; i++) {
        var call = screenVetoes[i];
        if (call.tid === tid && call.at.equals(entry)) {
            screenVetoes.splice(i, 1);
            try {
                call.data.ev.add(4).writeU32(call.data.id);
            } catch (e) {}
            return;
        }
    }
});

hook("uiCommand", RVA.uiCommand, {
    onEnter: function () {
        var call = callOpen(screenOuter, this.context, []);
        var cmd = this.context.ecx;
        var changes = [];
        var page = null;
        try {
            var end = cmd.add(8).readPointer();
            for (var slot = cmd.add(4).readPointer(); slot.compare(end) < 0; slot = slot.add(4)) {
                var ev = slot.readPointer();
                if (!screenIsUiEvent(ev)) {
                    continue;
                }
                var change = screenChange(ev, true);
                if (change === null) {
                    continue;
                }
                if (change.page !== undefined) {
                    page = change.page;
                }
                if (change.name !== undefined) {
                    changes.push(change);
                }
            }
        } catch (e) {
            return;
        }
        // One click is a transition: the window it opens came from the one it
        // closes.  A page is part of the main menu, so it counts as that.
        var opened = null;
        var closed = null;
        changes.forEach(function (c) {
            if (c.open && opened === null) {
                opened = c.name;
            }
            if (!c.open && closed === null) {
                closed = c.name;
            }
        });
        for (var i = 0; i < changes.length; i++) {
            var c = changes[i];
            if (!screenAskable(c)) {
                continue;
            }
            var fields = screenFields(c.name, c.open);
            if (c.multiplayer) {
                fields.page = SCREEN_MULTIPLAYER_PAGE;
            }
            if (c.open && closed !== null) {
                fields.from = closed;
            }
            if (!c.open && opened !== null) {
                fields.to = opened;
            }
            if (ask(c.open ? "ui.show" : "ui.hide", fields).cancel) {
                if (screenEmptyCommand === null) {
                    screenEmptyCommand = Memory.alloc(16);
                }
                this.context.ecx = screenEmptyCommand;
                return;
            }
        }
        // A page has no onShow of its own, so its end is reported once the
        // click has gone through.
        call.data = changes.filter(function (c) {
            return c.multiplayer;
        });
        if (page !== null) {
            screenPage = page;
        }
    }
});

function screenPagesShown(pages) {
    (pages || []).forEach(function (c) {
        evt(c.open ? "ui.shown" : "ui.hidden",
            { window: SCREEN_MAIN_MENU, page: SCREEN_MULTIPLAYER_PAGE });
    });
}

hook("windowShow", RVA.windowShow, {
    onEnter: function (args) {
        var name;
        try {
            name = this.context.ecx.add(0x30).readCString();
        } catch (e) {
            return;
        }
        if (!name) {
            return;
        }
        var open = (args[0].toUInt32() & 0xFF) !== 0;
        if (name === SCREEN_DIALOG) {
            screenDialogShown(this.context.ecx, open);
            return;
        }
        if (!screenReported(name)) {
            return;
        }
        screenVisible[name] = open;
        if (name === SCREEN_MAIN_MENU && open) {
            // A fresh main menu starts on its first page.
            screenPage = 0;
        }
        evt(open ? "ui.shown" : "ui.hidden", screenFields(name, open));
    }
});

// Only the portal list is a screen; the dialog's other modes are questions.
function screenDialogShown(dialog, open) {
    var mode;
    try {
        mode = dialog.add(SCREEN_DIALOG_MODE).readU32();
    } catch (e) {
        return;
    }
    if (mode === SCREEN_PORTALS || mode === SCREEN_PORTALS_UW) {
        evt(open ? "ui.shown" : "ui.hidden", { window: SCREEN_DIALOG, mode: mode });
    }
}

// The main menu's Quit button posts WM_CLOSE at once, with no dialog.
replaced("exitGame", RVA.exitGame, "void", ["pointer"], function (original) {
    return function (self) {
        if (ask("ui.quit", { to: "desktop" }).cancel) {
            return;
        }
        original(self);
    };
});

// What a dialog does when answered.  5 quits to the desktop (Esc on the main
// menu), 3 leaves the world for the main menu (the esc menu's exit), 4 travels
// through the portal whose id is the second argument, and 6 is an empty case,
// which is what a veto turns any of them into.  The portal's teleport runs
// inside this call, so its end is reported on the way out.
var BUSY_LEAVE_WORLD = 3;
var BUSY_PORTAL = 4;
var BUSY_QUIT = 5;
var BUSY_NOTHING = 6;

hook("busyReact", RVA.busyReact, {
    onEnter: function (args) {
        var reaction = args[0].toInt32();
        var verdict;
        if (reaction === BUSY_QUIT || reaction === BUSY_LEAVE_WORLD) {
            verdict = ask("ui.quit", { to: reaction === BUSY_QUIT ? "desktop" : "menu" });
        } else if (reaction === BUSY_PORTAL) {
            // Only from a portal list; the id means nothing to another mode.
            var listMode;
            try {
                listMode = this.context.ecx.add(SCREEN_DIALOG_MODE).readU32();
            } catch (e) {
                return;
            }
            if (listMode !== SCREEN_PORTALS && listMode !== SCREEN_PORTALS_UW) {
                return;
            }
            var portal = args[1].toInt32();
            verdict = ask("ui.portal", { id: portal, mode: listMode });
            if (!verdict.cancel) {
                callOpen(screenPortals, this.context, portal);
            }
        } else {
            return;
        }
        if (verdict.cancel) {
            args[0] = ptr(BUSY_NOTHING);
        }
    }
});

// What a call left to report once it is over: the pages a command turned, the
// portal a travel went through.  Checked on Frida's thread, which only reads
// the stack slot, because the main menu has no tick.
var SCREEN_SWEEP_MS = 50;

setInterval(function () {
    callSweep(screenOuter, screenPagesShown);
    callSweep(screenPortals, function (portal) {
        evt("ui.portal_used", { id: portal });
    });
}, SCREEN_SWEEP_MS);

// Which portals the hero has opened: a mask on the hero, the one the game
// saves as "portals[%x]".  Bit i is entry i of Ancaria's list, bit 14 + i
// entry i of the Underworld's.  Bits 13 and 27 are the Isle of Refuge, which
// the list offers only in a network game: it sets both there (with bit 31)
// and clears them in single player, whatever the mask says.
var PORTAL_MASK = 0x578;
var PORTAL_BITS = 28;
var portalUnlockFn = null;

function portalMask() {
    return heroFull.add(PORTAL_MASK).readU32() >>> 0;
}

command("world.portals", function () {
    if (!live(heroFull)) {
        throw new Error("No world loaded.");
    }
    return { mask: portalMask() };
});

// Opening goes through the game's own unlock, the one the Teleporter script
// command calls, which ORs a whole mask in one call; the game has none for
// closing, so that clears the bits.  Either one id or a mask of them.
command("world.portal_set", function (f) {
    var mask;
    if (f.mask !== undefined) {
        mask = parseInt(f.mask, 10) >>> 0;
    } else {
        var id = parseInt(f.id, 10);
        if (isNaN(id) || id < 0 || id >= PORTAL_BITS) {
            throw new Error("No portal " + f.id + ". Use 0..27.");
        }
        mask = (1 << id) >>> 0;
    }
    mask = (mask & ((1 << PORTAL_BITS) - 1)) >>> 0;
    if (!live(heroFull) || isLoading()) {
        throw new Error("No world loaded.");
    }
    var open = f.open === "1" || f.open === "true";
    if (!later(function () {
        if (open) {
            if (portalUnlockFn === null) {
                portalUnlockFn = new NativeFunction(at(RVA.portalUnlock), "void",
                                                    ["pointer", "uint32", "int"],
                                                    { abi: "thiscall" });
            }
            portalUnlockFn(heroFull, mask, 0);
        } else {
            heroFull.add(PORTAL_MASK).writeU32((portalMask() & ~mask) >>> 0);
        }
    })) {
        throw new Error("Too many game calls waiting.");
    }
    return { mask: mask, open: open ? 1 : 0 };
});

// A portal opened or closed, whoever did it: walking up to it, a quest, a
// mod.  One read a frame; the mask a save brings is not a change.
var portalLast = null;

onSample(SAMPLE_FREQUENT, ["ui.portal_opened", "ui.portal_closed"], function () {
    if (isLoading() || !live(heroFull)) {
        portalLast = null;
        return;
    }
    var now;
    try {
        now = portalMask();
    } catch (e) {
        return;
    }
    var before = portalLast;
    portalLast = now;
    if (before === null || before === now) {
        return;
    }
    for (var id = 0; id < PORTAL_BITS; id++) {
        var bit = (1 << id) >>> 0;
        if ((now & bit) !== (before & bit)) {
            evt((now & bit) ? "ui.portal_opened" : "ui.portal_closed", { id: id });
        }
    }
});

onHero(function () {
    portalLast = null;
});

hook("gameStart", RVA.gameStart, function () {
    callOpen(screenOuter, this.context, null);
    evt("game.start", {});
});

hook("gameStop", RVA.gameStop, function () {
    callOpen(screenOuter, this.context, null);
    evt("game.stop", {});
});

// The hero select's start.  Action 1 starts a new hero and 7 one that already
// exists (an import); a number past the switch, 0xC, returns at once, which is
// the veto.  The class is read off the chosen slot's panel, and the difficulty
// through the game's own list getter, because the game only stores it after
// this has decided to go ahead.  The campaign is still the one whose button
// opened the hero select.
var HERO_NEW = 1;
var HERO_IMPORT = 7;
var HERO_NOTHING = 0xC;
var heroListValue = null;

function heroChoice(select, action) {
    var fields = { imported: action === HERO_IMPORT ? 1 : 0 };
    var slot = select.add(0x1D6).readS8();
    fields.slot = slot;
    if (slot >= 0) {
        var panel = select.add(0x1B4 + 4 * slot).readPointer();
        if (!panel.isNull()) {
            fields.cls = panel.add(0x2F8).readU32();
        }
    }
    var list = select.add(0x300).readPointer();
    if (!list.isNull()) {
        if (heroListValue === null) {
            heroListValue = new NativeFunction(at(RVA.listSelected), "uint16", ["pointer"],
                                               { abi: "thiscall" });
        }
        fields.difficulty = heroListValue(list);
    }
    fields.campaign = ptr(VA.campaign).readU16();
    return fields;
}

hook("heroAction", RVA.heroAction, {
    onEnter: function (args) {
        var action = args[0].toInt32();
        if (action !== HERO_NEW && action !== HERO_IMPORT) {
            return;
        }
        var fields;
        try {
            fields = heroChoice(this.context.ecx, action);
        } catch (e) {
            return;
        }
        if (ask("hero.chosen", fields).cancel) {
            args[0] = ptr(HERO_NOTHING);
        }
    }
});

// Opening and closing a window for a mod, the way the player's key does it:
// the same UI event the game builds for that key or click, sent the same way.
// The inventory's keys I, F and C are one event with the tab in [ev+0xC]; the
// map's and the journal's keys go to the UI manager, the console's comes from
// the engine, and Esc names itself as the sender.  A merchant, a blacksmith
// and a combat master open from a creature the way talking to it does: the
// inventory, the window, then the window's setup event with the creature's
// level and ref.  The hero's own chest, the one with a window, opens from the
// two messages the hero's click sends it: 0x21 lifts the lid, 3 with "take"
// shows its window beside the inventory.  Any other chest or barrel answers
// the same two by dropping its loot, so only the hero's chest is taken here.
// Closing any of those four is Esc's way: the inventory closes, and takes
// them with it.
//
// Everything is sent from the engine thread (commandOnEngine), the one the
// game handles its keys on.  The esc menu's opening pauses the game through a
// path that raises and handles its own exception, so every call into the game
// here propagates exceptions; without that the menu was left flagged open,
// unseen, and the game paused.  A call made from the tick is invisible to the
// hooks above, so a
// mod's own move is not asked about, and its halves are reported here: the
// manager's window list is read before and after, and every reported window
// whose visibility changed gets its "ui.shown" or "ui.hidden".
//
//   ui.windows          which reported windows are open, and the inventory tab
//   ui.open / ui.close  window, plus tab (inventory) or ref (the four above)
//   ui.toggle           window, plus tab: the key's own behaviour

var SCREEN_FLAG_KEY = 5;            // [ev+8] from a key or a button
var SCREEN_FLAG_ESC = 1;            // and from the Esc key
var SCREEN_FLAG_ITEM = 1;           // and from a click on an item
var SCREEN_FLAG_TASKBAR = 0x10;     // a taskbar button's state
var SCREEN_EVENT_SIZE = 0x80;
var SCREEN_FROM = 0x28;
var SCREEN_TO = 0x48;
var SCREEN_TEXT_MAX = 31;
var SCREEN_WINDOWS_FIRST = 0x80;    // the manager's window pointers, +0x80..+0xD8
var SCREEN_WINDOWS_LAST = 0xD8;
var SCREEN_VISIBLE = 0x10;
var SCREEN_NAME = 0x30;
var SCREEN_TABS = 0x154;            // cUI_Inventory3's tab control
var SCREEN_TABS_MAX = 3;
var SCREEN_RECEIVE_SLOT = 4;        // cUI_Control2::receive_event in every window's vtable
var SCREEN_INVENTORY = "UI_WND_INVENTORY";
var SCREEN_TASKBAR = "UI_WND_TASKBAR";
var SCREEN_USE_EVENT = 0x21;        // cEvent_object: the lid opens
var SCREEN_TAKE_EVENT = 3;          // and, with [ev+0x10] = 1, the contents are taken
var SCREEN_USE_SIZE = 0x48;
// The one chest with a window (0x00428760): the hero's own, the same in every
// town.  Every other chest and barrel answers the same message by dropping
// what it holds, which a window must never do.
var SCREEN_STASH_TYPE = 0x1450;
var SCREEN_NPC_FLAGS = 0x200;       // creature flags 2: the roles the hero talks to

// What each window a mod may move needs.  `from` is the sender the game's own
// key writes, `open`/`close` a taskbar button the game sets beside it, `npc`
// the role bit a creature needs and `setup` the id of the event that hands
// the window its creature.
var SCREEN_MOVES = {
    "UI_WND_INVENTORY": { tabs: true },
    "UI_WND_MEGAMAP": {},
    "UI_WND_QUESTBOOK": { close: [SCREEN_HIDE, "UI_TB_BOOK"] },
    "UI_WND_CONSOLE": { from: "<engineevent>" },
    "UI_WND_ESCMENU": { flags: SCREEN_FLAG_ESC, from: "<WindowProc_engine>",
                        open: [SCREEN_SHOW, "UI_TB_OPTIONS"] },
    "UI_WND_MERCHANT": { npc: 0x2000, setup: 0x2E, role: "merchant" },
    "UI_WND_BLACKSMITH": { npc: 0x1000, setup: 0x30, role: "blacksmith" },
    "UI_WND_MASTER": { npc: 0x4000, setup: 0x2F, role: "combat master" },
    "UI_WND_CHEST": { chest: true },
    "UI_WND_CUBE": { flags: SCREEN_FLAG_ITEM }
};

var screenNative = null;

function screenNatives() {
    if (screenNative === null) {
        screenNative = {
            kernel: new NativeFunction(at(RVA.kernelInstance), "pointer", [], { abi: "mscdecl" }),
            // A window may raise and handle its own exception while it opens.
            send: new NativeFunction(at(RVA.kernelSend), "void",
                                     ["pointer", "pointer", "int", "int"],
                                     { abi: "thiscall", exceptions: "propagate" })
        };
    }
    return screenNative;
}

function screenManager() {
    var mgr = ptr(VA.uiManager).readPointer();
    if (mgr.isNull()) {
        throw new Error("The game has no windows yet.");
    }
    return mgr;
}

// The manager's windows by name.
function screenWindows(mgr) {
    var windows = {};
    for (var off = SCREEN_WINDOWS_FIRST; off <= SCREEN_WINDOWS_LAST; off += 4) {
        var w = mgr.add(off).readPointer();
        if (!w.isNull()) {
            var name = w.add(SCREEN_NAME).readCString();
            if (name) {
                windows[name] = w;
            }
        }
    }
    return windows;
}

function screenShowing(w) {
    return w !== undefined && (w.add(SCREEN_VISIBLE).readU32() & 1) !== 0;
}

// The inventory's tab, 1..3 as its keys number them, or 0 while it is shut.
function screenTab(windows) {
    var inv = windows[SCREEN_INVENTORY];
    if (!screenShowing(inv)) {
        return 0;
    }
    var tabs = inv.add(SCREEN_TABS).readPointer();
    if (tabs.isNull()) {
        return 0;
    }
    var list = tabs.add(0x78).readPointer();
    return list.isNull() ? 0 : list.add(0x84).readU16() + 1;
}

// Reported windows that are open, in the manager's order.
function screenOpenNames(windows) {
    var open = [];
    for (var name in windows) {
        if (screenReported(name) && screenShowing(windows[name])) {
            open.push(name);
        }
    }
    return open;
}

function screenZeroed(size) {
    var ev = Memory.alloc(size);
    for (var i = 0; i < size; i += 4) {
        ev.add(i).writeU32(0);
    }
    return ev;
}

// A UI event as the game's keys build it (cEventUI2, see STRUCTURES).
function screenEvent(id, to, flags, param, from) {
    var ev = screenZeroed(SCREEN_EVENT_SIZE);
    ev.writePointer(ptr(VA.eventUi2));
    ev.add(4).writeU32(id);
    ev.add(8).writeU32(flags);
    ev.add(0xC).writeU32(param || 0);
    if (from) {
        ev.add(SCREEN_FROM).writeUtf8String(from.substring(0, SCREEN_TEXT_MAX));
    }
    ev.add(SCREEN_TO).writeUtf8String(to.substring(0, SCREEN_TEXT_MAX));
    return ev;
}

function screenPost(ev) {
    var n = screenNatives();
    var kernel = n.kernel();
    if (kernel.isNull()) {
        throw new Error("The game has no event kernel.");
    }
    n.send(kernel, ev, 0, 0);
}

// A taskbar button's state goes straight to the taskbar, as the game sends it.
function screenTaskbar(windows, button) {
    var bar = windows[SCREEN_TASKBAR];
    if (bar === undefined) {
        return;
    }
    var receive = new NativeFunction(bar.readPointer().add(SCREEN_RECEIVE_SLOT * 4).readPointer(),
                                     "uint8", ["pointer", "pointer"],
                                     { abi: "thiscall", exceptions: "propagate" });
    receive(bar, screenEvent(button[0], button[1], SCREEN_FLAG_TASKBAR, 0, null));
}

// The creature a merchant-like window is opened with, checked the way the
// game checks it before it opens one: the role bit on the creature.
function screenNpc(ref, move) {
    var c = creatureFields(ref);
    if (c === null) {
        throw new Error("No creature at ref " + ref + ".");
    }
    var obj = objectByRef(ref);
    if ((obj.add(SCREEN_NPC_FLAGS).readU32() & move.npc) === 0) {
        throw new Error("The creature at ref " + ref + " is no " + move.role + ".");
    }
    return c;
}

function screenIsChest(ref) {
    var obj = objectByRef(ref);
    return obj !== null && obj.readPointer().equals(ptr(VA.chestVtable)) &&
           obj.add(0x10).readU32() === SCREEN_STASH_TYPE;
}

// The hero's click on a chest, as the player makes it: two messages to it.
function screenUse(ref, id, take) {
    var ev = screenZeroed(SCREEN_USE_SIZE);
    ev.writePointer(ptr(VA.objectEvent));
    ev.add(4).writeU32(id);
    ev.add(8).writeU32(heroFull.add(0x0C).readU32());
    ev.add(0xC).writeU32(ref);
    ev.add(0x10).writeU32(take ? 1 : 0);
    screenPost(ev);
}

function screenOpen(windows, name, move, f) {
    if (move.chest) {
        screenUse(f.ref, SCREEN_USE_EVENT, false);
        screenUse(f.ref, SCREEN_TAKE_EVENT, true);
        return;
    }
    var flags = move.flags || SCREEN_FLAG_KEY;
    if (move.npc) {
        screenPost(screenEvent(SCREEN_SHOW, SCREEN_INVENTORY, SCREEN_FLAG_KEY, 0, null));
        screenPost(screenEvent(SCREEN_SHOW, name, flags, 0, null));
        var setup = screenEvent(move.setup, name, 8, f.level, null);
        setup.add(0x10).writeU32(f.ref);
        screenPost(setup);
        return;
    }
    screenPost(screenEvent(SCREEN_SHOW, name, flags, f.tab, move.from));
    if (move.open) {
        screenTaskbar(windows, move.open);
    }
}

function screenClose(windows, name, move) {
    if (move.npc || move.chest) {
        screenPost(screenEvent(SCREEN_HIDE, SCREEN_INVENTORY, SCREEN_FLAG_KEY, 0, null));
        return;
    }
    screenPost(screenEvent(SCREEN_HIDE, name, move.flags || SCREEN_FLAG_KEY, 0, move.from));
    if (move.close) {
        screenTaskbar(windows, move.close);
    }
}

// Reports what changed between two readings, as the onShow hook would have.
function screenReport(before, windows) {
    for (var name in windows) {
        if (!screenReported(name)) {
            continue;
        }
        var open = screenShowing(windows[name]);
        if (open !== before[name]) {
            screenVisible[name] = open;
            evt(open ? "ui.shown" : "ui.hidden", screenFields(name, open));
        }
    }
}

function screenMove(name, how, f) {
    var move = SCREEN_MOVES[name];
    var windows = screenWindows(screenManager());
    var before = {};
    for (var w in windows) {
        before[w] = screenShowing(windows[w]);
    }
    var showing = before[name] === true;
    var tab = screenTab(windows);
    var open;
    if (how === "toggle") {
        // The inventory's keys close it only from their own tab.
        open = !showing || (move.tabs && f.tab !== 0 && f.tab !== tab);
    } else {
        open = how === "open";
    }
    if (open && (!showing || (move.tabs && f.tab !== 0 && f.tab !== tab))) {
        screenOpen(windows, name, move, f);
    } else if (!open && showing) {
        screenClose(windows, name, move);
    }
    screenReport(before, windows);
    return { window: name, open: screenShowing(windows[name]) ? 1 : 0, tab: screenTab(windows) };
}

// What a move needs, checked on Frida's thread so a wrong call fails at once.
function screenRequest(f, how) {
    var name = f.window === undefined ? "" : String(f.window);
    var move = SCREEN_MOVES[name];
    if (move === undefined) {
        throw new Error("A mod cannot move the window " + name + ".");
    }
    if (!live(heroFull) || isLoading()) {
        throw new Error("No world loaded.");
    }
    var request = { tab: 0, ref: 0, level: 0 };
    if (f.tab !== undefined && f.tab !== "") {
        request.tab = parseInt(f.tab, 10);
        if (!move.tabs || isNaN(request.tab) || request.tab < 1 || request.tab > SCREEN_TABS_MAX) {
            throw new Error("No tab " + f.tab + " on " + name + ".");
        }
    }
    if (how === "open" && (move.npc || move.chest)) {
        request.ref = parseInt(f.ref, 10);
        if (isNaN(request.ref) || request.ref <= 0) {
            throw new Error(name + " opens with the ref of its " +
                            (move.chest ? "chest" : move.role) + ".");
        }
        if (move.chest && !screenIsChest(request.ref)) {
            throw new Error("No hero chest at ref " + f.ref + ".");
        }
        if (move.npc) {
            request.level = screenNpc(request.ref, move).level;
        }
    } else if (how === "toggle" && (move.npc || move.chest)) {
        throw new Error(name + " opens only with a ref.");
    }
    return request;
}

function screenCommand(how) {
    commandOnEngine("ui." + how, function (f) {
        var request = screenRequest(f, how);
        var name = String(f.window);
        var move = SCREEN_MOVES[name];
        return function () {
            if (!live(heroFull)) {
                throw new Error("No world loaded.");
            }
            // A creature or chest the ref named may be gone by now.
            if (request.ref && move.chest && !screenIsChest(request.ref)) {
                throw new Error("No hero chest at ref " + request.ref + ".");
            }
            if (request.ref && move.npc) {
                screenNpc(request.ref, move);
            }
            return screenMove(name, how, request);
        };
    });
}

screenCommand("open");
screenCommand("close");
screenCommand("toggle");

command("ui.windows", function () {
    var mgr = ptr(VA.uiManager).readPointer();
    if (mgr.isNull()) {
        return { open: "", tab: 0 };
    }
    var windows = screenWindows(mgr);
    return { open: screenOpenNames(windows).join(","), tab: screenTab(windows) };
});
