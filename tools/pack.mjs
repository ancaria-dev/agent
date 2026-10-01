// Packs the agent the way the host loads it.
//
//     node tools/pack.mjs [--version <version>]
//
// Writes dist/agent/ and dist/agent.zip: addr.js and every module minified,
// hooks.json read off the unminified sources, and agent.json. Needs
// src/gen/addr.js, which `python tools/addr.py` writes.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { compact, moduleName, sites } from "./compact.mjs";

// Raise together with AGENT_PROTOCOL in protocol whenever the messages between
// the host and the agent change shape.
const PROTOCOL = 1;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

function argument(name, fallback) {
    const at = process.argv.indexOf(name);
    if (at < 0) {
        return fallback;
    }
    const value = process.argv[at + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`${name} needs a value`);
    }
    return value;
}

function byName(a, b) {
    return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function pack(version) {
    const addr = path.join(SRC, "gen", "addr.js");
    if (!fs.existsSync(addr)) {
        throw new Error("src/gen/addr.js is missing. Run `python tools/addr.py` first.");
    }
    const files = new Map();
    files.set("addr.js", compact(fs.readFileSync(addr, "utf8")));

    // Load order is file-name order: every module shares one scope and a later
    // definition wins.
    const modules = fs.readdirSync(SRC, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
        .map((entry) => entry.name)
        .sort(byName);
    const hooks = [];
    for (const name of modules) {
        const source = fs.readFileSync(path.join(SRC, name), "utf8");
        const found = sites(source);
        if (found.length > 0) {
            hooks.push({ hooks: found, module: moduleName(name) });
        }
        files.set(name, compact(source));
    }
    files.set("hooks.json", JSON.stringify(hooks));
    files.set("agent.json", JSON.stringify({ version, protocol: PROTOCOL }));
    return files;
}

function write(files) {
    const staged = path.join(DIST, "agent");
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(staged, { recursive: true });
    for (const [name, text] of files) {
        fs.writeFileSync(path.join(staged, name), text);
    }
    fs.writeFileSync(path.join(DIST, "agent.zip"), zip(files));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
});

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (const b of bytes) {
        c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// A plain deflate zip, entries sorted by name, every time stamp 1980-01-01
// 00:00, so the same sources always give the same bytes.
function zip(files) {
    const DOS_TIME = 0;
    const DOS_DATE = (0 << 9) | (1 << 5) | 1;
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const name of [...files.keys()].sort(byName)) {
        const data = Buffer.from(files.get(name), "utf8");
        const packed = zlib.deflateRawSync(data, { level: 9 });
        const fileName = Buffer.from(name, "utf8");
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034B50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(fileName.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, fileName, packed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014B50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(fileName.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, fileName);

        offset += local.length + fileName.length + packed.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054B50, 0);
    end.writeUInt16LE(files.size, 8);
    end.writeUInt16LE(files.size, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

const version = argument("--version", "dev").replace(/^v/, "");
const files = pack(version);
write(files);
console.log(`dist/agent.zip: ${files.size} files, agent ${version}, protocol ${PROTOCOL}`);
