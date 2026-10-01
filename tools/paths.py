"""Where the address registry comes from.

The registry is its own repository, and this one has to build without it: a
lone `git clone` of the agent is a normal thing to do. So the file is looked
for in the places a person would actually have it, and downloaded when they
have it nowhere.

Order, most specific first:

    1. a path on the command line
    2. $AGENT_MAPPINGS
    3. ../mappings, the sibling checkout, first because somebody editing the
       registry expects their edit to be the one that gets used
    4. the copy on GitHub, at the ref in .mappings-ref, cached under build/

Nothing here needs credentials: the mappings repository is public.
"""
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
REF_FILE = ROOT / ".mappings-ref"
CACHE = ROOT / "build" / "mappings" / "mappings.json"
RAW = "https://raw.githubusercontent.com/ancaria-dev/mappings/{ref}/mappings.json"


def ref():
    """Which revision of the registry this build is pinned to.

    A branch name works and is the default. A tag or a commit is what you want
    the moment a build has to be reproducible.
    """
    if REF_FILE.is_file():
        text = REF_FILE.read_text(encoding="utf-8").strip()
        if text:
            return text
    return "master"


def _local(candidate):
    path = pathlib.Path(candidate)
    if path.is_dir():
        path = path / "mappings.json"
    return path if path.is_file() else None


def download():
    url = RAW.format(ref=ref())
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            body = response.read()
    except urllib.error.URLError as failure:
        raise SystemExit(
            f"cannot reach {url}: {failure}\n"
            "Pass a path to mappings.json, set AGENT_MAPPINGS, or clone\n"
            "https://github.com/ancaria-dev/mappings.git beside this repository.")
    # Parsed before it is cached: a proxy login page is also a 200.
    json.loads(body.decode("utf-8"))
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_bytes(body)
    print(f"mappings.json {ref()} -> {CACHE.relative_to(ROOT)}")
    return CACHE


def mappings(argv=()):
    for candidate in list(argv):
        found = _local(candidate)
        if found:
            return found
        raise SystemExit(f"no mappings.json at {candidate}")

    env = os.environ.get("AGENT_MAPPINGS")
    if env:
        found = _local(env)
        if found:
            return found
        raise SystemExit(f"AGENT_MAPPINGS points at {env}, which has none")

    for candidate in (ROOT.parent / "mappings", CACHE):
        found = _local(candidate)
        if found:
            return found
    return download()


def registry(argv=()):
    return json.loads(mappings(argv).read_text(encoding="utf-8"))


if __name__ == "__main__":
    print(mappings(sys.argv[1:]))
