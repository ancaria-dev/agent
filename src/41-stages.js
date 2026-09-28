// The game's loading stages, where the loader starts mods.  Each point below
// either holds the thread that reached it until the loader has started the
// mods of that stage (stage()), or only tells the loader (stageNotice()).
// Which game functions mark which stage, and why there, is in mappings
// (rows loadProgress, loadingBar, worldBuild, engineBuild, engineDestroy,
// loadGame) and in research's FINDINGS ("Стадии загрузки игры и мира").
//
//   Game:*        initApp's progress calls, on the main thread, once per run.
//                 Each call names the step that STARTS, so entering
//                 "TextureLoader" means the TypeManager is done.
//   Game:Ready    setLoading(0): the bar goes off, the main menu is next.
//   World:Begin   cEngine::cEngine's entry, on the window thread.
//   World:Terrain the world constructor's return: the static world, no hero.
//   World:Ready   cEngine::cEngine's return.
//   PostWorld     the first engine-thread tick after that.  Nothing waits.
//   World:Leave   cEngine destroy's entry: the world still exists.
//   World:Gone    its return.  Nothing waits.
//
// A quickload builds no engine: cEngine::load with flag 0 runs on the engine
// thread.  It counts as leaving one world and building the next, so its entry
// sends Leave, Gone, Begin and Terrain, and its return Ready.  The same holds
// for a save loaded from the menu inside a world: that is this path too.

// The step each progress label starts, and the stage that is then complete.
var STAGE_AFTER = {
    "TextureLoader": "Game:TypeManager",
    "still TextureManager": "Game:TextureLoader",
    "Fonts": "Game:TextureManager",
    "Balancing": "Game:Fonts",
    "Ready": "Game:Balancing"
};

// cUI_Manager draws the loading bar's label from char[32] at +0x34 on its own
// thread while the main thread works; cEngine's loading screen draws char[64]
// at +0x160 on the engine thread while the window thread builds.
var BAR_LABEL = 0x34;
var BAR_LABEL_SIZE = 32;
var SCREEN_LABEL = 0x160;
var SCREEN_LABEL_SIZE = 64;

// The engine being built, from its constructor's entry to its return.
var stageBuilding = null;
var stageQuickload = false;
var stagePostWorld = false;
var stageInWorld = false;

function stageLabelOf(obj, offset, size) {
    return live(obj) ? { at: obj.add(offset), size: size } : null;
}

function stageAt(point, label) {
    if (label === null) {
        stage(point, {});
    } else {
        stage(point, {}, label.at, label.size);
    }
}

hook("loadProgress", RVA.loadProgress, {
    onEnter: function (args) {
        // To the NUL: the labels are the game's own string constants.  A size
        // here is not a limit but a length, and read the bytes after the NUL
        // as well, so no label ever matched.
        var text = null;
        try {
            text = args[1].readCString();
        } catch (e) {
            return;
        }
        var point = STAGE_AFTER[text];
        if (point !== undefined) {
            stageAt(point, stageLabelOf(snapPtr(this.context.ecx), BAR_LABEL, BAR_LABEL_SIZE));
        }
    }
});

hook("loadingBar", RVA.loadingBar, {
    onEnter: function (args) {
        if ((args[0].toUInt32() & 0xFF) === 0) {
            stageAt("Game:Ready", stageLabelOf(snapPtr(this.context.ecx), BAR_LABEL, BAR_LABEL_SIZE));
        }
    }
});

hook("engineBuild", RVA.engineBuild, {
    onEnter: function () {
        stageBuilding = snapPtr(this.context.ecx);
        stagePostWorld = false;
        stageInWorld = true;
        // The engine thread starts later in the constructor, so nothing draws
        // a label yet.
        stage("World:Begin", {});
    },
    onLeave: function () {
        var built = stageBuilding;
        stageBuilding = null;
        stageAt("World:Ready", stageLabelOf(built, SCREEN_LABEL, SCREEN_LABEL_SIZE));
        stagePostWorld = true;
    }
});

hook("worldBuild", RVA.worldBuild, {
    onLeave: function () {
        stageAt("World:Terrain", stageLabelOf(stageBuilding, SCREEN_LABEL, SCREEN_LABEL_SIZE));
    }
});

hook("stageQuickload", RVA.loadGame, {
    onEnter: function (args) {
        // Flag 1 is the constructor's own load, part of a build.
        stageQuickload = stageBuilding === null && args[1].toInt32() === 0 && stageInWorld;
        // Terrain here, before the load, as a build reaches it before its own
        // load: the save's hero and objects arrive after it either way, so a
        // World:Terrain mod hears the new hero's events on both paths.  The
        // static world is the same one; only what stands in it is replaced.
        if (stageQuickload) {
            stagePostWorld = false;
            stage("World:Leave", {});
            stageNotice("World:Gone", {});
            stage("World:Begin", {});
            stage("World:Terrain", {});
        }
    },
    onLeave: function () {
        if (stageQuickload) {
            stageQuickload = false;
            stage("World:Ready", {});
            stagePostWorld = true;
        }
    }
});

hook("engineDestroy", RVA.engineDestroy, {
    onEnter: function () {
        stagePostWorld = false;
        if (stageInWorld) {
            stage("World:Leave", {});
        }
    },
    onLeave: function () {
        if (stageInWorld) {
            stageInWorld = false;
            stageNotice("World:Gone", {});
        }
    }
});

// The world runs once the engine thread ticks with the hero in it.
onTick(function () {
    if (!stagePostWorld || !live(heroFull) ||
            Process.getCurrentThreadId() !== ptr(VA.engineThread).readU32()) {
        return;
    }
    stagePostWorld = false;
    stageNotice("PostWorld", {});
});

// Attached to a game that is already past some stages: the loader starts
// those mods late, without holding anything.
(function () {
    var types = !ptr(VA.itemTypes).readPointer().isNull();
    var engine = !ptr(VA.engine).readPointer().isNull();
    if (types) {
        stageInWorld = engine;
        // The first tick with the hero sends PostWorld, as after a build.
        stagePostWorld = engine;
        stageNotice("Attach", { types: true, engine: engine });
    }
})();
