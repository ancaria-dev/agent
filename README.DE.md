<div align="center">

[![JavaScript](https://img.shields.io/badge/JavaScript-QuickJS-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://frida.re)
[![Sacred](https://img.shields.io/badge/Sacred-Community-8B1A1A?style=for-the-badge&labelColor=1C1410)](https://ancaria.dev)
[![License](https://img.shields.io/badge/License-MIT-4B5563?style=for-the-badge)](LICENSE)

[Русский](README.md) · [English](README.EN.md)

</div>

# agent

Das JavaScript, das ancaria in Sacred Gold einschleust, für alle, die dem
Loader Hooks oder Events hinzufügen.

Frida führt den Agent im Prozess des Spiels aus. Er hängt sich in die
Funktionen des Spiels, meldet das Geschehen als Events, fragt Mods, ob eine
Aktion erlaubt ist, und führt ihre Befehle aus. Der Rust-Host aus
[protocol](https://github.com/ancaria-dev/protocol) trägt diese Nachrichten
zwischen dem Spiel und der JVM der Mods hin und her.

Jede Adresse kommt aus [mappings](https://github.com/ancaria-dev/mappings) und
gilt für `pureHD.exe` 2.0.2.118. Ein Release backt die Adressen ein und liefert
den Agent verkleinert als `agent.zip` aus. Der Launcher lädt ihn herunter, zum
Spielen installierst du also nichts von Hand.

## Erste Schritte

So läuft dein eigener Agent im Spiel:

1. Klone [mappings](https://github.com/ancaria-dev/mappings) neben dieses
   Repository oder lass `tools/addr.py` es herunterladen.
2. Leg `.local.settings` mit dem Spielordner an:
   `sacred=D:\SteamLibrary\steamapps\common\Sacred Gold`.
3. Starte `pwsh tools/install.ps1`. Das Skript erzeugt die Adressen, packt den
   Agent und ersetzt `<game>/launcher/agent/`.
4. Starte das Spiel aus dem Launcher. Läuft es schon, schließ es vorher: Ein
   laufendes Spiel behält seinen alten Agent.

Bevor ein neuer Hook rausgeht, prüf ihn mit `python tools/hooksafe.py` an
deinem Spiel. [docs/RUNNING.md](docs/RUNNING.md) zeigt, wie du einen Absturz
auf ein Modul oder eine Stelle eingrenzt.

## Was drin ist

| Pfad | Was es ist |
|---|---|
| `src/NN-name.js` | Die Module. Sie teilen einen Gültigkeitsbereich und laden in der Reihenfolge ihrer Dateinamen. |
| `src/gen/addr.js` | Die Adresstabelle. `tools/addr.py` erzeugt sie, sie wird nie committet. |
| `signatures.json` | Die Befehlsbytes an jeder Hook-Stelle, geschrieben von `tools/hooksafe.py --signatures`. |
| `tools/compact.mjs` | Der Minifier: Er entfernt Kommentare und Einrückung und ändert sonst nichts. |
| `tools/pack.mjs` | Baut `dist/agent/` und `dist/agent.zip`. |
| `tests/` | Der Build-Check, die Tests des Minifiers und eine Injektion über frida-python. |

## agent.zip

Das Archiv ist flach und schon verkleinert:

```
addr.js       die Adresstabelle
NN-name.js    jedes Modul
hooks.json    die Hook-Stellen je Modul, der Launcher zeigt sie als Schalter
agent.json    {"version":"<Version>","protocol":1}
```

Der Host lehnt einen Agent ab, dessen `protocol` nicht zu seiner eigenen Nummer
passt. So lädt ein alter Host keinen Agent, der andere Nachrichten spricht.

## Bauen

Du brauchst Python 3.11 und Node 24. `tools/hooksafe.py` braucht außerdem
`pefile` und `capstone`. Mehr installierst du nicht.

```
python tools/addr.py              schreibt src/gen/addr.js
python tools/hooksafe.py          lehnt Stellen ab, die ein Trampolin beschädigt
node tests/buildcheck.js          prüft die Build-Warnung an einem falschen Spiel
node --test "tests/*.test.mjs"    testet den Minifier und das Lesen der Hooks
node tools/pack.mjs               schreibt dist/agent.zip
```

`addr.py` sucht `mappings.json` in dieser Reihenfolge: ein Pfad als Argument,
`$AGENT_MAPPINGS`, das benachbarte `../mappings`, dann GitHub in der Revision
aus `.mappings-ref`.

## Releases

Ein Release ist der Button `Release` in Actions: Du gibst eine Version ein und
auf Wunsch die mappings-Version, die eingebacken wird. Leer heißt: das neueste
mappings-Release. Der Workflow prüft die Registry, führt die Tests aus und
hängt `agent.zip` an ein GitHub-Release.

[devops](https://github.com/ancaria-dev/devops) startet dieses Release nach
jedem mappings-Release und aktualisiert danach das Manifest des Launchers.
Details stehen in der
[CONTRIBUTING](https://github.com/ancaria-dev/.github/blob/master/CONTRIBUTING.DE.md)
im Wurzel-Repository.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
