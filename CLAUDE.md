# agent

Workspace rules, target build, and elevation: see `../CLAUDE.md`.

## Boundaries

- This repository is the plain JavaScript Frida injects into the game: `src/NN-*.js`, the address table `src/gen/addr.js`, and the build fingerprint `signatures.json`. It moved here from `coderpack/agent/` with its history.
- `protocol` owns injection, bundling at attach, JVM startup, routing, and the verdict deadline. `coderpack` owns the API and zygote. `launcher` owns installing `agent.zip`. Never move their duties here.
- Native game calls and memory access stay in the agent. The agent never talks to the JVM directly: it sends with Frida `send()` and receives the host's JSON through `recv()`.
- Every game address comes from `mappings` through `tools/addr.py`. Never type one into a module.

## Layout

- `src/NN-name.js`: the modules. `src/gen/` is generated, ignored, and marked generated in `.gitattributes`.
- `tools/addr.py` writes `src/gen/addr.js` from `mappings.json` and `signatures.json`. `tools/hooksafe.py` checks hook sites and writes `signatures.json`. Both find files through `tools/paths.py` and the game through `tools/game.py`.
- `tools/compact.mjs` is the minifier and hook reader. `tools/pack.mjs` writes `dist/agent/` and `dist/agent.zip`. `tools/install.ps1` packs and installs into a game folder.
- `tests/buildcheck.js`, `tests/compact.test.mjs`, `tests/inject_python.py`.
- `docs/RUNNING.md`: installing into the game, bisecting a crash.

## Validation

- After a code, address, or hook change run:
  - `python tools/addr.py`
  - `python tools/hooksafe.py`
  - `node tests/buildcheck.js`
  - `node --test "tests/*.test.mjs"`
  - `node tools/pack.mjs`
- Node 24 or newer; `node --test tests/` treats the folder as a file, so pass the glob. `hooksafe.py` needs `pefile` and `capstone`. Nothing here uses npm.
- A fresh checkout has no `src/gen/addr.js`. Run `python tools/addr.py` first; `pack.mjs` refuses without it.
- `hooksafe.py` looks in `D:\SteamLibrary\steamapps\common\Sacred Gold` by default; pass an executable or game directory otherwise. When it finds no game it prints `skipped` and exits 0. A skip is not evidence of safety. CI cannot run it, so run it locally for every new hooked row.
- `hooksafe.py` warnings are not failures. `getLocalHero` relocates a call, and `chestOpen` is reported carrying ECX because the code linearly before it ends in a `jmp` (see its row); these are known and shipping.
- `tests/buildcheck.js` is the only no-game test that runs agent JavaScript: `gen/addr.js` plus `10-core.js` in one Node `vm`. Keep tested code within the QuickJS feature set.
- `tests/inject_python.py` injects the same bundle with the installed frida-python, separating a Frida-version failure from a hook failure. It answers every ASK with no change.
- `coderpack`'s `NextFrameTest`, `SampledTest`, and `RegistryTest` read these sources. Run `gradlew :zygote:test` there after changing commands, samplers, or wire names.

## Addresses and build identity

- `tools/paths.py` takes `mappings.json` from, in order: a command-line path, `$AGENT_MAPPINGS`, sibling `../mappings`, then GitHub at the ref in `.mappings-ref`, cached under `build/mappings/`. Put a tag or commit in `.mappings-ref` for a reproducible local build. A release checks mappings out at a tag and passes the path.
- `signatures.json` is generated. Write it only with `python tools/hooksafe.py --signatures [path]` against a real `pureHD.exe`. Never edit its bytes; a false signature warns on the correct game and trains users to ignore warnings.
- `addr.py` copies the signatures into `gen/addr.js` as `BUILD`; `10-core.js` compares them with the running process at attach.
- Keep a signature mismatch a warning. The agent still hooks at the current RVAs. Refusing would also block an unrecorded build that works. Stock `Sacred.exe` differs at every site, so its hooks can land in unrelated code.
- The agent checks instruction bytes, never version metadata. The fingerprint is the whole set of sites, since several signatures are the same generic SEH prologue. Version reading belongs to the launcher.

## Packing

- `compact` is a port of `protocol`'s former `src/js.rs` and must stay byte for byte what that produced. Keep it minimal: strip comments, indentation, blank lines, and repeated spaces only. Never rename, reorder, drop declarations, or join lines. All modules share one scope, so a “smarter” minifier silently loses code, and line breaks carry automatic semicolon insertion.
- `sites` reads hook names off calls shaped `name("site", RVA.site, ...)`, from the unminified sources with comments stripped. A site missing from `hooks.json` is a site nobody can switch off in the launcher, so install every hook through such a call.
- Duplicate helper names overwrite silently; filename order decides the winner. The host loads `addr.js`, then its `NO_HOOK`/`HOOK_TRACE` preamble, then `[0-9][0-9]-*.js` sorted by name.
- `agent.zip` is flat: `addr.js`, every module minified, `hooks.json` (`[{"hooks":[...],"module":"health"}, ...]`, one entry per module with sites, in load order), and `agent.json` (`{"version":"<version>","protocol":1}`). Entries are sorted and time-stamped 1980-01-01, so the same sources give the same bytes.
- `PROTOCOL` in `tools/pack.mjs` must equal the host's `AGENT_PROTOCOL`; the host refuses any other number. Raise both together whenever a message between host and agent changes shape: a `send()` payload, a posted JSON, a command's arguments or answer.

## Release

- A release is the `Release` button in Actions (`release.yml`) with a version. No version file exists; the version lives only in tag `v<version>` and `agent.json`.
- The `mappings` input picks the mappings release to bake in, empty meaning the latest. With no mappings release the workflow uses `master` and warns. The release notes name the mappings version.
- `devops` starts this workflow after every `mappings` release and then refreshes `meta.json`, from which the launcher downloads `agent.zip`. A merged change reaches players only through a release.
- `ci.yml` checks, tests, and packs on every push and pull request. It never publishes.

## Hook safety

Every rule here comes from a reproduced crash or corruption.

- Run `tools/hooksafe.py` before shipping a hook. Every `FATAL` is a hard stop.
- Never hook an instruction shorter than five bytes when a branch targets the next instruction. Frida's patch spills forward and the branch lands inside the trampoline. The four-byte skill write at `+0x1827DA` killed every character with an empty skill slot; `70-skills.js` hooks one instruction later.
- Never split a flag-setting instruction from the branch that reads its flags. The old gold hook put `cmp [eax+0xc], ebx` inside the patch and its `je` outside, and crashed on every world load.
- Avoid mid-function hooks where EAX, ECX, or EDX is loaded before the patch and read after it. Three such sites failed; two AddGold sites returned with EDI destroyed; the level write at `+0x185EBE` crashed while loading a save. Move to the entry of the function that holds the write and compare the state around the call, as `regenTick` in `50-health.js` does. Sample only when no entry works (see Sampling).
- Use `onLeave` only at a function entry. Mid-function, `[esp]` is not a return address. The `--trace` wrapper adds `onLeave` only when the hook already has one.
- Mid-function, never patch an instruction that reads or moves ESP: an ESP-relative operand, `add`/`sub esp`, `push`, `pop`. Treat hooksafe's ESP-relative warning as a hard stop there. In `receive_event`'s epilogue, a hook on `mov ecx, [esp+0x3E4]` and then one on `add esp, 0x3E4` each crashed the game while loading, with callbacks that did nothing. The two AddGold sites that returned with EDI destroyed had the same shape. Function entries with `push` or `sub esp` in the patch have always worked.
- A mid-function hook can break the game when `hooksafe.py` passes and the callback does nothing. At `+0x244A8` every kill granted 74063647 experience. At `+0x1827DE`, together with the hook on `uiEvent`'s entry, every skill point spent crashed the game; neither alone did. At the kill function's entry the experience came out right, and an empty hook at the skill function's entry did not crash. At `+0x17EAE4`, the experience write, a quest reward after a kill crashed the game while `world`, `weather`, `entities` or `places` was loaded, and every kill crashed with `addExperience`'s entry hooked too. Each time a mid-function hook broke with a hooked call further up the stack; why is not known. Prefer an entry, and see a new mid-function site work in the game before shipping it.
- Avoid `onLeave` on a function the game may leave by an exception: a UI handler, a command's `execute`, anything that sends through the kernel. Frida's return stack for the thread keeps the entry, and the next `onLeave` on that thread returns into the heap. Track the call with `callOpen` in `10-core.js` instead.
- `<game>/launcher/logs/agent-crash-<time>.log`, one per run, records a native fault: address, registers, stack, backtrace. EIP in the heap with `frida-agent.dll` in the stack does not by itself say which hook did it; bisect with `--only` and `--no-hook`.
- Never attach to a writer that runs once per object during world load. `cObjectManager::load` unpacks thousands of objects; the attribute recalculation writers at `+0x179B09..` killed Frida's JIT memory (`Faulting module: unknown`). A player check inside the callback does not reduce the call volume. Hook load and save entries, as `40-session.js` does.
- Never request a verdict while the game is loading. `isLoading()` in `10-core.js` turns the ask into a plain event.
- A loading stage goes through `stage()` in `20-bus.js`, never `ask()`: it decides nothing and may hold the game for seconds.
- A command runs on Frida's thread, which must stay free to deliver a stage's answer. Never call a Win32 function from a command that sends a message to the game's window and waits (`GetWindowTextW`, `SendMessage`): a stage holds that window's thread, and the game froze at `Game:Ready` until closed. `98-native.js` reads the title with `InternalGetWindowText`.
- Read game strings with `readCString()` or `readAnsiString(max)`, never `readCString(max)`: in this Frida a length reads past the NUL. It kept the Game stages from ever matching their labels.
- All agent files share one JavaScript scope. Put shared helpers in `10-core.js` and give others module-specific names. Keep `"module": "none"` in `jsconfig.json`.
- Snapshot a `NativePointer` from `retval` or `this.context.*` with `snapPtr` before storing it; it can alias a live register. `p === null` never detects NULL; use `live()`.
- Read input in the window procedures (`93-input.js`), never in `uiEvent`: key releases, the wheel and the mouse's moves never reach the UI manager. Hit-test at the game's cursor point (`cursorClient`), never a message's `lParam`; a wrapper redirects the game's cursor calls in fullscreen.
- `99-overlay.js` calls Direct3D 7 from C in a CModule. TinyCC ignores `stdcall` on a function pointer, so every COM call goes through the thunk that keeps ESP in EDI; a direct call drifts the stack and crashes after a few dozen. Writing a CModule global faults here, so keep all C state in memory the script allocates.
- `99-overlay-d3d12.js` (design: `coderpack/docs/BACKEND12.md`) calls Direct3D 12 through COM vtables. ReShade wraps `D3D12CreateDevice`, so take the real `ExecuteCommandLists` from a queue made on the swap chain's real device, never from a device of your own. Compile shaders with `D3DCompile` when the script loads: compiling inside a command's callback hung the game. Keep one `Present` hook at a time; two probes on one `Present` crashed the game. COM methods are `stdcall` with `this` first, and on x86 a method that returns a struct (`GetAdapterLuid`, `GetDesc`) takes a hidden pointer right after `this`.
- The agent picks the drawing backend on its own at the game's first Direct3D 12 `Present`. It reports the backend in the fields of every loading stage and in `overlay.backend`; zygote's `OverlayLink.backend` reads them. Never add polling back. Route every backend 12 failure through `d12Fail` in `99-overlay-d3d12.js`, so the agent falls back to backend 7 and the JVM moves layers back to their files.
- While a backend 12 layer shows, the agent draws the cursor at `Present`, above the layers. The `overlayCursor` hook on `mouse::draw` in `99-overlay.js` must keep calling `d12CursorTake`; without it the game's cursor lands under the layers again.
- A GPU layer's hit test reads the picture zygote copies back into the file (`GPU_MASK`, `+116`). Never let that copy make the game or the renderer wait.
- Frida runs QuickJS: use `globalThis`, never `global`; no DOM, no npm. A `globalThis` guard cannot detect a second injection, so `10-core.js` refuses a double install by checking for `0xE9` or `0xCC` at known sites.
- Route integer verdict fields through `asked()` in `20-bus.js`. It validates, falls back on parse failure, and caps above `INT32_MAX`, because a boosted value can overflow before the game's own clamp.
- Count calls before trusting a write hook, with `research/artifacts/probes/count_calls.py`. A combat-art hook that looked safe after one click ran 80,000 times.
- Do not touch the anti-cheat XOR mirrors unless a mod changed the mirrored field. Experience, gold, and level are mirrored behind the protected page at `[0x182DDDC]`. Boost the delta at the function entry; rewriting the committed total makes the checker reset the field to 1.
- Call the game's own function instead of writing its field when one exists. For `thiscall`, Frida takes `this` as the first declared argument.
- An item's type ID exists at `+0x10` and `+0x118`. The game reads `+0x118`; writing only `+0x10` changes nothing visible.
- The script interpreter keeps no code in memory: it reads each function from the open `FunkCode.bin` (`scriptFile`) on every call. Read it only on the engine thread, where the scripts run, and put the stream's position back, as `48-graves.js` does; a moved position runs the next script from the wrong bytes.

## Commands and events

- Each command lives in the module that owns its data, so `--skip` of a module removes its commands and Java sees an empty answer.
- A command the agent answers on a later tick (`commandLater`, `commandOnEngine` in `20-bus.js`) must be in zygote's `GameLink.NEXT_FRAME`; `NextFrameTest` compares the two.
- A new wire name needs a typed entry in zygote's `Registry` and `RegistryTest`, or mods see `Unknown`.
- A window has an `…Show` or `…Hide` class only for a move `SCREEN_ASKS` in `96-screens.js` asks about, and only for a move seen refused in the game. Change `SCREEN_ASKS`, the class, and `Registry` together.
- Never send an event earlier than the `@Stage` its class carries; zygote logs that as a loader bug.

## Sampling

- An event comes from a hook unless no safe hook exists. Search in this order: the write itself, the entry of the function holding it (compare before and after in `onEnter` and `onLeave`), the entry of its caller. Sample only after all three fail `hooksafe.py`, crash, or run too hot, and record why in the sampler's comment and the row's notes.
- A sampler goes through `onSample(rate, [wire names], fn)` in `10-core.js`, never through `onTick` or `onTickEvery`. Those remain for work queues and writes, not for events.
- Rates count frames: `SAMPLE_FREQUENT` every frame, `SAMPLE_NORMAL` every 16th, `SAMPLE_SLOW` every 64th. A sampler reading a few fields is `FREQUENT`. One that walks a table or many records is `NORMAL`. Keep events that pair (mount and dismount, opened and closed, `…Change` and `…Changed`) at one rate.
- `onSample` spreads `NORMAL` and `SLOW` samplers over the 64-frame cycle, least-loaded frame first. Give a costly sampler a `weight` above 1 only from the measured figures, never from a guess.
- The host log carries `sampling per run: <first event> <n> us` every 30 seconds. Read it after adding or moving a sampler, and before promoting one to `FREQUENT`.
- Every event a sampler sends carries `@Sampled` with the same rate in the API, and no other event does. Write the wire names literally in the `onSample` call: zygote's `SampledTest` reads them there.
- A sampled `ASK` decides after the game has applied the change, so a veto undoes it. Avoid adding one; if you must, sample it at `FREQUENT` and say so on the event.

## Sounds and effects

- `56-sound.js` and `57-fx.js` run on the engine thread through `commandOnEngine`.
- Call every cMSS function with `exceptions: "propagate"`. Something under `playMusic` raises an exception the game handles itself, and Frida's default `"steal"` turned every music call into “system error”.
- The sound manager plays nothing while the game's window is in the background (cMSS +0x69C = 1): every `playSFX` then answered slot 0xFFFF. Test sounds with the game in front.
- `playSFX` takes no position, only the ref of an object the sound follows (the game's emitter tables). There is no sound at a point; never add one.
- Stop a loop by slot only while the agent's record says this world still runs it. The game reuses a slot once its sound ends, so a plain sound must never get a stop.
- Never send effect preset 6 or 9 without a creature target: `cParticleSystem_generic::onEvent` reads the target creature unchecked, and preset 6 at a point crashed the game (access violation at +0x396FB0).
- Preset 3 (the arrow) stays until removed. `world.fx_remove` first checks that the ref still holds a `TYPE_FX_GENERIC` `cObjectFX` (`fxVtable`), because the game reuses refs.

## Debugging

- Closing the host does not reliably unload the agent. Restart the game after changing a hook.
- `Faulting module: pureHD.exe` plus an offset gives an RVA and usually points at the hook. `Faulting module: unknown` means Frida JIT memory and often a hook that is too hot.
- `docs/RUNNING.md` covers installing into the game and crash bisection.
