// node --test "tests/*.test.mjs"

import assert from "node:assert/strict";
import { test } from "node:test";

import { compact, moduleName, sites } from "../tools/compact.mjs";

test("comments go and code stays", () => {
    const source = "// a note\nvar a = 1;  // trailing\n\n/* block\n   spanning */\nvar b = 2;\n";
    assert.equal(compact(source), "var a = 1;\nvar b = 2;\n");
});

test("a slash in a string is not a comment", () => {
    const source = "var url = \"https://ancaria.dev\"; // real\n";
    assert.equal(compact(source), "var url = \"https://ancaria.dev\";\n");
});

test("a regex survives with its slashes", () => {
    const source = "var shape = /^TYPE_[A-Z0-9_/]+$/; // note\nvar half = 4 / 2;\n";
    assert.equal(compact(source), "var shape = /^TYPE_[A-Z0-9_/]+$/;\nvar half = 4 / 2;\n");
});

// Joining lines would leave automatic semicolon insertion deciding where a
// statement ends, which is a different program.
test("lines are not joined", () => {
    assert.equal(compact("var a = 1\nvar b = 2\n"), "var a = 1\nvar b = 2\n");
});

test("indentation goes but spacing between tokens stays", () => {
    const source = "function f() {\n        return 1 + 2;\n}\n";
    assert.equal(compact(source), "function f() {\nreturn 1 + 2;\n}\n");
});

test("sites are read off the calls", () => {
    const source = "hook(\"goldDelta\", RVA.goldDelta, {});\n"
        + "attachHp(\"hpDamage\",\n    RVA.hpDamage, {});\n"
        + "hook(\"goldDelta\", RVA.goldDelta, {});\n";
    assert.deepEqual(sites(source), ["goldDelta", "hpDamage"]);
});

test("sites ignore comments", () => {
    const source = "// hook(\"example\", RVA.example, ...)\nhook(\"real\", RVA.real, {});\n";
    assert.deepEqual(sites(source), ["real"]);
});

// `at(RVA.x)` is a lookup, not an attach.
test("a bare address is not a site", () => {
    const source = "var fn = new NativeFunction(at(RVA.typeNameFn), \"pointer\");\n";
    assert.deepEqual(sites(source), []);
});

test("module names drop the order prefix", () => {
    assert.equal(moduleName("50-health.js"), "health");
    assert.equal(moduleName("99-overlay-d3d12.js"), "overlay-d3d12");
});
