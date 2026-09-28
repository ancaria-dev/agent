// The view: where the world is on the screen.
//
// The engine draws through its current cWorldView2, [engine + 8 + 4 * word
// [engine+0x48]] (layout under STRUCTURES in mappings).  A world point goes
// through four axes into the view's plane, where one unit is one back-buffer
// pixel at zoom 1; the view keeps the plane point at the back buffer's centre
// and the zoom, in plane units per pixel.  The game's mouse pick (0x0062A3B0)
// runs the same arithmetic backwards.
//
// Java does the arithmetic (View), so a mod converts as many points as it
// likes from one read.  Nothing here is cached: the camera moves every frame.
//
//   view.info   the axes, the centre, the zoom and the back buffer's size;
//               nothing but the axes outside a world

var VIEW_LIST = 0x08;
var VIEW_CURRENT = 0x48;
var VIEW_COUNT = 16;
var VIEW_CENTRE_X = 0x14;
var VIEW_CENTRE_Y = 0x18;
var VIEW_ZOOM = 0xB60;
var VIEW_DRIVER_HEIGHT = 0x1C;
var VIEW_DRIVER_WIDTH = 0x20;

command("view.info", function () {
    var out = {
        xx: ptr(VA.viewXFromX).readFloat(),
        yx: ptr(VA.viewYFromX).readFloat(),
        xy: ptr(VA.viewXFromY).readFloat(),
        yy: ptr(VA.viewYFromY).readFloat()
    };
    var engine = ptr(VA.engine).readPointer();
    var driver = ptr(VA.dxDriver).readPointer();
    if (engine.isNull() || driver.isNull()) {
        return out;
    }
    var index = engine.add(VIEW_CURRENT).readU16();
    if (index >= VIEW_COUNT) {
        return out;
    }
    var view = engine.add(VIEW_LIST + 4 * index).readPointer();
    if (view.isNull()) {
        return out;
    }
    out.cx = view.add(VIEW_CENTRE_X).readS32();
    out.cy = view.add(VIEW_CENTRE_Y).readS32();
    out.zoom = view.add(VIEW_ZOOM).readFloat();
    out.width = driver.add(VIEW_DRIVER_WIDTH).readU16();
    out.height = driver.add(VIEW_DRIVER_HEIGHT).readU16();
    return out;
});
