// Buying from and selling to NPC merchants.
//
// Every merchant payment goes through AddGold, whose entry the gold module
// already hooks, so trade needs no mid-function site of its own: a second
// listener on the same entry tells the three merchant calls apart by where
// AddGold will return to.  Those call sites come from mappings like every
// other address; the return address is the call plus its five bytes.
//
// The price is the delta as the game computed it, before any Gold listener
// changed it: listeners on one address run in the order they were attached,
// and this module loads before the gold module for exactly that reason.  The item comes from the registers each caller leaves behind at
// the call, or, for a purchase, from the buy function's own argument.

var TRADE_BUY = at(RVA.buyGold).add(5);
var TRADE_SELL = at(RVA.sellGold).add(5);
var TRADE_QUICK = at(RVA.quickSellGold).add(5);

// thiscall(merchandise)(int buyerRef, int itemRef, bool).  The payment happens
// inside, so the item is remembered here and reported when it does.
var tradeBuying = 0;

hook("buyItem", RVA.buyItem, {
    onEnter: function (args) {
        try {
            tradeBuying = args[1].toUInt32() >>> 0;
        } catch (e) {
            tradeBuying = 0;
        }
    },
    onLeave: function () {
        tradeBuying = 0;
    }
});

function tradeItem(ref) {
    var obj = objectByRef(ref);
    if (obj === null) {
        return { ref: ref };
    }
    try {
        var type = obj.add(0x10).readU32() >>> 0;
        return { ref: ref, type: type, name: typeName(type) };
    } catch (e) {
        return { ref: ref };
    }
}

hook("tradeGold", RVA.goldDelta, {
    onEnter: function (args) {
        var from = this.returnAddress;
        var kind = null;
        var ref = 0;
        try {
            if (from.equals(TRADE_BUY)) {
                kind = "buy";
                ref = tradeBuying;
            } else if (from.equals(TRADE_SELL)) {
                kind = "sell";
                ref = this.context.esi.add(0x3E0).readU32() >>> 0;
            } else if (from.equals(TRADE_QUICK)) {
                kind = "sell";
                ref = this.context.ebp.toUInt32() >>> 0;
            } else {
                return;
            }
        } catch (e) {
            return;
        }
        var fields = tradeItem(ref);
        fields.price = Math.abs(args[0].toInt32());
        fields.quick = from.equals(TRADE_QUICK) ? 1 : 0;
        evt("trade." + kind, fields);
    }
});
