// Sounds, music and jingles through the game's own sound manager (cMSS), the
// calls the quest script commands PlaySound, PlayMusic and PlayJingle end in.
//
// A name is looked up in the sound table the executable carries (soundByName),
// so no game number crosses the wire.  A sound plays flat or on an object:
// playSFX takes no position, only the ref of the object it follows.  The
// manager plays nothing while the game's window is in the background (it is
// paused then) or with sound off; playSFX answers slot 0xFFFF and the reply
// says played 0.
//
// Every call runs on the engine thread, where sfx_probe.py proved them, and
// with exceptions: "propagate": under playMusic the game raises an exception
// it handles itself, and Frida's default turned every music call into
// "system error".  Nothing is hooked.

var SOUND_NAME_SHAPE = /^SOUND_FX_[A-Za-z0-9_]{1,54}$/;
var SOUND_NO_SLOT = 0xFFFF;
// The arguments the game's own calls pass: playSFX(id, 0, 0.5, 0.5, on an
// object, ref, 1.0, loop, 0), the script's playMusic(id, 0, 1) and
// playJingle(id, 1, 1).
var SOUND_HALF = 0.5;
var SOUND_FULL = 1.0;

var soundNative = null;
// The loops this agent started: slot -> the hero of the world they play in.
// A slot is stopped only while it still holds the loop, so a stop after the
// world changed cannot cut off a sound of the game's.
var soundLoops = {};

function soundFns() {
    if (soundNative === null) {
        var opts = { abi: "thiscall", exceptions: "propagate" };
        soundNative = {
            byName: new NativeFunction(at(RVA.soundByName), "int", ["pointer"],
                                       { abi: "mscdecl", exceptions: "propagate" }),
            manager: new NativeFunction(at(RVA.soundManager), "pointer", [],
                                        { abi: "mscdecl", exceptions: "propagate" }),
            play: new NativeFunction(at(RVA.soundPlay), "uint32",
                                     ["pointer", "int", "int", "float", "float", "int", "int", "float",
                                      "int", "int"], opts),
            stop: new NativeFunction(at(RVA.soundStop), "void", ["pointer", "int"], opts),
            music: new NativeFunction(at(RVA.musicPlay), "uint32", ["pointer", "int", "int", "int"], opts),
            jingle: new NativeFunction(at(RVA.jinglePlay), "uint32", ["pointer", "int", "int", "int"], opts)
        };
    }
    return soundNative;
}

// The fields' name, checked here on Frida's thread so a bad one fails at once.
function soundName(f) {
    var name = String(f.name === undefined ? "" : f.name);
    if (!SOUND_NAME_SHAPE.test(name)) {
        throw new Error("No sound name " + name + ". Names start SOUND_FX_.");
    }
    return name;
}

function soundId(name) {
    var id = soundFns().byName(Memory.allocAnsiString(name));
    if (id === 0) {
        throw new Error("The game has no sound " + name + ".");
    }
    return id;
}

function soundWorld() {
    if (!live(heroFull) || isLoading()) {
        throw new Error("No world loaded.");
    }
    return heroFull;
}

// Fields: name; ref of the object it follows (none: flat); loop 1 to repeat.
// Answers played 0/1 and, for a loop, its slot.
commandOnEngine("world.sound", function (f) {
    var name = soundName(f);
    var ref = f.ref === undefined ? -1 : parseInt(f.ref, 10);
    if (isNaN(ref) || (ref !== -1 && ref <= 0)) {
        throw new Error("No object " + f.ref + ".");
    }
    var loop = f.loop === "1" ? 1 : 0;
    var hero = soundWorld();
    return function () {
        if (!same(hero, heroFull)) {
            throw new Error("The world changed before the sound played.");
        }
        if (ref !== -1 && objectByRef(ref) === null) {
            throw new Error("No object " + ref + ".");
        }
        var fns = soundFns();
        var slot = fns.play(fns.manager(), soundId(name), 0, SOUND_HALF, SOUND_HALF, ref === -1 ? 0 : 1,
                            ref, SOUND_FULL, loop, 0) & 0xFFFF;
        if (slot === SOUND_NO_SLOT) {
            return { played: 0 };
        }
        if (loop) {
            soundLoops[slot] = hero;
        }
        return { played: 1, slot: slot };
    };
});

// Fields: slot, from a loop's answer.  Stops it only while this world still
// runs the loop there.
commandOnEngine("world.sound_stop", function (f) {
    var slot = parseInt(f.slot, 10);
    if (isNaN(slot)) {
        throw new Error("No slot given.");
    }
    return function () {
        var hero = soundLoops[slot];
        delete soundLoops[slot];
        if (hero === undefined || !same(hero, heroFull)) {
            return { stopped: 0 };
        }
        var fns = soundFns();
        fns.stop(fns.manager(), slot);
        return { stopped: 1 };
    };
});

// Fields: name, a SOUND_FX_MUSIC_* or another streamed piece.  The game fades
// the playing piece out first; its own music choice replaces this one later.
commandOnEngine("world.music", function (f) {
    var name = soundName(f);
    soundWorld();
    return function () {
        var fns = soundFns();
        return { played: fns.music(fns.manager(), soundId(name), 0, 1) & 0xFF ? 1 : 0 };
    };
});

// Fields: name, a SOUND_FX_JINGLE_*.
commandOnEngine("world.jingle", function (f) {
    var name = soundName(f);
    soundWorld();
    return function () {
        var fns = soundFns();
        return { played: fns.jingle(fns.manager(), soundId(name), 1, 1) & 0xFF ? 1 : 0 };
    };
});
