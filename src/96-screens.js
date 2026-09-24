// Windows: the menus, and the world's own (inventory, merchant, journal, map).
//
// Every window opens and closes the same way.  A UI event (cEventUI2) names
// it in [ev+0x48], id 0x11 shows, 0x12 hides, 0x13 toggles, and the window
// whose name at [window+0x30] matches calls its onShow(bool).  Three hooks
// turn that into one event, "ui.screen", with the window's name:
//
//   uiEvent     cUI_Manager::receive_event, the funnel.  The kernel delivers
//               here and the manager's own hotkeys (journal, world map) call it
//               directly, so this is where a world window's open or close is
//               asked about.  A veto rewrites the id to one nothing handles for
//               the call.  Never a menu's: Options' Cancel and the hero
//               select's Back send their pair straight from their own code,
//               one event at a time, and a refused half is a black screen.
//   uiCommand   a menu button.  One click is a pair, show the next window and
//               hide this one, and vetoing half of it leaves a black screen, so
//               the whole click is asked about here and refused as a whole.
//   windowShow  the base onShow, which says what really happened.  A window
//               nobody asked about (the chest opens through an event of its
//               own, the main menu reappears after the world) is reported here,
//               after the fact, and cannot be refused.
//
// Only real windows are reported.  Tooltips run onShow constantly, the minimap
// is shown again thirty times a second, the inventory's two side panels arrive
// with it, and the hero select shows a 3D panel per slot; none of that is a
// screen anyone asked for.  The horse window has its own onShow that skips the
// base one, so it cannot be tracked here.  The portal list is a mode of the
// yes/no dialog, DEFAULT_BUSYDLG, and is reported with that mode.
//
// Quit, and leaving the world for the menu, are asked as "ui.quit", travel
// through a portal as "ui.portal", and starting the game from the hero select
// as "hero.chosen".  Entering and leaving the world are reported as
// "game.start" and "game.stop".

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
var SCREEN_PORTALS = 5;            // the dialog's mode while it lists portals

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
// Changes a mod has already been asked about, waiting for their onShow.
var screenAnnounced = {};
var screenCommands = 0;
// Inside armaPlay or armaStop the world is already coming or going, and a
// refused window would be left over it.  Those moves are reported, not asked.
var screenSettling = 0;
var screenPage = 0;
var screenUi2 = null;
// A command with nothing in it: its loop runs zero times.
var screenEmptyCommand = null;

function screenReported(name) {
    return (name === SCREEN_MAIN_MENU || name === SCREEN_HERO_SELECT ||
            name.indexOf("UI_WND_") === 0) && SCREEN_IGNORED.indexOf(name) < 0;
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

function screenFields(name, open, cancelable) {
    var fields = { window: name, open: open ? 1 : 0, cancelable: cancelable ? 1 : 0 };
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

hook("uiEvent", RVA.uiEvent, {
    onEnter: function (args) {
        // A button's events were decided as one click; see uiCommand.
        if (screenCommands > 0 || screenSettling > 0) {
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
                SCREEN_MENUS.indexOf(change.name) >= 0) {
            return;
        }
        var verdict = ask("ui.screen", screenFields(change.name, change.open, true));
        if (verdict.cancel) {
            this.vetoed = ev;
            this.id = ev.add(4).readU32();
            ev.add(4).writeU32(SCREEN_NOTHING);
            return;
        }
        screenAnnounced[change.name] = change.open;
    },
    onLeave: function () {
        if (this.vetoed) {
            this.vetoed.add(4).writeU32(this.id);
        }
    }
});

hook("uiCommand", RVA.uiCommand, {
    onEnter: function () {
        screenCommands += 1;
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
            var fields = screenFields(c.name, c.open, true);
            if (c.multiplayer) {
                fields.page = SCREEN_MULTIPLAYER_PAGE;
            }
            if (c.open && closed !== null) {
                fields.from = closed;
            }
            if (!c.open && opened !== null) {
                fields.to = opened;
            }
            if (ask("ui.screen", fields).cancel) {
                if (screenEmptyCommand === null) {
                    screenEmptyCommand = Memory.alloc(16);
                }
                this.context.ecx = screenEmptyCommand;
                return;
            }
        }
        changes.forEach(function (c) {
            if (!c.multiplayer) {
                screenAnnounced[c.name] = c.open;
            }
        });
        if (page !== null) {
            screenPage = page;
        }
    },
    onLeave: function () {
        screenCommands -= 1;
    }
});

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
        if (screenAnnounced[name] === open) {
            delete screenAnnounced[name];
            return;
        }
        delete screenAnnounced[name];
        evt("ui.screen", screenFields(name, open, false));
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
    if (mode === SCREEN_PORTALS) {
        var fields = screenFields(SCREEN_DIALOG, open, false);
        fields.mode = mode;
        evt("ui.screen", fields);
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
// which is what a veto turns any of them into.
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
            // Only from the portal list; the id means nothing to another mode.
            try {
                if (this.context.ecx.add(SCREEN_DIALOG_MODE).readU32() !== SCREEN_PORTALS) {
                    return;
                }
            } catch (e) {
                return;
            }
            verdict = ask("ui.portal", { id: args[1].toInt32() });
        } else {
            return;
        }
        if (verdict.cancel) {
            args[0] = ptr(BUSY_NOTHING);
        }
    }
});

hook("gameStart", RVA.gameStart, {
    onEnter: function () {
        screenSettling += 1;
        evt("game.start", {});
    },
    onLeave: function () {
        screenSettling -= 1;
    }
});

hook("gameStop", RVA.gameStop, {
    onEnter: function () {
        screenSettling += 1;
        evt("game.stop", {});
    },
    onLeave: function () {
        screenSettling -= 1;
    }
});

// The hero select's start.  Action 1 starts a new hero and 7 one that already
// exists (an import); a number past the switch, 0xC, returns at once, which is
// the veto.  The class is read off the chosen slot's panel, and the difficulty
// through the game's own list getter, because the game only stores it after
// this has decided to go ahead.
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
