"""Which file on disk is the game.

Every address in this project belongs to `pureHD.exe`, the community HD
wrapper, but that is not the only thing a Sacred Gold folder can hold: the
stock game is `Sacred.exe`, and some copies were renamed. So the name is looked
up rather than assumed, most likely first.

Windows does not distinguish `Sacred.exe` from `SACRED.EXE`, so neither does
this. An install that differs only in case is the same install, and matching
literally would reject a folder that works perfectly well.

This is the only list of those names on the Python side.
"""
import pathlib

NAMES = ("pureHD.exe", "Sacred.exe", "Game.exe")


def find(folder):
    """The game executable inside `folder`, or None when it holds none."""
    folder = pathlib.Path(folder)
    if not folder.is_dir():
        return None
    present = {path.name.lower(): path for path in folder.iterdir()
               if path.is_file()}
    for name in NAMES:
        found = present.get(name.lower())
        if found is not None:
            return found
    return None


def names():
    """For an error message: the names that were tried, in order."""
    return ", ".join(NAMES)
