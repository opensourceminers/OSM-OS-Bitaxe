#!/usr/bin/env python3
"""OSM-Auslieferungseinstellungen anwenden oder pruefen.

Hintergrund: Unsere Abweichungen vom Upstream (Pool, Worker, Hostname, Takte)
lagen frueher als Diff-Schnipsel im Git-Verlauf. Beim Nachziehen einer neuen
Upstream-Version konnten sie dadurch verloren gehen oder nur teilweise
ankommen - genau das hat zu veralteten und uneinheitlichen Images gefuehrt.

Jetzt stehen die Werte in osm-settings.json, und dieses Skript schreibt sie in
die Firmware-Dateien:

  python3 tools/osm_settings.py --apply    # nach jedem Upstream-Rebase
  python3 tools/osm_settings.py --check    # laeuft in der CI vor jedem Release

Beruehrt werden ausschliesslich die unten gelisteten Schluessel. Alles andere
(ASIC-Modell, Board-Version, Pins, Upstream-Takte) bleibt unangetastet.
"""

import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SETTINGS = ROOT / "osm-settings.json"


def load():
    return json.loads(SETTINGS.read_text(encoding="utf-8"))


def board_of(path):
    """config-601.cvs -> '601', config.cvs.example -> None"""
    m = re.fullmatch(r"config-(.+)\.cvs", path.name)
    return m.group(1) if m else None


def wanted_keys(cfg, board):
    """NVS-Schluessel, die wir in den Werks-Seeds setzen."""
    g = cfg["general"]
    out = {
        "hostname": g["hostname"],
        "stratumurl": g["pool"]["url"],
        "stratumport": g["pool"]["port"],
        "stratumuser": g["pool"]["user"],
        "stratumpass": g["pool"]["password"],
        "fbstratumurl": g["backup_pool"]["url"],
        "fbstratumport": g["backup_pool"]["port"],
        "fbstratumuser": g["backup_pool"]["user"],
        "fbstratumpass": g["backup_pool"]["password"],
        "autofanspeed": 1 if g["auto_fan"] else 0,
    }
    dev = cfg["devices"].get(board, {})
    if "frequency" in dev:
        out["asicfrequency"] = dev["frequency"]
    if "core_voltage" in dev:
        out["asicvoltage"] = dev["core_voltage"]
    if "temp_target" in dev:
        out["temptarget"] = dev["temp_target"]
    return out


# Typ/Encoding fuer Schluessel, die wir ggf. neu anlegen muessen
NEW_KEY_SPEC = {"temptarget": ("data", "u16")}


def patch_cvs(path, keys, apply_changes):
    """Setzt die Schluessel in einer config-*.cvs. Gibt die Abweichungen zurueck."""
    lines = path.read_text(encoding="utf-8").splitlines()
    drift, seen = [], set()

    for i, line in enumerate(lines):
        parts = line.split(",")
        if len(parts) < 4:
            continue
        key = parts[0]
        if key not in keys:
            continue
        seen.add(key)
        want = str(keys[key])
        if parts[3] != want:
            drift.append(f"{key}: {parts[3]!r} -> {want!r}")
            parts[3] = want
            lines[i] = ",".join(parts)

    for key, value in keys.items():
        if key in seen:
            continue
        typ, enc = NEW_KEY_SPEC.get(key, ("data", "string"))
        drift.append(f"{key}: fehlt -> {value!r}")
        lines.append(f"{key},{typ},{enc},{value}")

    if drift and apply_changes:
        path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return drift


def patch_kconfig(path, cfg, apply_changes):
    """Haelt die Kconfig-Defaults mit den Werks-Seeds im Gleichklang.

    Sie greifen bei selbst gebauten Images ohne NVS-Seed - laufen sie
    auseinander, hat ein Geraet je nach Flash-Weg andere Einstellungen.
    """
    g = cfg["general"]
    targets = {
        "STRATUM_URL": f'"{g["pool"]["url"]}"',
        "STRATUM_PORT": str(g["pool"]["port"]),
        "STRATUM_USER": f'"{g["pool"]["user"]}"',
        "FALLBACK_STRATUM_URL": f'"{g["backup_pool"]["url"]}"',
        "FALLBACK_STRATUM_PORT": str(g["backup_pool"]["port"]),
        "FALLBACK_STRATUM_USER": f'"{g["backup_pool"]["user"]}"',
    }
    text = path.read_text(encoding="utf-8")
    drift = []

    for name, want in targets.items():
        # "config NAME" ... bis zur naechsten "default"-Zeile
        pattern = re.compile(
            r"(config %s\b(?:(?!\n\s*config\s).)*?\n\s*default\s+)(\S+)" % re.escape(name),
            re.S,
        )
        m = pattern.search(text)
        if not m:
            drift.append(f"{name}: Eintrag nicht gefunden")
            continue
        if m.group(2) != want:
            drift.append(f"{name}: {m.group(2)} -> {want}")
            text = text[: m.start(2)] + want + text[m.end(2) :]

    if drift and apply_changes:
        path.write_text(text, encoding="utf-8", newline="\n")
    return drift


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--apply", action="store_true", help="Werte in die Firmware-Dateien schreiben")
    mode.add_argument("--check", action="store_true", help="nur pruefen, Abweichung = Exit-Code 1")
    args = ap.parse_args()

    cfg = load()
    total = 0

    for path in sorted(ROOT.glob("config-*.cvs")):
        board = board_of(path)
        drift = patch_cvs(path, wanted_keys(cfg, board), args.apply)
        if drift:
            total += len(drift)
            print(f"{path.name}:")
            for d in drift:
                print(f"    {d}")

    kconfig = ROOT / "main" / "Kconfig.projbuild"
    drift = patch_kconfig(kconfig, cfg, args.apply)
    if drift:
        total += len(drift)
        print(f"{kconfig.relative_to(ROOT).as_posix()}:")
        for d in drift:
            print(f"    {d}")

    if not total:
        print("OSM-Einstellungen: alles wie in osm-settings.json.")
        return 0
    if args.apply:
        print(f"\n{total} Werte angepasst.")
        return 0
    print(f"\n{total} Abweichung(en) von osm-settings.json - 'tools/osm_settings.py --apply' ausfuehren.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
