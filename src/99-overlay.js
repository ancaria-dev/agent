// Layers: pictures a mod draws in Java, shown in the game's own frame.
//
// A mod renders into a pixel buffer in the JVM, a 64-bit process that cannot
// touch the game's Direct3D.  The buffer crosses in a file both processes map
// (Java's FileChannel.map and CreateFileMapping here give views of the same
// pages).  One file per layer, made by zygote:
//
//   +0   'ALYR'       +4  version 2   +8  width     +12 height
//   +16  seq          the frames Java has published; 0 = none yet
//   +20  front        which of the two buffers holds frame seq
//   +24  reading      the frame this side is copying now, 0 when idle
//   +28  ack          the last frame this side copied
//   +32  x  +36 y     where, in the back buffer's pixels
//   +40  z            order among layers, higher on top
//   +44  flags        1 visible, 2 takes the mouse, 4 the world plane,
//                     8 hides the game's cursor over it
//   +48  focus        nonzero while the layer holds the keyboard; Java sets
//                     it, this side clears it when the focus goes
//   +52  input alpha  a press is the layer's only where the alpha of its
//                     newest picture is above this; -1 counts the rectangle
//   +64  changed      per buffer, x, y, width, height of what differs from
//                     the frame before it: buffer 0 at +64, buffer 1 at +80
//   +128 two buffers of width * height premultiplied ARGB, 32 bits a pixel
//
// Version 1, from a zygote older than this agent, has a 64-byte header, no
// input alpha and no changed rectangles: every copy is whole and the whole
// rectangle takes the mouse.
//
// Java writes the buffer that is not front and then publishes; it waits only
// while this side is still copying the frame before, which takes
// microseconds.  This side sets reading, checks seq is still that frame and
// copies it, so a frame published meanwhile is taken whole on the next pass.
// The game never waits for Java: without a new frame the last one shows.
// Only the changed rectangle is copied, and the whole frame when the texture
// does not hold the frame before (a new or restored texture, a frame missed).
//
// The copy goes into a managed Direct3D 7 texture, drawn as one alpha-blended
// quad.  A layer of the top plane is drawn at cEngine's cursor draw, pass 1
// (0x00612160): above the world and every window, under the cursor; the
// menu thread's frames have no such pass, so there it is drawn as the cursor
// is (mouse::draw, 0x006559D0), under it again.  A layer of the world plane
// is drawn as cUI_Manager::render begins (0x00758BC0): above the world,
// under the HUD and every window, which the manager draws together.  A frame
// without these (the load screen, a video) draws the layers at flip in a
// scene of its own.  The texture is sampled bilinearly: a wrapper may render the
// frame at another size than the back buffer (dgVoodoo's forced resolution
// drew it at 2560x1600 for a 1920x1080 window), and point sampling then broke
// small text into steps.  The device calls are C in a CModule: TinyCC does not honour
// stdcall on a function pointer, so every COM call goes through a thunk that
// keeps ESP in EDI, and CModule globals cannot be written here, so all state
// lives in memory this script allocates.
//
// The mouse: 93-input.js asks overlayPointer before the game sees a button
// or the wheel.  A press on a visible layer that takes the mouse, at a pixel
// of its newest picture whose alpha is above the layer's input alpha, is the
// layer's, and so is everything up to that button's release; a press on a
// transparent pixel goes to the game.  Moves go to the layer under the cursor
// by the same rule and to the game as well, since the game draws the cursor
// from them.  The game's cursor is not drawn while it is over a
// visible layer that hides it: mouse::draw draws nothing without a shape, so
// the shape is cleared for that call and put back after it.
//
// The keyboard: a visible layer with its focus field set holds it, and
// 93-input.js hands it every key and character instead of the game.  The
// focus goes on Esc (the layer still hears that key), on a press anywhere
// but that layer, when the layer hides or closes, and when the game's window
// loses the focus.  Java sets the field; this side clears it and reports it.
//
//   "layer.press" / "layer.release" / "layer.click"   layer, x, y, button
//   "layer.move"                                      layer, x, y
//   "layer.wheel"                                     layer, x, y, delta
//   "layer.leave"                                     layer
//   "layer.focus_lost"                                layer
//   (the keys themselves are sent by 93-input.js)
//
//   overlay.add     id, path: map a layer's file
//   overlay.remove  id: drop it; its texture goes at the next frame
//   overlay.layers  the ids mapped now

var OVERLAY_MAGIC = 0x52594C41;     // "ALYR"
var OVERLAY_HEADERS = { 1: 64, 2: 128 };
var OVERLAY_MAX = 16;
var OVERLAY_SIDE_MAX = 4096;
var OVERLAY_VISIBLE = 1;
var OVERLAY_INPUT = 2;
var OVERLAY_WORLD = 4;
var OVERLAY_HIDES_CURSOR = 8;
var OVERLAY_FOCUS = 48;
var OVERLAY_INPUT_ALPHA = 52;
var OVERLAY_MOUSE_X = 0x04;
var OVERLAY_MOUSE_SHAPE = 0x64;
var OVERLAY_STATE = 32;             // tex, texW, texH, lastSeq, failures, header bytes,
                                    // uploads, KiB uploaded (since the last report)
var OVERLAY_REPORT_MS = 30000;

var OVERLAY_C = [
    "#include <stdint.h>",
    "#include <string.h>",
    "static uint32_t ccall(void *fn, uint32_t n, const uint32_t *a) {",
    "  uint32_t r, d1, d2, d3;",
    "  __asm__ __volatile__(",
    "    \"movl %%esp, %%edi\\n\\t\" \"1:\\n\\t\" \"testl %%ecx, %%ecx\\n\\t\" \"jz 2f\\n\\t\"",
    "    \"decl %%ecx\\n\\t\" \"pushl (%%esi,%%ecx,4)\\n\\t\" \"jmp 1b\\n\\t\" \"2:\\n\\t\"",
    "    \"call *%%edx\\n\\t\" \"movl %%edi, %%esp\\n\\t\"",
    "    : \"=a\"(r), \"=d\"(d1), \"=c\"(d2), \"=S\"(d3) : \"d\"(fn), \"c\"(n), \"S\"(a) : \"edi\", \"memory\");",
    "  return r;",
    "}",
    "static void fence(void) { __asm__ __volatile__(\"lock; orl $0, (%%esp)\" : : : \"memory\"); }",
    "static void **vt(void *o) { return *(void ***) o; }",
    "static uint32_t m1(void *o, int i) { uint32_t a[1]; a[0] = (uint32_t) o; return ccall(vt(o)[i], 1, a); }",
    "static uint32_t m2(void *o, int i, uint32_t x) { uint32_t a[2]; a[0] = (uint32_t) o; a[1] = x; return ccall(vt(o)[i], 2, a); }",
    "static uint32_t m3(void *o, int i, uint32_t x, uint32_t y) { uint32_t a[3]; a[0] = (uint32_t) o; a[1] = x; a[2] = y; return ccall(vt(o)[i], 3, a); }",
    "static uint32_t m4(void *o, int i, uint32_t x, uint32_t y, uint32_t z) { uint32_t a[4]; a[0] = (uint32_t) o; a[1] = x; a[2] = y; a[3] = z; return ccall(vt(o)[i], 4, a); }",
    "static uint32_t m5(void *o, int i, uint32_t x, uint32_t y, uint32_t z, uint32_t w) { uint32_t a[5]; a[0] = (uint32_t) o; a[1] = x; a[2] = y; a[3] = z; a[4] = w; return ccall(vt(o)[i], 5, a); }",
    "static uint32_t m6(void *o, int i, uint32_t x, uint32_t y, uint32_t z, uint32_t w, uint32_t v) { uint32_t a[6]; a[0] = (uint32_t) o; a[1] = x; a[2] = y; a[3] = z; a[4] = w; a[5] = v; return ccall(vt(o)[i], 6, a); }",
    "struct desc { uint32_t size, flags, height, width; int32_t pitch; uint32_t bb, mip, alphadepth, res; void *surface;",
    "  uint32_t ck[8]; uint32_t pf[8]; uint32_t caps[4]; uint32_t stage; };",
    "struct hdr { uint32_t magic, version, width, height, seq, front, reading, ack; int32_t x, y, z; uint32_t flags, focus;",
    "  int32_t input_alpha; uint32_t pad[2]; int32_t changed[8]; };",
    "struct rect { int32_t left, top, right, bottom; };",
    "static uint32_t pow2(uint32_t v) { uint32_t p = 1; while (p < v) p <<= 1; return p; }",
    "static void *create_texture(void *dd, uint32_t w, uint32_t h) {",
    "  struct desc d; void *s = 0; memset(&d, 0, sizeof d);",
    "  d.size = sizeof d; d.flags = 1 | 2 | 4 | 0x1000; d.width = w; d.height = h;",
    "  d.pf[0] = 32; d.pf[1] = 0x41; d.pf[3] = 32; d.pf[4] = 0xff0000; d.pf[5] = 0xff00; d.pf[6] = 0xff; d.pf[7] = 0xff000000;",
    "  d.caps[0] = 0x1000; d.caps[1] = 0x10;",
    "  if ((int32_t) m4(dd, 6, (uint32_t) &d, (uint32_t) &s, 0) < 0) return 0;",
    "  return s;",
    "}",
    "/* Copies the part rx, ry, rw, rh of a w-wide frame; Lock points at its corner. */",
    "static int32_t upload(void *tex, const uint8_t *src, uint32_t w, int32_t rx, int32_t ry, int32_t rw, int32_t rh) {",
    "  struct desc d; struct rect r; int32_t y, hr; memset(&d, 0, sizeof d); d.size = sizeof d;",
    "  if (rw <= 0 || rh <= 0) return 0;",
    "  r.left = rx; r.top = ry; r.right = rx + rw; r.bottom = ry + rh;",
    "  hr = (int32_t) m5(tex, 25, (uint32_t) &r, (uint32_t) &d, 1 | 0x20, 0);",
    "  if (hr < 0) return hr;",
    "  for (y = 0; y < rh; y++)",
    "    memcpy((uint8_t *) d.surface + y * d.pitch, src + ((ry + y) * w + rx) * 4, rw * 4);",
    "  m2(tex, 32, (uint32_t) &r);",
    "  return 0;",
    "}",
    "static int sync(void *dd, uint8_t *view, uint32_t *st) {",
    "  volatile struct hdr *h = (volatile struct hdr *) view;",
    "  uint32_t w = h->width, hh = h->height, s;",
    "  if (!st[0]) {",
    "    if (st[4] > 3) return 0;",
    "    st[1] = pow2(w); st[2] = pow2(hh);",
    "    st[0] = (uint32_t) create_texture(dd, st[1], st[2]);",
    "    if (!st[0]) { st[4]++; return 0; }",
    "    st[3] = 0;",
    "  }",
    "  s = h->seq;",
    "  if (s != 0 && s != st[3]) {",
    "    h->reading = s; fence();",
    "    if (h->seq == s) {",
    "      uint32_t b = h->front & 1; int32_t hr, rx = 0, ry = 0, rw = w, rh = hh;",
    "      const uint8_t *src = view + st[5] + b * w * hh * 4;",
    "      if (st[5] >= 128 && st[3] != 0 && st[3] == s - 1) {",
    "        volatile int32_t *c = h->changed + 4 * b;",
    "        rx = c[0]; ry = c[1]; rw = c[2]; rh = c[3];",
    "        if (rx < 0 || ry < 0 || rw < 0 || rh < 0 || rx + rw > (int32_t) w || ry + rh > (int32_t) hh)",
    "          { rx = 0; ry = 0; rw = w; rh = hh; }",
    "      }",
    "      hr = upload((void *) st[0], src, w, rx, ry, rw, rh);",
    "      if (hr >= 0) { st[3] = s; h->ack = s; st[6]++; st[7] += ((uint32_t) rw * rh * 4) >> 10; }",
    "      else { m1((void *) st[0], 27); st[3] = 0; }",
    "    }",
    "    h->reading = 0;",
    "  }",
    "  return st[3] != 0;",
    "}",
    "static const uint32_t RS[] = { 27, 19, 20, 7, 14, 15, 22, 28, 137, 41, 29 };",
    "static const uint32_t RSV[] = { 1, 2, 6, 0, 0, 0, 1, 0, 0, 0, 0 };",
    "static const uint32_t TS[] = { 1, 2, 3, 4, 5, 6, 16, 17, 18, 13, 14 };",
    "static const uint32_t TSV[] = { 2, 2, 0, 2, 2, 0, 2, 2, 1, 3, 3 };",
    "int overlay_draw(void *dd, void *dev, uint8_t **views, uint32_t **states, int n) {",
    "  uint32_t rs[16], ts[16], s1c = 0, s1a = 0, i; void *old = 0; int k, drawn = 0;",
    "  float vx[24];",
    "  for (i = 0; i < sizeof RS / 4; i++) m3(dev, 21, RS[i], (uint32_t) &rs[i]);",
    "  for (i = 0; i < sizeof TS / 4; i++) m4(dev, 36, 0, TS[i], (uint32_t) &ts[i]);",
    "  m4(dev, 36, 1, 1, (uint32_t) &s1c); m4(dev, 36, 1, 4, (uint32_t) &s1a);",
    "  m3(dev, 34, 0, (uint32_t) &old);",
    "  for (i = 0; i < sizeof RS / 4; i++) m3(dev, 20, RS[i], RSV[i]);",
    "  for (i = 0; i < sizeof TS / 4; i++) m4(dev, 37, 0, TS[i], TSV[i]);",
    "  m4(dev, 37, 1, 1, 1); m4(dev, 37, 1, 4, 1);",
    "  for (k = 0; k < n; k++) {",
    "    volatile struct hdr *h = (volatile struct hdr *) views[k];",
    "    uint32_t *st = states[k];",
    "    float x0, y0, x1, y1, u, v;",
    "    if (!sync(dd, views[k], st)) continue;",
    "    x0 = (float) h->x - 0.5f; y0 = (float) h->y - 0.5f;",
    "    x1 = x0 + (float) h->width; y1 = y0 + (float) h->height;",
    "    u = (float) h->width / (float) st[1]; v = (float) h->height / (float) st[2];",
    "    vx[0] = x0; vx[1] = y0; vx[2] = 0; vx[3] = 1; vx[4] = 0; vx[5] = 0;",
    "    vx[6] = x1; vx[7] = y0; vx[8] = 0; vx[9] = 1; vx[10] = u; vx[11] = 0;",
    "    vx[12] = x1; vx[13] = y1; vx[14] = 0; vx[15] = 1; vx[16] = u; vx[17] = v;",
    "    vx[18] = x0; vx[19] = y1; vx[20] = 0; vx[21] = 1; vx[22] = 0; vx[23] = v;",
    "    m3(dev, 35, 0, st[0]);",
    "    if ((int32_t) m6(dev, 25, 6, 0x104, (uint32_t) vx, 4, 0) >= 0) drawn++;",
    "  }",
    "  m3(dev, 35, 0, (uint32_t) old);",
    "  if (old) m1(old, 2);",
    "  for (i = 0; i < sizeof RS / 4; i++) m3(dev, 20, RS[i], rs[i]);",
    "  for (i = 0; i < sizeof TS / 4; i++) m4(dev, 37, 0, TS[i], ts[i]);",
    "  m4(dev, 37, 1, 1, s1c); m4(dev, 37, 1, 4, s1a);",
    "  return drawn;",
    "}",
    "void overlay_release(uint32_t *st) {",
    "  if (st[0]) m1((void *) st[0], 2);",
    "  st[0] = 0; st[3] = 0;",
    "}"
].join("\n");

var overlayLayers = {};
var overlayC = null;
var overlayCError = null;
var overlayWin = null;
var overlayViews = null;
var overlayStates = null;
// Which of the frame's passes ran, since the last flip.
var overlayPassTop = false;
var overlayPassWorld = false;
var overlayFocusLast = null;
var overlayHover = null;
var overlayCapture = null;
var overlayCaptureButton = 0;
// What drawing the layers costs the game's frame, since the last report:
// passes that copied a new picture, and passes that only drew.
var overlayCost = { copied: { us: 0, n: 0 }, drawn: { us: 0, n: 0 } };
var overlayReported = 0;

function overlayNatives() {
    if (overlayC === null && overlayCError === null) {
        try {
            var cm = new CModule(OVERLAY_C);
            overlayC = {
                module: cm,
                draw: new NativeFunction(cm.overlay_draw, "int",
                                         ["pointer", "pointer", "pointer", "pointer", "int"]),
                release: new NativeFunction(cm.overlay_release, "void", ["pointer"])
            };
            overlayViews = Memory.alloc(4 * OVERLAY_MAX);
            overlayStates = Memory.alloc(4 * OVERLAY_MAX);
            var k32 = Process.getModuleByName("kernel32.dll");
            overlayWin = {
                open: new NativeFunction(k32.getExportByName("CreateFileW"), "pointer",
                                         ["pointer", "uint32", "uint32", "pointer", "uint32", "uint32",
                                          "pointer"], { abi: "stdcall" }),
                size: new NativeFunction(k32.getExportByName("GetFileSizeEx"), "int",
                                         ["pointer", "pointer"], { abi: "stdcall" }),
                mapping: new NativeFunction(k32.getExportByName("CreateFileMappingW"), "pointer",
                                            ["pointer", "pointer", "uint32", "uint32", "uint32",
                                             "pointer"], { abi: "stdcall" }),
                view: new NativeFunction(k32.getExportByName("MapViewOfFile"), "pointer",
                                         ["pointer", "uint32", "uint32", "uint32", "uint32"],
                                         { abi: "stdcall" }),
                unview: new NativeFunction(k32.getExportByName("UnmapViewOfFile"), "int", ["pointer"],
                                           { abi: "stdcall" }),
                close: new NativeFunction(k32.getExportByName("CloseHandle"), "int", ["pointer"],
                                          { abi: "stdcall" })
            };
            overlayBegin = new NativeFunction(at(RVA.beginScene), "uint8", ["pointer"],
                                              { abi: "thiscall", exceptions: "propagate" });
            overlayEnd = new NativeFunction(at(RVA.endScene), "void", ["pointer"],
                                            { abi: "thiscall", exceptions: "propagate" });
        } catch (e) {
            overlayCError = e.message;
            console.log("overlay unavailable: " + e.message);
        }
    }
    return overlayC;
}

var overlayBegin = null;
var overlayEnd = null;

function overlayRead(layer, off) {
    return layer.view.add(off).readS32();
}

// Visible layers with a frame that this file draws with Direct3D 7, bottom
// first: of one plane when `world` is true or false, of both when it is
// undefined.  A layer backend 12 draws at Present (99-overlay-d3d12.js) is
// left out.
function overlayShown(world) {
    return overlayShownAll(world).filter(function (layer) {
        return !d12Owns(layer) && overlayRead(layer, 16) !== 0;
    });
}

// Every visible layer with a frame, whoever draws it: what the mouse and the
// cursor see.  None once the host stops asking, which it does when the JVM
// that owns them is gone (and under --no-ask).
function overlayShownAll(world) {
    var shown = [];
    if (!askEnabled) {
        return shown;
    }
    for (var id in overlayLayers) {
        var layer = overlayLayers[id];
        var flags = overlayRead(layer, 44);
        if (!layer.dead && (flags & OVERLAY_VISIBLE) !== 0 && (overlayRead(layer, 16) !== 0 || d12Wants(layer)) &&
                (world === undefined || ((flags & OVERLAY_WORLD) !== 0) === world)) {
            shown.push(layer);
        }
    }
    shown.sort(function (a, b) {
        var dz = overlayRead(a, 40) - overlayRead(b, 40);
        return dz !== 0 ? dz : a.id - b.id;
    });
    return shown;
}

function overlayUnmap(layer) {
    overlayWin.unview(layer.view);
    overlayWin.close(layer.mapping);
}

// On the thread that draws: textures are the device's, and go with it.
function overlayCollect() {
    for (var id in overlayLayers) {
        var layer = overlayLayers[id];
        if (layer.dead) {
            d12Retire(layer);
            overlayC.release(layer.state);
            overlayUnmap(layer);
            delete overlayLayers[id];
        }
    }
}

function overlayRender(driver, world) {
    if (overlayC === null) {
        return;
    }
    overlayCollect();
    var shown = overlayShown(world);
    if (shown.length === 0) {
        return;
    }
    var copies = false;
    for (var i = 0; i < shown.length; i++) {
        overlayViews.add(4 * i).writePointer(shown[i].view);
        overlayStates.add(4 * i).writePointer(shown[i].state);
        copies = copies || overlayRead(shown[i], 16) !== shown[i].state.add(12).readS32();
    }
    var start = nowMicros();
    overlayC.draw(driver.add(0xB4).readPointer(), driver.add(0xCC).readPointer(),
                  overlayViews, overlayStates, shown.length);
    var cost = copies ? overlayCost.copied : overlayCost.drawn;
    cost.us += nowMicros() - start;
    cost.n += 1;
    overlayReport();
}

// Every 30 seconds, while layers show, what they cost the game's frame: the
// average pass that copied a new picture and one that did not, and for each
// layer how many pictures it copied and how much of each.
function overlayReport() {
    var now = Date.now();
    if (overlayReported === 0) {
        overlayReported = now;
    }
    if (now - overlayReported < OVERLAY_REPORT_MS) {
        return;
    }
    overlayReported = now;
    var parts = [];
    for (var id in overlayLayers) {
        var layer = overlayLayers[id];
        var uploads = layer.state.add(24).readU32();
        if (uploads > 0) {
            parts.push("layer " + id + " " + layer.width + "x" + layer.height + " " + uploads +
                       " copies of " + (layer.state.add(28).readU32() / uploads).toFixed(0) + " KiB");
        }
        layer.state.add(24).writeU32(0);
        layer.state.add(28).writeU32(0);
    }
    var c = overlayCost.copied;
    var d = overlayCost.drawn;
    if (c.n + d.n > 0) {
        note("overlay per pass: copying " + (c.n > 0 ? (c.us / c.n).toFixed(1) : "-") + " us (" + c.n +
             "), drawing only " + (d.n > 0 ? (d.us / d.n).toFixed(1) : "-") + " us (" + d.n + ")" +
             (parts.length > 0 ? "; " + parts.join(", ") : ""));
    }
    overlayCost = { copied: { us: 0, n: 0 }, drawn: { us: 0, n: 0 } };
}

// One plane inside a scene the game has begun.
function overlayPass(world) {
    if (!overlayAny()) {
        return;
    }
    try {
        var driver = ptr(VA.dxDriver).readPointer();
        if (!driver.isNull()) {
            overlayRender(driver, world);
        }
    } catch (e) {}
}

function overlayAny() {
    for (var id in overlayLayers) {
        return true;
    }
    return false;
}

hook("overlayDrawWorld", RVA.uiRender, {
    onEnter: function () {
        overlayPassWorld = true;
        overlayPass(true);
    }
});

hook("overlayDraw", RVA.cursorDraw, {
    onEnter: function (args) {
        if (args[1].toUInt32() !== 1) {
            return;
        }
        overlayPassTop = true;
        overlayPass(false);
    }
});

// The top plane in the menu thread's frames, and the cursor over a layer.
hook("overlayCursor", RVA.cursorShapeDraw, {
    onEnter: function (args) {
        this.mouse = null;
        if (!overlayAny()) {
            return;
        }
        if (!overlayPassTop) {
            overlayPassTop = true;
            overlayPass(false);
        }
        try {
            var mouse = snapPtr(this.context.ecx);
            var x = mouse.add(OVERLAY_MOUSE_X).readS32();
            var y = mouse.add(OVERLAY_MOUSE_X + 4).readS32();
            // Backend 12 draws the cursor itself above its layers.
            var own = d12CursorWanted() && d12CursorTake(mouse, (args[1].toUInt32() & 0xFF) !== 0);
            if (!own && overlayAt(x, y, OVERLAY_HIDES_CURSOR) === null) {
                return;
            }
            var shape = mouse.add(OVERLAY_MOUSE_SHAPE).readPointer();
            if (shape.isNull()) {
                return;
            }
            mouse.add(OVERLAY_MOUSE_SHAPE).writePointer(NULL);
            this.mouse = mouse;
            this.shape = shape;
        } catch (e) {}
    },
    onLeave: function () {
        if (this.mouse === null) {
            return;
        }
        try {
            var slot = this.mouse.add(OVERLAY_MOUSE_SHAPE);
            if (slot.readPointer().isNull()) {
                slot.writePointer(this.shape);
            }
        } catch (e) {}
    }
});

hook("overlayFlip", RVA.frameFlip, {
    onEnter: function () {
        var top = overlayPassTop;
        var world = overlayPassWorld;
        overlayPassTop = false;
        overlayPassWorld = false;
        if (!overlayAny() || overlayC === null) {
            return;
        }
        try {
            overlayFocusCheck();
        } catch (e) {}
        if (top && world) {
            return;
        }
        try {
            var driver = this.context.ecx;
            overlayCollect();
            var missing = top ? true : world ? false : undefined;
            if (overlayShown(missing).length === 0) {
                return;
            }
            overlayBegin(driver);
            try {
                if (!world) {
                    overlayRender(driver, true);
                }
                if (!top) {
                    overlayRender(driver, false);
                }
            } finally {
                overlayEnd(driver);
            }
        } catch (e) {}
    }
});

// The topmost visible layer with a flag at a point, top plane first.  With
// `solid`, only where its newest picture is opaque enough to take input.
function overlayAt(x, y, flag, solid) {
    var planes = [overlayShownAll(false), overlayShownAll(true)];
    for (var p = 0; p < planes.length; p++) {
        var shown = planes[p];
        for (var i = shown.length - 1; i >= 0; i--) {
            var layer = shown[i];
            if ((overlayRead(layer, 44) & flag) === 0) {
                continue;
            }
            var lx = x - overlayRead(layer, 32);
            var ly = y - overlayRead(layer, 36);
            if (lx >= 0 && ly >= 0 && lx < layer.width && ly < layer.height &&
                    (!solid || overlaySolid(layer, lx, ly))) {
                return layer;
            }
        }
    }
    return null;
}

// Whether a layer's newest picture takes input at a point of it: its alpha
// there above the layer's input alpha.  Java only writes the buffer that is
// not front, so the front one holds that picture.  A GPU layer's picture is
// in a texture: Java copies it back into the buffer D12_MASK names, at most
// one copy behind, and until the first copy the whole rectangle counts.
function overlaySolid(layer, lx, ly) {
    if (layer.header < 128) {
        return true;
    }
    var threshold = overlayRead(layer, OVERLAY_INPUT_ALPHA);
    if (threshold < 0) {
        return true;
    }
    var buffer;
    if (d12Owns(layer)) {
        var mask = overlayRead(layer, D12_MASK);
        if (mask !== 1 && mask !== 2) {
            return true;
        }
        buffer = mask - 1;
    } else {
        buffer = overlayRead(layer, 20) & 1;
    }
    var pixel = buffer * layer.width * layer.height + ly * layer.width + lx;
    return layer.view.add(layer.header + 4 * pixel + 3).readU8() > threshold;
}

// The topmost visible layer that takes the mouse at a point.
function overlayHit(x, y) {
    return overlayAt(x, y, OVERLAY_INPUT, true);
}

// The layer that holds the keyboard, or null: the newest visible one with
// its focus field set.  Java keeps it to one.
function overlayKeyboard() {
    if (!askEnabled) {
        return null;
    }
    var holder = null;
    for (var id in overlayLayers) {
        var layer = overlayLayers[id];
        if (layer.dead || overlayRead(layer, OVERLAY_FOCUS) === 0 ||
                (overlayRead(layer, 44) & OVERLAY_VISIBLE) === 0) {
            continue;
        }
        if (holder === null || layer.id > holder.id) {
            holder = layer;
        }
    }
    return holder === null ? null : holder.id;
}

// Takes the keyboard from a layer; overlayFocusCheck reports it.
function overlayLoseFocus(id) {
    var layer = overlayLayers[id];
    if (layer !== undefined && !layer.dead) {
        layer.view.add(OVERLAY_FOCUS).writeS32(0);
    }
    overlayFocusCheck();
}

// Reports a layer that lost the keyboard since the last check: taken here,
// hidden, closed, or given to another layer by Java.
function overlayFocusCheck() {
    for (var id in overlayLayers) {
        var layer = overlayLayers[id];
        if (!layer.dead && overlayRead(layer, OVERLAY_FOCUS) !== 0 &&
                (overlayRead(layer, 44) & OVERLAY_VISIBLE) === 0) {
            layer.view.add(OVERLAY_FOCUS).writeS32(0);
        }
    }
    var now = overlayKeyboard();
    if (now !== overlayFocusLast) {
        var before = overlayFocusLast;
        overlayFocusLast = now;
        if (before !== null) {
            evt("layer.focus_lost", { layer: before });
        }
    }
}

function overlayFields(layer, x, y) {
    return { layer: layer.id, x: x - overlayRead(layer, 32), y: y - overlayRead(layer, 36) };
}

function overlayLeave() {
    if (overlayHover !== null) {
        evt("layer.leave", { layer: overlayHover });
        overlayHover = null;
    }
}

// Called by 93-input.js on the window's thread.  True keeps the message
// from the game.
function overlayPointer(kind, button, x, y, delta, mods) {
    if (!overlayAny()) {
        return false;
    }
    if (kind === "leave") {
        overlayLeave();
        overlayCapture = null;
        var holding = overlayKeyboard();
        if (holding !== null) {
            overlayLoseFocus(holding);
        }
        return false;
    }
    var captured = overlayCapture !== null ? overlayLayers[overlayCapture] : undefined;
    if (captured !== undefined && captured.dead) {
        captured = undefined;
        overlayCapture = null;
    }
    var fields;
    if (kind === "release") {
        if (captured === undefined || button !== overlayCaptureButton) {
            return false;
        }
        fields = overlayFields(captured, x, y);
        fields.button = button;
        fields.mods = mods;
        evt("layer.release", fields);
        if (fields.x >= 0 && fields.y >= 0 && fields.x < captured.width && fields.y < captured.height) {
            evt("layer.click", fields);
        }
        overlayCapture = null;
        return true;
    }
    var target = captured !== undefined ? captured : overlayHit(x, y);
    if (kind === "press") {
        var focused = overlayKeyboard();
        if (focused !== null && (target === null || target.id !== focused)) {
            overlayLoseFocus(focused);
        }
    }
    if (kind === "move") {
        var id = target === null ? null : target.id;
        if (id !== overlayHover) {
            overlayLeave();
            overlayHover = id;
        }
        if (target !== null) {
            evt("layer.move", overlayFields(target, x, y));
        }
        return false;
    }
    if (target === null) {
        return false;
    }
    fields = overlayFields(target, x, y);
    fields.mods = mods;
    if (kind === "wheel") {
        fields.delta = delta;
        evt("layer.wheel", fields);
        return true;
    }
    if (captured !== undefined) {
        // A second button while one is held: the layer's as well.
        fields.button = button;
        evt("layer.press", fields);
        return true;
    }
    overlayCapture = target.id;
    overlayCaptureButton = button;
    fields.button = button;
    evt("layer.press", fields);
    return true;
}

function overlayMap(path) {
    var w = overlayWin;
    var file = w.open(Memory.allocUtf16String(path), 0xC0000000, 7, NULL, 3, 0x80, NULL);
    if (file.equals(ptr("0xFFFFFFFF")) || file.isNull()) {
        throw new Error("Cannot open " + path + ".");
    }
    var size = Memory.alloc(8);
    var ok = w.size(file, size) !== 0;
    var mapping = ok ? w.mapping(file, NULL, 4, 0, 0, NULL) : NULL;
    w.close(file);
    if (mapping.isNull()) {
        throw new Error("Cannot map " + path + ".");
    }
    var view = w.view(mapping, 6, 0, 0, 0);
    if (view.isNull()) {
        w.close(mapping);
        throw new Error("Cannot map " + path + ".");
    }
    return { view: view, mapping: mapping, size: size.readU64().toNumber() };
}

command("overlay.add", function (f) {
    if (overlayNatives() === null) {
        throw new Error("Layers need a CModule, which failed here: " + overlayCError);
    }
    var id = parseInt(f.id, 10);
    if (isNaN(id) || id <= 0) {
        throw new Error("No layer id " + f.id + ".");
    }
    if (overlayLayers[id] !== undefined) {
        throw new Error("Layer " + id + " is already mapped.");
    }
    var count = 0;
    for (var k in overlayLayers) {
        count += 1;
    }
    if (count >= OVERLAY_MAX) {
        throw new Error("At most " + OVERLAY_MAX + " layers.");
    }
    var mapped = overlayMap(String(f.path || ""));
    var layer = { id: id, view: mapped.view, mapping: mapped.mapping, dead: false };
    var magic = mapped.view.readU32();
    var version = mapped.view.add(4).readU32();
    layer.width = mapped.view.add(8).readU32();
    layer.height = mapped.view.add(12).readU32();
    layer.header = OVERLAY_HEADERS[version] || 0;
    var need = layer.header + 2 * 4 * layer.width * layer.height;
    if (magic !== OVERLAY_MAGIC || layer.header === 0 || layer.width < 1 ||
            layer.height < 1 || layer.width > OVERLAY_SIDE_MAX || layer.height > OVERLAY_SIDE_MAX ||
            mapped.size < need) {
        overlayUnmap(layer);
        throw new Error("Not a layer file: " + f.path + ".");
    }
    layer.state = Memory.alloc(OVERLAY_STATE);
    for (var i = 0; i < OVERLAY_STATE; i += 4) {
        layer.state.add(i).writeU32(0);
    }
    layer.state.add(20).writeU32(layer.header);
    overlayLayers[id] = layer;
    return { id: id, width: layer.width, height: layer.height };
});

command("overlay.remove", function (f) {
    var layer = overlayLayers[parseInt(f.id, 10)];
    if (layer === undefined) {
        return { removed: 0 };
    }
    layer.dead = true;
    if (overlayHover === layer.id) {
        overlayHover = null;
    }
    if (overlayFocusLast === layer.id) {
        overlayFocusLast = null;
        evt("layer.focus_lost", { layer: layer.id });
    }
    return { removed: 1 };
});

command("overlay.layers", function () {
    var ids = [];
    for (var id in overlayLayers) {
        if (!overlayLayers[id].dead) {
            ids.push(id);
        }
    }
    return { ids: ids.join(","), error: overlayCError || "" };
});

// Built as the script loads, on Frida's thread: the first stage reports
// whether layers can show at all, and building there would hold the game.
overlayNatives();
