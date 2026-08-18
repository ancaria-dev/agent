// Gold.  The boost has to happen on the DELTA, before AddGold processes it --
// rewriting the final total makes the game's own anti-cheat checker see a value
// that disagrees with its XOR mirror and reset the field to 1.  That was a real
// bug: gold silently became 0 while the UI still showed the old number.

function xorKey(regionByte) {
    var b = regionByte & 0xFF;
    return (b | (b << 8) | (b << 16) | (b << 24)) >>> 0;
}

// Refresh the mirrors ourselves after we changed a mirrored field.  Key is the
// region byte at full+0x38, broadcast to all four bytes.
// Set when a mod actually changed a gold delta.  Everything below only writes
// game memory while this is true: if nobody boosted anything, AddGold already
// wrote the total and refreshed the mirrors correctly, and there is nothing for
// us to repair.  Touching them anyway is what crashed a fresh character --
// [0x182DDDC] lives on a page the game keeps protected and opens with
// VirtualProtect around its own access, so an uninvited write lands wherever
// that page happens to be at the time.
var goldBoosted = false;

function syncMirrors() {
    if (!live(heroFull)) {
        return;
    }
    try {
        var gold = heroFull.add(0x3EE).readU32() >>> 0;
        var exp = heroFull.add(0x3B4).readU32() >>> 0;
        var level = heroFull.add(0x3FE).readU16();
        var key = xorKey(heroFull.add(0x38).readU8());
        var key2 = (key << 1) >>> 0;
        var m1 = ptr(VA.xorMirror1).readPointer();
        var m2 = ptr(VA.xorMirror2).readPointer();
        if (m1.isNull() || m2.isNull()) {
            return;
        }
        m1.add(0).writeU32((exp ^ key) >>> 0);
        m1.add(4).writeU32((gold ^ key) >>> 0);
        m1.add(8).writeU32((level ^ key) >>> 0);
        m2.add(0).writeU32((exp ^ key2) >>> 0);
        m2.add(4).writeU32((gold ^ key2) >>> 0);
        m2.add(8).writeU32((level ^ key2) >>> 0);
    } catch (e) {
        note("gold mirror sync failed: " + e.message);
    }
}

// The boost happens on AddGold's ARGUMENT, at the function entry.
//
// Four mid-function sites in this one function have now crashed the game on
// world load, and the crash address finally named the damage: 0x005805E9, in
// AddGold's caller 0x005803C0, is `cmp [edx+0xc], eax` with edx = [edi+4].  EDI
// is callee-saved and valid before the call -- the same dereference succeeds at
// the top of that function -- so AddGold was returning with EDI destroyed.  A
// hook that corrupts a saved register is a broken trampoline, not a broken
// boost, which is why turning the boost off never helped.
//
// Which mid-function detail did it is not proven; the last two sites to fail
// were both ESP-relative (`mov eax,[esp+0x94]` here, `mov ecx,[esp+0x84]` at
// the epilogue), which is suspicious but two cases is not a mechanism.
//
// The entry sidesteps the whole question.  It is the case Frida is built for:
// a real return address, and a relocated `mov eax, fs:[0]` that touches neither
// the stack nor the flags.  Nothing is lost by moving -- ECX is still the sheet
// and args[0] is the very same dword as [esp+0x94] was, because the prologue
// pushes exactly 0x90 bytes between them.
hook("goldDelta", RVA.goldDelta, {
    onEnter: function (args) {
        var sheet = this.context.ecx;
        if (!live(heroFull)) {
            noteHeroSheet(sheet);
        }
        if (!isHeroSheet(sheet)) {
            return;
        }
        var delta, current;
        try {
            delta = args[0].toInt32();
            current = sheet.add(0x46).readU32() >>> 0;
        } catch (e) {
            return;
        }
        // One native site covers both directions: positive is loot, negative is
        // a purchase.  Mods almost always care about exactly one of them.
        var verdict = ask("gold.delta", {
            delta: delta, current: current,
            dir: delta < 0 ? "spend" : "gain"
        });
        var next = verdict.cancel ? 0 : asked(verdict, "delta", delta);
        if (next !== delta) {
            args[0] = ptr(next);
            goldBoosted = true;
        }
    }
});

// Everything after the boost happens on the tick instead of on its own hook.
//
// Three sites used to live here -- the write, the sheet/full sync and the
// epilogue -- and each one crashed the game in its own way: the write split a
// `cmp` from its `je`, and the other two sat mid-function on instructions whose
// relocation the trampoline could not be trusted with (one of them reads the
// stack through ESP).  None of them had to be a hook: the total is a number
// that can be read a moment later, and the anti-cheat checker runs on a timer,
// so being a few milliseconds late costs nothing.
var lastGold = -1;

onTick(function () {
    if (!live(heroFull) || !live(heroSheet)) {
        return;
    }
    var now;
    try {
        now = heroFull.add(0x3EE).readU32() >>> 0;
    } catch (e) {
        return;
    }

    if (goldBoosted) {
        try {
            // AddGold may have written only the sheet copy.
            var onSheet = heroSheet.add(0x46).readU32() >>> 0;
            if (onSheet !== now) {
                heroFull.add(0x3EE).writeU32(onSheet);
                now = onSheet;
            }
        } catch (e) {}
        syncMirrors();
        goldBoosted = false;
    }

    if (now !== lastGold) {
        evt("gold.changed", {
            next: now,
            delta: lastGold < 0 ? 0 : now - lastGold
        });
        lastGold = now;
    }
});
