// Backend 12: layers drawn on the GPU at Present, when dgVoodoo outputs
// through Direct3D 12.  docs/BACKEND12.md is the design, and
// research/artifacts/notes/FINDINGS.md section 6 the evidence.
//
// Nothing here has an address in pureHD.exe: everything is found through COM
// vtables while the game runs.  Present is hooked in the swap chain
// implementation of the system dxgi.dll, which ReShade's DXGI.DLL proxy calls
// after its effects and overlay, so layers land above both.  A D3D12 swap
// chain does not give its queue back, so the real ExecuteCommandLists (in
// D3D12Core.dll; ReShade wraps D3D12CreateDevice, so a queue of our own
// device would be its proxy) is watched until a DIRECT queue of the swap
// chain's device runs.
//
// A GPU layer is a layer file whose +96 is 1; +100 and +104 are the game-side
// handles of its two shared textures, +108 of its `ready` fence and +112 of
// its `done` fence; +116 is 1 + the buffer holding a copy of a recent frame
// for the alpha hit test, or 0 before the first copy.  At Present the newest
// finished frame (ready's completed value) is drawn from texture frame % 2 as
// one alpha-blended quad, and done is signalled with it on the game's queue.
// The game never waits on the CPU:
// command allocators come from a ring that grows when all are busy.
//
// The JVM learns the backend from the fields of every loading stage
// (d12StageFields): backend (7 or 12), backend_luid_high, backend_luid_low,
// backend_width and backend_height of the swap chain, backend_pid,
// backend_error, and backend_pending while nothing is decided.  Backend 0:
// no layer can show, because backend 7's module failed to build.
// The first stage waits for the decision, so the Game stages' mods make their
// layers on the right backend.  A decision after that goes out on its own as
// the event overlay.backend with the same fields.

var D12_GPU = 96;
var D12_HANDLES = 100;
var D12_MASK = 116;                 // 1 + the buffer with the newest copied-back picture, or 0
var D12_SRV_MAX = 64;               // two descriptors a layer
var D12_ALLOCATORS_MAX = 32;
// How long the first loading stage waits for the backend.  The swap chain
// was up before that stage in every run seen.
var D12_DECIDE_MS = 3000;
var D12_HLSL = [
    '#define RS "RootConstants(num32BitConstants=12, b0), DescriptorTable(SRV(t0)), StaticSampler(s0, filter=FILTER_MIN_MAG_MIP_LINEAR, addressU=TEXTURE_ADDRESS_CLAMP, addressV=TEXTURE_ADDRESS_CLAMP)"',
    'cbuffer C : register(b0) { float4 rect; float4 uv; float4 tint; };',
    'Texture2D layer : register(t0);',
    'SamplerState smooth : register(s0);',
    'struct V { float4 p : SV_Position; float2 t : TEXCOORD; };',
    '[RootSignature(RS)] V vs(uint i : SV_VertexID) {',
    '    float2 c = float2(i & 1, i >> 1);',
    '    V o; o.p = float4(lerp(rect.xy, rect.zw, c), 0, 1); o.t = lerp(uv.xy, uv.zw, c); return o;',
    '}',
    '[RootSignature(RS)] float4 ps(V v) : SV_Target { return layer.Sample(smooth, v.t) * tint; }'
].join('\n');

var d12 = {
    backend: 7,
    error: null,
    started: false,
    iid: null,
    shaders: null,
    present: null,
    execute: null,
    queueWatched: false,
    queues: [],
    notD3D12: {},
    chain: null,
    luid: null,
    retired: [],
    fns: {},
    // The report the JVM has, as a string; null until the first stage.
    told: null,
    // The cursor shape mouse::draw left to this frame's Present, and each
    // texture handle's picture (null when unreadable).
    cursor: null,
    cursorPixels: {}
};

function d12Guid(text) {
    var h = text.replace(/-/g, '');
    var m = Memory.alloc(16);
    m.writeU32(parseInt(h.substr(0, 8), 16));
    m.add(4).writeU16(parseInt(h.substr(8, 4), 16));
    m.add(6).writeU16(parseInt(h.substr(12, 4), 16));
    for (var i = 0; i < 8; i++) {
        m.add(8 + i).writeU8(parseInt(h.substr(16 + 2 * i, 2), 16));
    }
    return m;
}

// Slot `index` of a COM object's vtable, stdcall with `this` first.
function d12Com(obj, index, ret, args) {
    var at = obj.readPointer().add(4 * index).readPointer();
    var key = at.toString() + ret + args.join();
    var f = d12.fns[key];
    if (f === undefined) {
        f = new NativeFunction(at, ret, ['pointer'].concat(args), { abi: 'stdcall' });
        d12.fns[key] = f;
    }
    return function () {
        return f.apply(null, [obj].concat([].slice.call(arguments)));
    };
}

function d12Out() {
    var p = Memory.alloc(8);
    p.writePointer(NULL);
    return p;
}

function d12Hr(v) {
    return (v >>> 0).toString(16);
}

function d12Release(obj) {
    if (obj !== null && obj !== undefined && !obj.isNull()) {
        d12Com(obj, 2, 'uint32', [])();
    }
}

// Backend 12 is off for the rest of the run.  Layers it drew go back to
// backend 7, which shows their files' frames until the JVM draws new ones
// there; their GPU objects go once our last draw with them is done.
function d12Fail(what) {
    if (d12.error !== null) {
        return;
    }
    d12.error = what;
    if (d12.backend === 12) {
        d12.backend = 7;
        note('backend 12 failed, layers go back to backend 7: ' + what);
        for (var id in overlayLayers) {
            d12Retire(overlayLayers[id]);
        }
    } else {
        note('backend 12 unavailable: ' + what);
    }
    d12Tell();
}

function d12SystemModule(name) {
    var found = Process.enumerateModules().filter(function (m) {
        return m.name.toLowerCase() === name && m.path.toLowerCase().indexOf('\\system32\\') >= 0;
    });
    return found.length > 0 ? found[0] : null;
}

// The shaders, compiled once on Frida's thread before any hook: loading
// d3dcompiler_47.dll inside a callback left a probe stuck with the game
// waiting on it.
function d12Compile(entry, target) {
    var m = Module.load('d3dcompiler_47.dll');
    var compile = new NativeFunction(m.getExportByName('D3DCompile'), 'int',
        ['pointer', 'uint32', 'pointer', 'pointer', 'pointer', 'pointer', 'pointer', 'uint32', 'uint32', 'pointer', 'pointer'],
        { abi: 'stdcall' });
    var code = d12Out(), errors = d12Out();
    var r = compile(Memory.allocUtf8String(D12_HLSL), D12_HLSL.length, NULL, NULL, NULL,
        Memory.allocUtf8String(entry), Memory.allocUtf8String(target), 0, 0, code, errors);
    if (r < 0) {
        var text = errors.readPointer().isNull() ? '' : d12Com(errors.readPointer(), 3, 'pointer', [])().readCString();
        throw new Error('D3DCompile ' + entry + ' ' + d12Hr(r) + ' ' + text);
    }
    var blob = code.readPointer();
    return { at: d12Com(blob, 3, 'pointer', [])(), size: d12Com(blob, 4, 'uint32', [])() };
}

// Present and Present1 of the system dxgi.dll, read off a throwaway swap
// chain on a hidden window.
function d12FindPresent(dxgi, d3d12) {
    var user32 = Process.getModuleByName('user32.dll');
    var createFactory = new NativeFunction(dxgi.getExportByName('CreateDXGIFactory1'), 'int', ['pointer', 'pointer'], { abi: 'stdcall' });
    var createDevice = new NativeFunction(d3d12.getExportByName('D3D12CreateDevice'), 'int', ['pointer', 'int', 'pointer', 'pointer'], { abi: 'stdcall' });
    var createWindow = new NativeFunction(user32.getExportByName('CreateWindowExW'), 'pointer',
        ['uint32', 'pointer', 'pointer', 'uint32', 'int', 'int', 'int', 'int', 'pointer', 'pointer', 'pointer', 'pointer'], { abi: 'stdcall' });
    var destroyWindow = new NativeFunction(user32.getExportByName('DestroyWindow'), 'int', ['pointer'], { abi: 'stdcall' });
    var f = d12Out(), d = d12Out(), q = d12Out(), sc = d12Out();
    var r = createFactory(d12.iid.factory2, f);
    if (r < 0) throw new Error('CreateDXGIFactory1 ' + d12Hr(r));
    r = createDevice(NULL, 0xb000, d12.iid.device, d);
    if (r < 0) throw new Error('D3D12CreateDevice ' + d12Hr(r));
    r = d12Com(d.readPointer(), 8, 'int', ['pointer', 'pointer', 'pointer'])(Memory.alloc(16), d12.iid.queue, q);
    if (r < 0) throw new Error('CreateCommandQueue ' + d12Hr(r));
    var hwnd = createWindow(0, Memory.allocUtf16String('STATIC'), Memory.allocUtf16String(''), 0x00CF0000, 0, 0, 64, 64, NULL, NULL, NULL, NULL);
    var desc = Memory.alloc(48);
    [64, 64, 87, 0, 1, 0, 0x20, 2, 0, 4, 0, 0].forEach(function (v, i) { desc.add(4 * i).writeU32(v); });
    r = d12Com(f.readPointer(), 15, 'int', ['pointer', 'pointer', 'pointer', 'pointer', 'pointer', 'pointer'])(q.readPointer(), hwnd, desc, NULL, NULL, sc);
    if (r < 0) throw new Error('CreateSwapChainForHwnd ' + d12Hr(r));
    var vt = sc.readPointer().readPointer();
    var present = vt.add(4 * 8).readPointer();
    [sc, q, d, f].forEach(function (p) { d12Release(p.readPointer()); });
    destroyWindow(hwnd);
    return present;
}

function d12Start() {
    if (d12.started) {
        return true;
    }
    var dxgi = d12SystemModule('dxgi.dll');
    var d3d12 = d12SystemModule('d3d12.dll');
    if (dxgi === null || d3d12 === null) {
        return false;
    }
    d12.started = true;
    try {
        d12.iid = {
            factory2: d12Guid('50c83a1c-e072-4c48-87b0-3630fa36a6d0'),
            device: d12Guid('189819f1-1db6-4b57-be54-1821339b85f7'),
            queue: d12Guid('0ec870a6-5d7e-4c22-8cfc-5baae07616ed'),
            resource: d12Guid('696442be-a72e-4059-bc79-5b5c98040fad'),
            allocator: d12Guid('6102dee4-af59-4b09-b999-b44d73f09b24'),
            list: d12Guid('5b160d0f-ac1b-4185-8ba8-b3ae42a5a455'),
            heap: d12Guid('8efb471d-616c-4f49-90f7-127bb763fa51'),
            fence: d12Guid('0a753dcf-c4d8-4b91-adf6-be5a60d95a76'),
            swap3: d12Guid('94d99bdb-f1f8-4ab0-b236-7da0170edab1'),
            root: d12Guid('c54a6b66-72df-4ee8-8be5-a946a1429214'),
            pso: d12Guid('765a30f3-f624-4c6f-a828-ace948622445')
        };
        d12.shaders = { vs: d12Compile('vs', 'vs_5_0'), ps: d12Compile('ps', 'ps_5_0'), rs: d12Compile('RS', 'rootsig_1_0') };
        d12.present = d12FindPresent(dxgi, d3d12);
        Interceptor.attach(d12.present, {
            onEnter: function (args) {
                try {
                    d12OnPresent(args[0]);
                } catch (e) {
                    d12Fail('Present: ' + e.message);
                }
            }
        });
    } catch (e) {
        d12Fail(e.message);
    }
    return true;
}

// Every 100 ms until the game has loaded the system dxgi.dll and d3d12.dll.
var d12Poll = setInterval(function () {
    try {
        if (d12Start()) {
            clearInterval(d12Poll);
        }
    } catch (e) {
        clearInterval(d12Poll);
        d12Fail(e.message);
    }
}, 100);

// DIRECT queues seen executing, with their devices.  Held with AddRef.
var d12QueueWatch = {
    onEnter: function (args) {
        var q = args[0];
        for (var i = 0; i < d12.queues.length; i++) {
            if (d12.queues[i].queue.equals(q)) {
                return;
            }
        }
        var desc = Memory.alloc(16);
        d12Com(q, 18, 'void', ['pointer'])(desc);
        if (desc.readU32() !== 0) {
            return;
        }
        var d = d12Out();
        if (d12Com(q, 7, 'int', ['pointer', 'pointer'])(d12.iid.device, d) < 0) {
            return;
        }
        d12Com(q, 1, 'uint32', [])();
        d12.queues.push({ queue: q, device: d.readPointer() });
        d12Release(d.readPointer());
    }
};

function d12WatchQueues(device) {
    if (d12.queueWatched) {
        return;
    }
    d12.queueWatched = true;
    var q = d12Out();
    var r = d12Com(device, 8, 'int', ['pointer', 'pointer', 'pointer'])(Memory.alloc(16), d12.iid.queue, q);
    if (r < 0) {
        d12Fail('CreateCommandQueue on the game device ' + d12Hr(r));
        return;
    }
    d12.execute = q.readPointer().readPointer().add(40).readPointer();
    d12Release(q.readPointer());
    // Not from inside the Present hook.
    setTimeout(function () {
        Interceptor.attach(d12.execute, d12QueueWatch);
    }, 0);
}

// Everything tied to one swap chain and its device, made at its first Present.
function d12Setup(sc) {
    var d = d12Out();
    if (d12Com(sc, 7, 'int', ['pointer', 'pointer'])(d12.iid.device, d) < 0) {
        d12.notD3D12[sc.toString()] = true;
        return null;
    }
    var device = d.readPointer();
    d12Release(device);
    var queue = null;
    for (var i = 0; i < d12.queues.length; i++) {
        if (d12.queues[i].device.equals(device)) {
            queue = d12.queues[i].queue;
        }
    }
    if (queue === null) {
        d12WatchQueues(device);
        return null;
    }
    var desc = Memory.alloc(48);
    d12Com(sc, 18, 'int', ['pointer'])(desc);
    var s = {
        sc: sc, device: device, queue: queue,
        width: desc.readU32(), height: desc.add(4).readU32(), format: desc.add(8).readU32(),
        buffers: desc.add(28).readU32(), value: 0, allocators: [], done: []
    };
    var dev = device;
    var r;
    // The pipeline: root signature, PSO blending premultiplied alpha.
    var root = d12Out();
    r = d12Com(dev, 16, 'int', ['uint32', 'pointer', 'uint32', 'pointer', 'pointer'])(0, d12.shaders.rs.at, d12.shaders.rs.size, d12.iid.root, root);
    if (r < 0) throw new Error('CreateRootSignature ' + d12Hr(r));
    s.root = root.readPointer();
    s.pso = d12Pso(dev, s, 6);      // INV_SRC_ALPHA: premultiplied over
    s.psoAdd = d12Pso(dev, s, 2);   // ONE: the cursor's glow adds light
    // Descriptor heaps: one RTV per back buffer, two SRVs per layer.
    var heapDesc = Memory.alloc(16);
    heapDesc.writeU32(2); heapDesc.add(4).writeU32(s.buffers); heapDesc.add(8).writeU32(0); heapDesc.add(12).writeU32(0);
    var heap = d12Out();
    r = d12Com(dev, 14, 'int', ['pointer', 'pointer', 'pointer'])(heapDesc, d12.iid.heap, heap);
    if (r < 0) throw new Error('CreateDescriptorHeap(RTV) ' + d12Hr(r));
    s.rtvHeap = heap.readPointer();
    var start = Memory.alloc(8);
    d12Com(s.rtvHeap, 9, 'void', ['pointer'])(start);
    s.rtv0 = start.readU32();
    s.rtvStep = d12Com(dev, 15, 'uint32', ['int'])(2);
    heapDesc.writeU32(0); heapDesc.add(4).writeU32(D12_SRV_MAX); heapDesc.add(8).writeU32(1);
    heap = d12Out();
    r = d12Com(dev, 14, 'int', ['pointer', 'pointer', 'pointer'])(heapDesc, d12.iid.heap, heap);
    if (r < 0) throw new Error('CreateDescriptorHeap(SRV) ' + d12Hr(r));
    s.srvHeap = heap.readPointer();
    d12Com(s.srvHeap, 9, 'void', ['pointer'])(start);
    s.srvCpu = start.readU32();
    var gpu = Memory.alloc(8);
    d12Com(s.srvHeap, 10, 'void', ['pointer'])(gpu);
    s.srvGpu = gpu.readU64();
    s.srvStep = d12Com(dev, 15, 'uint32', ['int'])(0);
    s.srvFree = [];
    for (var slot = D12_SRV_MAX / 2 - 1; slot >= 0; slot--) s.srvFree.push(slot);
    // One command list, a ring of allocators, a fence of our own.
    var a = d12Out();
    r = d12Com(dev, 9, 'int', ['int', 'pointer', 'pointer'])(0, d12.iid.allocator, a);
    if (r < 0) throw new Error('CreateCommandAllocator ' + d12Hr(r));
    s.allocators.push(a.readPointer());
    s.done.push(0);
    var l = d12Out();
    r = d12Com(dev, 12, 'int', ['uint32', 'int', 'pointer', 'pointer', 'pointer', 'pointer'])(0, 0, s.allocators[0], NULL, d12.iid.list, l);
    if (r < 0) throw new Error('CreateCommandList ' + d12Hr(r));
    s.list = l.readPointer();
    d12Com(s.list, 9, 'int', [])();
    var fe = d12Out();
    r = d12Com(dev, 36, 'int', ['uint64', 'int', 'pointer', 'pointer'])(uint64(0), 0, d12.iid.fence, fe);
    if (r < 0) throw new Error('CreateFence ' + d12Hr(r));
    s.fence = fe.readPointer();
    s.lists = Memory.alloc(4);
    s.lists.writePointer(s.list);
    s.heaps = Memory.alloc(4);
    s.heaps.writePointer(s.srvHeap);
    s.barrier = Memory.alloc(24);
    s.viewport = Memory.alloc(24);
    [0, 0, s.width, s.height, 0, 1].forEach(function (v, j) { s.viewport.add(4 * j).writeFloat(v); });
    s.scissor = Memory.alloc(16);
    [0, 0, s.width, s.height].forEach(function (v, j) { s.scissor.add(4 * j).writeS32(v); });
    s.constants = Memory.alloc(48);
    s.cursors = {};
    s.rtvs = Memory.alloc(4);
    var luid = Memory.alloc(8);
    d12Com(dev, 43, 'void', ['pointer'])(luid);
    d12.luid = { high: luid.add(4).readS32(), low: luid.readU32() };
    d12.backend = 12;
    note('backend 12: swap chain ' + s.width + 'x' + s.height + ' format ' + s.format + ', adapter LUID ' +
         d12.luid.high + ':' + d12.luid.low);
    return s;
}

// Opens a GPU layer's textures and fences on this device, once.
function d12Open(s, layer) {
    var g = layer.d12;
    if (g !== undefined && g.device.equals(s.device)) {
        return g;
    }
    if (g !== undefined) {
        d12Close(s, layer);
    }
    if (s.srvFree.length === 0) {
        return null;
    }
    var objects = [];
    for (var i = 0; i < 4; i++) {
        var handle = layer.view.add(D12_HANDLES + 4 * i).readU32();
        var o = d12Out();
        var r = d12Com(s.device, 32, 'int', ['pointer', 'pointer', 'pointer'])(ptr(handle), i < 2 ? d12.iid.resource : d12.iid.fence, o);
        if (r < 0) {
            objects.forEach(d12Release);
            d12Fail('OpenSharedHandle of layer ' + layer.id + ' ' + d12Hr(r));
            return null;
        }
        objects.push(o.readPointer());
    }
    var desc = Memory.alloc(64);
    d12Com(objects[0], 10, 'void', ['pointer'])(desc);
    g = { device: s.device, textures: [objects[0], objects[1]], ready: objects[2], done: objects[3],
          width: desc.add(16).readU32(), height: desc.add(24).readU32(), slot: s.srvFree.pop(), frame: 0 };
    for (var t = 0; t < 2; t++) {
        d12Com(s.device, 18, 'void', ['pointer', 'pointer', 'uint32'])(g.textures[t], NULL, s.srvCpu + (2 * g.slot + t) * s.srvStep);
    }
    layer.d12 = g;
    return g;
}

function d12Close(s, layer) {
    var g = layer.d12;
    if (g === undefined) {
        return;
    }
    d12Release(g.textures[0]);
    d12Release(g.textures[1]);
    d12Release(g.ready);
    d12Release(g.done);
    if (s !== null && g.device.equals(s.device)) {
        s.srvFree.push(g.slot);
    }
    delete layer.d12;
}

// A closed layer's GPU objects go once our last draw that used them is done.
function d12Retire(layer) {
    if (layer.d12 === undefined) {
        return;
    }
    d12.retired.push({ g: layer.d12, after: d12.chain === null ? 0 : d12.chain.value });
    delete layer.d12;
}

function d12ReleaseRetired(s, completed) {
    var kept = [];
    for (var i = 0; i < d12.retired.length; i++) {
        var r = d12.retired[i];
        if (completed.compare(uint64(r.after)) < 0) {
            kept.push(r);
            continue;
        }
        d12Release(r.g.textures[0]);
        d12Release(r.g.textures[1]);
        d12Release(r.g.ready);
        d12Release(r.g.done);
        if (r.g.device.equals(s.device)) {
            s.srvFree.push(r.g.slot);
        }
    }
    d12.retired = kept;
}

// Whether a layer is the GPU path's: a visible TOP-plane layer of backend 12.
function d12Wants(layer) {
    return d12.backend === 12 && layer.header >= 128 && overlayRead(layer, D12_GPU) === 1 &&
        (overlayRead(layer, 44) & OVERLAY_WORLD) === 0;
}

// Whether this file draws the layer: its newest frame is in a texture, and the
// GPU has finished at least one.  Until then backend 7 shows the file's frame,
// so a layer never blinks out while it moves to the GPU.
function d12Owns(layer) {
    return d12Wants(layer) && layer.d12 !== undefined && layer.d12.frame > 0;
}

function d12Barrier(s, res, before, after) {
    var b = s.barrier;
    b.writeU32(0); b.add(4).writeU32(0); b.add(8).writePointer(res); b.add(12).writeU32(0xffffffff);
    b.add(16).writeU32(before); b.add(20).writeU32(after);
    d12Com(s.list, 26, 'void', ['uint32', 'pointer'])(1, b);
}

function d12OnPresent(sc) {
    if (d12.error !== null) {
        // Removed device: the fence reads UINT64_MAX, so all of it goes.
        var old = d12.chain;
        if (old !== null && d12.retired.length > 0 && old.sc.equals(sc)) {
            d12ReleaseRetired(old, d12Com(old.fence, 8, 'uint64', [])());
        }
        return;
    }
    if (d12.notD3D12[sc.toString()]) {
        return;
    }
    if (d12.chain === null || !d12.chain.sc.equals(sc)) {
        d12.chain = d12Setup(sc);
        if (d12.chain === null) {
            return;
        }
        d12Tell();
    }
    var s = d12.chain;
    if (d12.retired.length > 0) {
        d12ReleaseRetired(s, d12Com(s.fence, 8, 'uint64', [])());
    }
    if (!askEnabled) {
        return;
    }
    // The layers to draw, bottom first, each with its newest finished frame.
    var shown = [];
    var all = overlayShownAll(false);
    for (var i = 0; i < all.length; i++) {
        var layer = all[i];
        if (!d12Wants(layer)) {
            continue;
        }
        var g = d12Open(s, layer);
        if (g === null) {
            continue;
        }
        var frame = d12Com(g.ready, 8, 'uint64', [])();
        g.frame = frame.toNumber();
        if (g.frame > 0) {
            shown.push({ layer: layer, g: g, frame: frame });
        }
    }
    var cursor = d12.cursor;
    d12.cursor = null;
    if (shown.length === 0) {
        return;
    }
    var completed = d12Com(s.fence, 8, 'uint64', [])();
    var slot = -1;
    for (var k = 0; k < s.allocators.length; k++) {
        if (completed.compare(uint64(s.done[k])) >= 0) {
            slot = k;
            break;
        }
    }
    if (slot < 0) {
        if (s.allocators.length >= D12_ALLOCATORS_MAX) {
            return;
        }
        var grown = d12Out();
        if (d12Com(s.device, 9, 'int', ['int', 'pointer', 'pointer'])(0, d12.iid.allocator, grown) < 0) {
            return;
        }
        s.allocators.push(grown.readPointer());
        s.done.push(0);
        slot = s.allocators.length - 1;
    }
    var s3 = d12Out();
    if (d12Com(sc, 0, 'int', ['pointer', 'pointer'])(d12.iid.swap3, s3) < 0) {
        return;
    }
    var index = d12Com(s3.readPointer(), 36, 'uint32', [])();
    d12Release(s3.readPointer());
    var res = d12Out();
    if (d12Com(sc, 9, 'int', ['uint32', 'pointer', 'pointer'])(index, d12.iid.resource, res) < 0) {
        return;
    }
    var buffer = res.readPointer();
    var rtv = s.rtv0 + index * s.rtvStep;
    d12Com(s.device, 20, 'void', ['pointer', 'pointer', 'uint32'])(buffer, NULL, rtv);
    d12Com(s.allocators[slot], 8, 'int', [])();
    var l = s.list;
    d12Com(l, 10, 'int', ['pointer', 'pointer'])(s.allocators[slot], NULL);
    var cursorTexture = cursor === null ? null : d12CursorTexture(s, l, cursor.handle);
    d12Barrier(s, buffer, 0, 4);
    s.rtvs.writeU32(rtv);
    d12Com(l, 46, 'void', ['uint32', 'pointer', 'int', 'pointer'])(1, s.rtvs, 0, NULL);
    d12Com(l, 21, 'void', ['uint32', 'pointer'])(1, s.viewport);
    d12Com(l, 22, 'void', ['uint32', 'pointer'])(1, s.scissor);
    d12Com(l, 30, 'void', ['pointer'])(s.root);
    d12Com(l, 25, 'void', ['pointer'])(s.pso);
    d12Com(l, 28, 'void', ['uint32', 'pointer'])(1, s.heaps);
    d12Com(l, 20, 'void', ['int'])(5);
    var fit = d12Fit(s);
    for (var n = 0; n < shown.length; n++) {
        var item = shown[n];
        var x = overlayRead(item.layer, 32), y = overlayRead(item.layer, 36);
        var x0 = fit.x + x * fit.sx, y0 = fit.y + y * fit.sy;
        d12Quad(s, l, x0, y0, x0 + item.layer.width * fit.sx, y0 + item.layer.height * fit.sy,
                [0, 0, item.layer.width / item.g.width, item.layer.height / item.g.height], 1,
                2 * item.g.slot + (item.frame.toNumber() % 2));
    }
    if (cursorTexture !== null) {
        d12CursorDraw(s, l, fit, cursor, cursorTexture);
    }
    d12Barrier(s, buffer, 4, 0);
    d12Com(l, 9, 'int', [])();
    d12Com(s.queue, 10, 'void', ['uint32', 'pointer'])(1, s.lists);
    s.value += 1;
    d12Com(s.queue, 14, 'int', ['pointer', 'uint64'])(s.fence, uint64(s.value));
    s.done[slot] = s.value;
    for (var m = 0; m < shown.length; m++) {
        // After our draw on the queue: the JVM may reuse the texture then.
        d12Com(s.queue, 14, 'int', ['pointer', 'uint64'])(shown[m].g.done, shown[m].frame);
    }
    d12Release(buffer);
}

// One pipeline over the layer shaders, blending premultiplied colour onto
// the back buffer with DestBlend `dest` (D3D12_BLEND: 6 INV_SRC_ALPHA, 2 ONE).
function d12Pso(dev, s, dest) {
    var p = Memory.alloc(572);
    for (var k = 0; k < 572; k += 4) p.add(k).writeU32(0);
    p.writePointer(s.root);
    p.add(4).writePointer(d12.shaders.vs.at); p.add(8).writeU32(d12.shaders.vs.size);
    p.add(12).writePointer(d12.shaders.ps.at); p.add(16).writeU32(d12.shaders.ps.size);
    [1, 0, 2, dest, 1, 2, dest, 1, 4, 0xF].forEach(function (v, j) { p.add(72 + 4 * j).writeU32(v); });
    p.add(392).writeU32(0xFFFFFFFF);
    [3, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0].forEach(function (v, j) { p.add(396 + 4 * j).writeU32(v); });
    p.add(448).writeU32(8);
    [1, 1, 1, 8].forEach(function (v, j) { p.add(460 + 4 * j).writeU32(v); p.add(476 + 4 * j).writeU32(v); });
    p.add(504).writeU32(3);
    p.add(508).writeU32(1);
    p.add(512).writeU32(s.format);
    p.add(548).writeU32(1);
    var pso = d12Out();
    var r = d12Com(dev, 10, 'int', ['pointer', 'pointer', 'pointer'])(p, d12.iid.pso, pso);
    if (r < 0) throw new Error('CreateGraphicsPipelineState ' + d12Hr(r));
    return pso.readPointer();
}

// One textured quad in swap chain pixels, sampling descriptor `srv` of the
// heap over `uv` (u0, v0, u1, v1), its colour times `tint`.
function d12Quad(s, l, x0, y0, x1, y1, uv, tint, srv) {
    var c = s.constants;
    [2 * x0 / s.width - 1, 1 - 2 * y0 / s.height, 2 * x1 / s.width - 1, 1 - 2 * y1 / s.height,
     uv[0], uv[1], uv[2], uv[3], tint, tint, tint, tint].forEach(function (v, j) { c.add(4 * j).writeFloat(v); });
    d12Com(l, 36, 'void', ['uint32', 'uint32', 'pointer', 'uint32'])(0, 12, c, 0);
    d12Com(l, 32, 'void', ['uint32', 'uint64'])(1, s.srvGpu.add(uint64(srv * s.srvStep)));
    d12Com(l, 12, 'void', ['uint32', 'uint32', 'uint32', 'uint32'])(4, 1, 0, 0);
}

// Backend 12's own cursor.  A layer drawn at Present covers the game's
// cursor, which the game drew into its frame before.  So while one of them
// shows, mouse::draw (99-overlay.js) leaves the game's cursor out and hands
// its shape to d12CursorTake, and Present draws it above every layer, as
// mouse::draw would have: a 64x64 quad at the mouse plus the shape's offset,
// and for the glow 49 more at alpha 8, added, moved -6..6 in steps of 2
// (mappings: mouse shape draw).  The pictures come from the game's own
// surfaces, read once per texture handle, so a loose .\PAK\MOUSE_*.TGA shows
// too.  A dragged item's 3D model cannot be drawn here: the game draws it.
var D12_CURSOR = 64;
var D12_GLOW = 8 / 255;
var d12TextureGet = new NativeFunction(at(RVA.textureGet), 'pointer', ['pointer', 'int', 'int'], { abi: 'thiscall' });

// Whether backend 12 draws the cursor this frame: one of its layers shows.
function d12CursorWanted() {
    if (d12.backend !== 12 || d12.chain === null) {
        return false;
    }
    var all = overlayShownAll(false);
    for (var i = 0; i < all.length; i++) {
        if (d12Owns(all[i])) {
            return true;
        }
    }
    return false;
}

// At mouse::draw's entry: records the shape the game is about to draw for
// this frame's Present.  False when the game must draw it itself.
function d12CursorTake(mouse, glow) {
    var shape = mouse.add(0x64).readPointer();
    if (shape.isNull() || (shape.readU16() & 2) !== 0) {
        return false;
    }
    var handle = shape.add(0xC).readU32();
    if (!(handle in d12.cursorPixels)) {
        d12.cursorPixels[handle] = d12CursorPixels(handle);
    }
    if (d12.cursorPixels[handle] === null) {
        return false;
    }
    d12.cursor = {
        handle: handle,
        x: mouse.add(4).readS32() + shape.add(2).readS16(),
        y: mouse.add(8).readS32() + shape.add(4).readS16(),
        uv: [shape.add(0x10).readFloat(), shape.add(0x14).readFloat(), shape.add(0x18).readFloat(), shape.add(0x1C).readFloat()],
        // As mouse::draw sets the shape's bit 0: its argument, and no item held.
        glow: glow && mouse.add(0x68).readU32() === 0
    };
    return true;
}

// A texture's picture as premultiplied RGBA bytes, read from the game's
// surface (Lock slot 25 read-only, Unlock slot 32), or null.
function d12CursorPixels(handle) {
    try {
        var tex = d12TextureGet(ptr(VA.textureMgr).readPointer(), handle, 0);
        if (tex.isNull()) {
            return null;
        }
        var surface = tex.add(0x14).readPointer();
        var desc = Memory.alloc(124);
        desc.writeU32(124);
        if (d12Com(surface, 25, 'int', ['pointer', 'pointer', 'uint32', 'pointer'])(NULL, desc, 0x1 | 0x10, NULL) !== 0) {
            return null;
        }
        var h = desc.add(8).readU32(), w = desc.add(12).readU32(), pitch = desc.add(16).readS32();
        var bytes = desc.add(84).readU32() / 8;
        var masks = [desc.add(88).readU32(), desc.add(92).readU32(), desc.add(96).readU32(), desc.add(100).readU32()];
        var rows = new DataView(desc.add(36).readPointer().readByteArray(pitch * h));
        d12Com(surface, 32, 'int', ['pointer'])(NULL);
        if (bytes !== 2 && bytes !== 4) {
            return null;
        }
        var out = new Uint8Array(w * h * 4);
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var v = bytes === 2 ? rows.getUint16(y * pitch + 2 * x, true) : rows.getUint32(y * pitch + 4 * x, true);
                var a = d12Channel(v, masks[3]);
                for (var k = 0; k < 3; k++) {
                    out[4 * (y * w + x) + k] = Math.round(d12Channel(v, masks[k]) * a / 255);
                }
                out[4 * (y * w + x) + 3] = a;
            }
        }
        return { width: w, height: h, bytes: out.buffer };
    } catch (e) {
        note('cursor picture ' + handle + ': ' + e.message);
        return null;
    }
}

function d12Channel(v, mask) {
    if (mask === 0) {
        return 255;
    }
    var m = mask >>> 0, shift = 0;
    while ((m & 1) === 0) {
        m >>>= 1;
        shift++;
    }
    return Math.round((((v >>> 0) & mask) >>> shift) * 255 / m);
}

// The cursor's texture on this swap chain's device: made, uploaded and
// moved to PIXEL_SHADER_RESOURCE on list `l` the first time.  Null when the
// heap has no descriptor left.
function d12CursorTexture(s, l, handle) {
    var known = s.cursors[handle];
    if (known !== undefined) {
        return known;
    }
    var pic = d12.cursorPixels[handle];
    if (pic === null || pic === undefined || s.srvFree.length === 0) {
        return null;
    }
    var dev = s.device;
    var heap = Memory.alloc(20);
    heap.writeU32(1);                                            // DEFAULT
    var desc = Memory.alloc(56);
    for (var k = 0; k < 56; k += 4) desc.add(k).writeU32(0);
    desc.writeU32(3);                                            // TEXTURE2D
    desc.add(16).writeU32(pic.width);
    desc.add(24).writeU32(pic.height);
    desc.add(28).writeU16(1);
    desc.add(30).writeU16(1);
    desc.add(32).writeU32(28);                                   // R8G8B8A8_UNORM
    desc.add(36).writeU32(1);
    var tex = d12Out();
    var create = d12Com(dev, 27, 'int', ['pointer', 'uint32', 'pointer', 'uint32', 'pointer', 'pointer', 'pointer']);
    if (create(heap, 0, desc, 0x400 /* COPY_DEST */, NULL, d12.iid.resource, tex) < 0) {
        return null;
    }
    var pitch = Math.ceil(pic.width * 4 / 256) * 256;
    heap.writeU32(2);                                            // UPLOAD
    for (k = 0; k < 56; k += 4) desc.add(k).writeU32(0);
    desc.writeU32(1);                                            // BUFFER
    desc.add(16).writeU32(pitch * pic.height);
    desc.add(24).writeU32(1);
    desc.add(28).writeU16(1);
    desc.add(30).writeU16(1);
    desc.add(36).writeU32(1);
    desc.add(44).writeU32(1);                                    // ROW_MAJOR
    var upload = d12Out();
    if (create(heap, 0, desc, 0xAC3 /* GENERIC_READ */, NULL, d12.iid.resource, upload) < 0) {
        d12Release(tex.readPointer());
        return null;
    }
    var mapped = d12Out();
    var range = Memory.alloc(8);
    range.writeU32(0); range.add(4).writeU32(0);
    d12Com(upload.readPointer(), 8, 'int', ['uint32', 'pointer', 'pointer'])(0, range, mapped);
    var rows = new Uint8Array(pic.bytes);
    for (var y = 0; y < pic.height; y++) {
        mapped.readPointer().add(y * pitch).writeByteArray(rows.slice(y * pic.width * 4, (y + 1) * pic.width * 4).buffer);
    }
    range.add(4).writeU32(pitch * pic.height);
    d12Com(upload.readPointer(), 9, 'void', ['uint32', 'pointer'])(0, range);
    // D3D12_TEXTURE_COPY_LOCATION on x86: resource, type, then the union at +8.
    var into = Memory.alloc(40), from = Memory.alloc(40);
    into.writePointer(tex.readPointer()); into.add(4).writeU32(0); into.add(8).writeU32(0);
    from.writePointer(upload.readPointer()); from.add(4).writeU32(1);
    from.add(8).writeU32(0); from.add(12).writeU32(0);
    from.add(16).writeU32(28); from.add(20).writeU32(pic.width); from.add(24).writeU32(pic.height);
    from.add(28).writeU32(1); from.add(32).writeU32(pitch);
    d12Com(l, 16, 'void', ['pointer', 'uint32', 'uint32', 'uint32', 'pointer', 'pointer'])(into, 0, 0, 0, from, NULL);
    d12Barrier(s, tex.readPointer(), 0x400, 0x80);
    var slot = s.srvFree.pop();
    d12Com(dev, 18, 'void', ['pointer', 'pointer', 'uint32'])(tex.readPointer(), NULL, s.srvCpu + 2 * slot * s.srvStep);
    known = { texture: tex.readPointer(), upload: upload.readPointer(), srv: 2 * slot };
    s.cursors[handle] = known;
    return known;
}

function d12CursorDraw(s, l, fit, c, t) {
    var x0 = fit.x + c.x * fit.sx, y0 = fit.y + c.y * fit.sy;
    var w = D12_CURSOR * fit.sx, h = D12_CURSOR * fit.sy;
    d12Quad(s, l, x0, y0, x0 + w, y0 + h, c.uv, 1, t.srv);
    if (!c.glow) {
        return;
    }
    d12Com(l, 25, 'void', ['pointer'])(s.psoAdd);
    for (var dy = -6; dy <= 6; dy += 2) {
        for (var dx = -6; dx <= 6; dx += 2) {
            var gx = x0 + dx * fit.sx, gy = y0 + dy * fit.sy;
            d12Quad(s, l, gx, gy, gx + w, gy + h, c.uv, D12_GLOW, t.srv);
        }
    }
    d12Com(l, 25, 'void', ['pointer'])(s.pso);
}

// Where the game's frame lies in the swap chain's, and its scale: layers are
// placed in the game's pixels.  A plain stretch to the whole output, seen
// right at the owner's forced 2560x1600, windowed, and with display scaling;
// dgVoodoo's scaling modes with bars are untried (docs/BACKEND12.md).
function d12Fit(s) {
    var game = nativeDisplay();
    if (game === null || game.width === 0 || game.height === 0) {
        return { x: 0, y: 0, sx: 1, sy: 1 };
    }
    return { x: 0, y: 0, sx: s.width / game.width, sy: s.height / game.height };
}

// Why backend 7 is final, '' while backend 12 may still come, or null on 12.
function d12Why() {
    if (d12.backend === 12) {
        return null;
    }
    if (d12.error !== null) {
        return d12.error;
    }
    if (Object.keys(d12.notD3D12).length > 0) {
        return 'the game presents without Direct3D 12';
    }
    if (Process.findModuleByName('d3d12.dll') === null) {
        return 'the game has not loaded Direct3D 12';
    }
    return '';
}

function d12Report() {
    var why = overlayCError !== null ? 'layers cannot show: ' + overlayCError : d12Why();
    var on = overlayCError === null && d12.backend === 12 && d12.chain !== null;
    return {
        backend: overlayCError !== null ? 0 : d12.backend,
        backend_width: on ? d12.chain.width : 0,
        backend_height: on ? d12.chain.height : 0,
        backend_luid_high: d12.luid === null ? 0 : d12.luid.high,
        backend_luid_low: d12.luid === null ? 0 : d12.luid.low,
        backend_pid: Process.id,
        backend_error: why || '',
        backend_pending: why === '' ? 1 : 0
    };
}

// The backend in a stage's fields.  `wait`: the first held stage, on the game
// thread, waits for the decision.  Thread.sleep lets Frida's thread and the
// presenting thread run in the meantime.
function d12StageFields(fields, wait) {
    if (wait && d12.told === null) {
        var from = Date.now();
        while (overlayCError === null && d12Why() === '' && Date.now() - from < D12_DECIDE_MS) {
            Thread.sleep(0.02);
        }
        note('drawing backend ' + d12.backend + ' at the first stage, after ' + (Date.now() - from) + ' ms');
    }
    var report = d12Report();
    d12.told = JSON.stringify(report);
    for (var key in report) {
        fields[key] = report[key];
    }
    return fields;
}

// A decision the JVM does not have yet, once a stage has told it anything.
function d12Tell() {
    if (d12.told === null) {
        return;
    }
    var report = d12Report();
    var text = JSON.stringify(report);
    if (text !== d12.told) {
        d12.told = text;
        evt('overlay.backend', report);
    }
}
