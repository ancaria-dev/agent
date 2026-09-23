// Quests, as the script interpreter starts and ends them.
//
// The script engine runs a command at a time through one dispatcher, and the
// quest commands have handlers of their own: TriggerQuest (0x14) starts one,
// ExitQuest (0x0F) and LoseQuest (0x36) share the handler that ends one.  Both
// hooks are on entries, once per quest command, never per frame.
//
// A quest is known by its number, the one the quest files use.  The game keeps
// its quests in a table of 0x124-byte records with the number at +0.  No name
// is read: titles are localized text the quest files point at, and that link
// has not been mapped.

var QUEST_SIZE = 0x124;
var SCRIPT_INT = 0x0B;
var SCRIPT_VARIABLE = 0xFFED2979;

// thiscall(interp)(record*, ctx).  The quest number is the first token of the
// record, an int32 after the 0x0B tag at +4.  A variable instead of a literal
// is flagged by a magic value there; that case is reported as -1 rather than
// resolved, because resolving it means reimplementing the interpreter.
hook("questStart", RVA.questStart, {
    onEnter: function (args) {
        try {
            var record = args[0];
            var number = -1;
            if (record.add(4).readU8() === SCRIPT_INT) {
                var raw = record.add(5).readU32() >>> 0;
                number = raw === SCRIPT_VARIABLE ? -1 : raw | 0;
            }
            evt("quest.start", { number: number });
        } catch (e) {}
    }
});

// thiscall(interp)(int index, ctx, bool flag).  flag is 1 from ExitQuest and 0
// from LoseQuest; which of the two is the solved one is sent raw until it has
// been watched in play.
hook("questEnd", RVA.questEnd, {
    onEnter: function (args) {
        try {
            var index = args[0].toInt32();
            var table = ptr(VA.questTable).readPointer();
            var number = table.isNull() || index < 0
                ? -1
                : table.add(index * QUEST_SIZE).readS32();
            evt("quest.end", {
                number: number, index: index, flag: args[2].toUInt32() & 0xFF
            });
        } catch (e) {}
    }
});
