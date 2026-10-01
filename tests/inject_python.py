"""Injects the same agent with frida-python instead of the Rust host.

Isolates one question a game restart can otherwise not answer: is a crash caused
by the agent's hooks, or by the frida version the host links?  The host embeds
frida-core 17.9.5 (whatever the devkit shipped), while frida-python here is
whatever is installed, the same one the original research hooks ran under.

    python tests\inject_python.py [--only health] [--skip gold]

Answers every ASK with "no change", so the game behaves as if no mod were
loaded.  Anything the agent sends is printed.
"""
import pathlib
import sys
import time

import frida

ROOT = pathlib.Path(__file__).resolve().parent.parent
AGENT = ROOT / "src"

# The executable names live in tools/, beside everything else that has to know
# where the game is. This import is the only reason that folder is on the path.
sys.path.insert(0, str(ROOT / "tools"))
import game  # noqa: E402

ALWAYS = ("core", "bus", "names")


def running_game():
    """The pid of the first of game.NAMES that is running, or None.

    By name rather than through frida.attach("..."): the match has to ignore
    case, because a folder that spells it sacred.exe is the same install.
    """
    alive = frida.enumerate_processes()
    for wanted in game.NAMES:
        for process in alive:
            if process.name.lower() == wanted.lower():
                return process.pid
    return None


def module_name(path):
    return path.stem.lstrip("0123456789-")


def bundle(only, skip):
    parts = [(AGENT / "gen" / "addr.js").read_text(encoding="utf-8")]
    for path in sorted(AGENT.glob("*.js")):
        name = module_name(path)
        wanted = name in ALWAYS or (name in only if only else name not in skip)
        if not wanted:
            print(f"  skipping {name}")
            continue
        parts.append(f"\n// ---- {path.name} ----\n"
                     + path.read_text(encoding="utf-8"))
    return "".join(parts)


def main():
    args = sys.argv[1:]
    only = set()
    skip = set()
    for i, arg in enumerate(args):
        if arg == "--only" and i + 1 < len(args):
            only = set(args[i + 1].split(","))
        if arg == "--skip" and i + 1 < len(args):
            skip = set(args[i + 1].split(","))

    source = bundle(only, skip)
    print(f"agent: {len(source)} bytes, frida {frida.__version__}")

    print(f"waiting for the game ({game.names()}) ...")
    while True:
        pid = running_game()
        if pid is None:
            time.sleep(1)
            continue
        break
    session = frida.attach(pid)

    script = session.create_script(source)

    def on_message(message, _data):
        if message.get("type") == "error":
            print("[error]", message.get("description"))
            return
        payload = message.get("payload") or {}
        kind = payload.get("type")
        print(f"[{kind}] {payload.get('result')} {payload.get('returns')}")
        if kind == "ask":
            script.post({"type": "verdict", "seq": payload.get("id"),
                         "cancel": False, "set": {}})

    script.on("message", on_message)
    script.load()
    print("loaded. Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
