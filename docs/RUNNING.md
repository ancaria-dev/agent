# Running the agent

## Install into the game

The host loads the agent from `<Sacred Gold>/launcher/agent/`, the unpacked
`agent.zip`. The launcher puts a released one there. To run this checkout
instead, name the game folder once in `.local.settings` (not committed):

```
sacred=D:\SteamLibrary\steamapps\common\Sacred Gold
```

Then:

```
pwsh tools/install.ps1
```

It regenerates `src/gen/addr.js`, packs `dist/agent/`, writes it beside the
old folder as `agent.new`, and swaps it in. A failed copy leaves the old agent
in place. The next host start picks the new one up; no host rebuild is needed.

The launcher may overwrite that folder when it applies a newer agent from
`meta.json`. Install again after that.

## Restart the game after changing a hook

Closing the host does not reliably unload an injected agent. The agent refuses
to install on top of an existing one (it checks whether the hook sites are
already patched), but the way out is a game restart, not another host launch.

## Testing without the game

```
python tools/addr.py
node tests/buildcheck.js
node --test "tests/*.test.mjs"
node tools/pack.mjs
```

`buildcheck.js` exercises the warning the agent prints when the module it
attached to is not the build the addresses were found in. It builds a fake
process out of `signatures.json`, evaluates `gen/addr.js` and `10-core.js`
against it, and checks that the right build is silent and a changed one is
not. Frida runs QuickJS rather than Node, so the harness stays inside what both
of them have.

`compact.test.mjs` checks the minifier and the hook reader `pack.mjs` uses.

## When it is not the build the addresses came from

The host attaches to `pureHD.exe`, `Sacred.exe` or `Game.exe`, whichever is
running, and every address belongs to the first of those. On anything else the
agent says so on the console and carries on:

```
[agent] !! this is not the game build Coderpack's addresses were found in.
[agent] !! expected pureHD.exe 2.0.2.118, found Sacred.exe. 38 of 38 hook
           sites hold different instructions (commitStats, expWrite, ...).
[agent] !! hooking it anyway, at whatever those addresses now point at. Mods
           may not behave as expected.
```

Those three lines are the reason to stop reading a crash as a hook bug.

## When the game crashes

Get the faulting address before changing anything:

```powershell
Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'} |
    Select-Object -First 5 | Format-List TimeCreated, Message
```

`Faulting module: pureHD.exe` with a fault offset is an RVA. Disassemble around
it (`artifacts/` in the research repository) and it usually names the hook.
`Faulting module: unknown` means the fault is in Frida's own JIT memory, which
is what hooking something too hot looks like.

`<Sacred Gold>/launcher/logs/agent-crash-<time>.log` holds the registers, stack
and backtrace of a native fault. `<Sacred Gold>/DEBUG.LOG` shows how far the
game got; its last line is the game's own trace, not ours.

## Bisecting a crash

Start the host by hand with the modules you want, elevated if the game is
elevated:

```
cd "<Sacred Gold>\launcher\bin"
protocol.exe --mods "<Sacred Gold>\mods" --only none        core, bus, names and stages only
protocol.exe --mods "<Sacred Gold>\mods" --only health      that plus one module
protocol.exe --mods "<Sacred Gold>\mods" --skip position    everything except one
```

Module names are the file names without the number prefix: `50-health.js` is
`health`. `core`, `bus`, `names` and `stages` always load: the first two are
the runtime, `names` only wraps two of the game's lookups, and without
`stages` no mod past Startup loads.

If `--only none` still crashes, the agent is not the culprit. Inject the same
bundle with a different Frida:

```
python tests\inject_python.py --only none
```

That uses the installed frida-python instead of the frida-core the host links.
It reads `src/` and `src/gen/addr.js` from this checkout and answers every ASK
with “no change”, so a crash there points at the Frida version or the injection
itself rather than at a mod.

## Bisecting down to one instruction

`--skip` and `--only` work per module; `--no-hook` works per site:

```
protocol.exe --mods "<Sacred Gold>\mods" --only gold --no-hook goldEpilogue,goldSyncFull
```

Site names are listed in `dist/agent/hooks.json`. The launcher draws its hook
toggles from the same file and passes the switched-off ones as `--no-hook`.
The agent prints which sites it left alone.

`--no-ask` keeps every hook installed but disables verdicts entirely, which
separates “the hook is there” from “the hook stops the game thread”.

## When a crash leaves no clue

```
protocol.exe --mods "<Sacred Gold>\mods" --only gold --trace
```

`--trace` makes every hook announce itself as it runs. The host prints those as
they arrive, so the last line before the game dies names the hook that was
executing. A crash that kills the process leaves nothing else behind.
