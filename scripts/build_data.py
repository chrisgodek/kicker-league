#!/usr/bin/env python3
"""Build the kicker data files the app reads.

Pulls nflverse play-by-play, schedule, and roster data for a season and writes:
  data/<season>/kickers.json   every kicker (name, NFL team, status, headshot)
  data/<season>/schedule.json  every regular-season game with kickoff in UTC
  data/<season>/stats.json     per-kicker, per-week raw kicking totals
  data/<season>/kicks.json     every FG / XP attempt (for detail views + auditing)
  data/<season>/highlights.json  rare kicker moments for league badges: recovered onside kicks,
                                 and fake-FG passes/runs by a kicker that got a first down or TD

Standard library only so it runs anywhere (locally or in GitHub Actions).
Usage: python3 scripts/build_data.py [--push] 2026 [2025 ...]
  --push  also load the season into the Supabase database (needs DATABASE_URL)
"""
import csv
import gzip
import io
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = "https://github.com/nflverse/nflverse-data/releases/download"
PBP_URL = BASE + "/pbp/play_by_play_{season}.csv.gz"
SCHEDULE_URL = BASE + "/schedules/games.csv"
ROSTER_URL = BASE + "/rosters/roster_{season}.csv"

EASTERN = ZoneInfo("America/New_York")
ROOT = Path(__file__).resolve().parent.parent

# Roster statuses -> what the app shows. Anything not listed is treated as a free agent.
STATUS = {"ACT": "active", "RES": "injured", "DEV": "practice", "INA": "inactive"}


def fetch(url):
    print("  fetching", url)
    req = urllib.request.Request(url, headers={"User-Agent": "kicker-league-data"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
    if url.endswith(".gz"):
        data = gzip.decompress(data)
    return csv.DictReader(io.StringIO(data.decode("utf-8")))


def num(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def is_clutch(row):
    """Made FG in the last 2 minutes of the 4th quarter or in OT that ties or takes the lead."""
    qtr = num(row["qtr"])
    secs = num(row["game_seconds_remaining"], 9999)
    diff = num(row["score_differential"], -99)  # kicking team's margin before the kick
    late = qtr >= 5 or (qtr == 4 and secs <= 120)
    return late and -3 <= diff <= 0


def build_schedule(season):
    games = []
    for row in fetch(SCHEDULE_URL):
        if num(row["season"]) != season or row["game_type"] != "REG":
            continue
        local = datetime.strptime(row["gameday"] + " " + row["gametime"], "%Y-%m-%d %H:%M")
        kickoff = local.replace(tzinfo=EASTERN).astimezone(timezone.utc)
        games.append({
            "id": row["game_id"],
            "week": num(row["week"]),
            "kickoff": kickoff.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "away": row["away_team"],
            "home": row["home_team"],
            "awayScore": num(row["away_score"], None),
            "homeScore": num(row["home_score"], None),
            "espnId": row["espn"] or None,
        })
    games.sort(key=lambda g: (g["kickoff"], g["id"]))
    return games


def highlight_candidate(row):
    """Onside kicks the kicking team recovered, and successful passes/runs (possibly by a kicker)."""
    desc = row["desc"]
    if "no play" in desc.lower():
        return None
    base = {"id": f'{row["game_id"]}_{row["play_id"]}', "week": num(row["week"]), "game": row["game_id"],
            "team": row["posteam"], "desc": desc}
    if row["kickoff_attempt"] == "1" and "onside" in desc.lower() and row["own_kickoff_recovery"] == "1":
        # On kickoffs the "possession" team is the receiving team; the kicking team is the defense.
        return {**base, "kicker": row["kicker_player_id"], "kind": "onside", "team": row["defteam"],
                "detail": "Onside kick recovered by his team"}
    good = row["first_down"] == "1" or row["touchdown"] == "1" or row["two_point_conv_result"] == "success"
    if row["play_type"] in ("pass", "run") and good:
        yards = num(row["yards_gained"])
        what = "TD" if row["touchdown"] == "1" else "2-point conversion" if row["two_point_conv_result"] == "success" else "first down"
        if row["play_type"] == "pass" and row["passer_player_id"]:
            return {**base, "kicker": row["passer_player_id"], "kind": "fake_pass",
                    "detail": f"Threw a {yards}-yard pass for a {what} on a fake"}
        if row["play_type"] == "run" and row["rusher_player_id"]:
            return {**base, "kicker": row["rusher_player_id"], "kind": "fake_run",
                    "detail": f"Ran {yards} yards for a {what} on a fake"}
    return None


def build_kicks(season):
    kicks = []
    names = {}
    candidates = []
    for row in fetch(PBP_URL.format(season=season)):
        if row["season_type"] != "REG":
            continue
        c = highlight_candidate(row)
        if c:
            candidates.append(c)
        fg = row["field_goal_attempt"] == "1"
        xp = row["extra_point_attempt"] == "1"
        if not (fg or xp) or not row["kicker_player_id"]:
            continue
        kid = row["kicker_player_id"]
        names.setdefault(kid, (row["kicker_player_name"], row["posteam"]))
        if fg:
            made = row["field_goal_result"] == "made"
            result = row["field_goal_result"]
        else:
            made = row["extra_point_result"] == "good"
            result = row["extra_point_result"]
        kicks.append({
            "k": kid,
            "w": num(row["week"]),
            "g": row["game_id"],
            "t": row["posteam"],
            "type": "FG" if fg else "XP",
            "dist": num(row["kick_distance"], None),
            "result": result,  # made / missed / blocked  or  good / failed / blocked
            "made": made,
            "clutch": fg and made and is_clutch(row),
        })
    return kicks, names, candidates


def build_stats(kicks):
    """Raw totals per kicker per week. The app turns these into roto categories."""
    stats = {}
    for k in kicks:
        week = stats.setdefault(k["k"], {}).setdefault(str(k["w"]), {
            "fga": 0, "fgm": 0, "fg50": 0, "fgDist": 0,
            "xpa": 0, "xpm": 0, "clutch": 0, "long": 0, "team": k["t"], "game": k["g"],
        })
        if k["type"] == "FG":
            week["fga"] += 1
            if k["made"]:
                week["fgm"] += 1
                week["fgDist"] += k["dist"] or 0
                week["long"] = max(week["long"], k["dist"] or 0)
                if (k["dist"] or 0) >= 50:
                    week["fg50"] += 1
                if k["clutch"]:
                    week["clutch"] += 1
        else:
            week["xpa"] += 1
            if k["made"]:
                week["xpm"] += 1
    return stats


def build_kickers(season, kick_names):
    kickers = {}
    for row in fetch(ROSTER_URL.format(season=season)):
        if row["position"] != "K" or not row["gsis_id"]:
            continue
        prev = kickers.get(row["gsis_id"])
        if prev and num(prev["_week"]) > num(row["week"]):
            continue
        kickers[row["gsis_id"]] = {
            "id": row["gsis_id"],
            "name": row["full_name"],
            "team": row["team"],
            "status": STATUS.get(row["status"], "free agent"),
            "headshot": row["headshot_url"] or None,
            "sleeperId": row["sleeper_id"] or None,
            "espnId": row["espn_id"] or None,
            "_week": row["week"],
        }
    # Anyone who kicked but isn't listed as a K (e.g. a punter filling in) still gets stats.
    for kid, (short, team) in kick_names.items():
        if kid not in kickers:
            kickers[kid] = {"id": kid, "name": short, "team": team, "status": "non-kicker",
                            "headshot": None, "sleeperId": None, "espnId": None, "_week": "0"}
    out = []
    for k in kickers.values():
        k.pop("_week")
        out.append(k)
    out.sort(key=lambda k: (k["team"], k["name"]))
    return out


def write(path, obj):
    """Write JSON, but leave the file untouched if only the "updated" stamp would change."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        try:
            old = json.loads(path.read_text())
            if {**old, "updated": None} == {**obj, "updated": None}:
                print("  unchanged", path.relative_to(ROOT))
                return
        except ValueError:
            pass
    path.write_text(json.dumps(obj, separators=(",", ":")) + "\n")
    print("  wrote", path.relative_to(ROOT), f"({path.stat().st_size // 1024} KB)")


def build(season):
    print(f"Season {season}")
    schedule = build_schedule(season)
    kicks, names, candidates = build_kicks(season)
    kickers = build_kickers(season, names)
    # Only players listed as kickers count (not a running back who once filled in).
    real_kickers = {k["id"] for k in kickers if k["status"] != "non-kicker"}
    highlights = [c for c in candidates if c["kicker"] in real_kickers]
    stats = build_stats(kicks)
    weeks_done = max((k["w"] for k in kicks), default=0)
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = ROOT / "data" / str(season)
    write(out / "kickers.json", {"season": season, "updated": updated, "kickers": kickers})
    write(out / "schedule.json", {"season": season, "updated": updated, "games": schedule})
    write(out / "stats.json", {"season": season, "updated": updated,
                               "weeksWithData": weeks_done, "stats": stats})
    write(out / "kicks.json", {"season": season, "updated": updated, "kicks": kicks})
    write(out / "highlights.json", {"season": season, "updated": updated, "highlights": highlights})
    return kickers, schedule, stats, highlights


def push(season, kickers, schedule, stats, highlights):
    """Load this season's NFL data into the database in one transaction.

    Official stats replace any live stats for the same games; live rows for games the official data
    doesn't cover yet (it can lag a day) are left alone.
    """
    from db import connect
    rows = [(season, int(w), kid, s["team"], s["fga"], s["fgm"], s["fg50"], s["fgDist"],
             s["xpa"], s["xpm"], s["clutch"], s["long"], s["game"])
            for kid, weeks in stats.items() for w, s in weeks.items()]
    official_games = sorted({r[-1] for r in rows})
    with connect() as conn, conn.cursor() as cur:
        cur.execute("delete from nfl_kickers where season = %s", (season,))
        cur.executemany(
            "insert into nfl_kickers (season, id, name, team, status, headshot, espn_id) values (%s,%s,%s,%s,%s,%s,%s)",
            [(season, k["id"], k["name"], k["team"], k["status"], k["headshot"], k["espnId"]) for k in kickers])
        cur.execute("delete from nfl_games where season = %s", (season,))
        cur.executemany(
            "insert into nfl_games (id, season, week, kickoff, home, away, espn_id) values (%s,%s,%s,%s,%s,%s,%s)",
            [(g["id"], season, g["week"], g["kickoff"], g["home"], g["away"], g["espnId"]) for g in schedule])
        cur.execute("delete from kicker_weeks where season = %s and (source = 'official' or game_id = any(%s))",
                    (season, official_games))
        cur.executemany(
            "insert into kicker_weeks (season, week, kicker_id, team, fga, fgm, fg50, fg_dist, xpa, xpm, clutch, long,"
            " source, game_id) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'official',%s)"
            " on conflict (season, week, kicker_id) do update set team = excluded.team, fga = excluded.fga,"
            " fgm = excluded.fgm, fg50 = excluded.fg50, fg_dist = excluded.fg_dist, xpa = excluded.xpa,"
            " xpm = excluded.xpm, clutch = excluded.clutch, long = excluded.long, source = 'official',"
            " game_id = excluded.game_id",
            rows)
        cur.execute("delete from nfl_highlights where season = %s", (season,))
        cur.executemany(
            "insert into nfl_highlights (id, season, week, game_id, kicker_id, team, kind, detail, description)"
            " values (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            [(h["id"], season, h["week"], h["game"], h["kicker"], h["team"], h["kind"], h["detail"], h["desc"])
             for h in highlights])
        cur.execute("select award_badges()")
        awarded = cur.fetchone()[0]
    print(f"  {len(highlights)} highlights, {awarded} new league badges")
    print(f"  pushed {season}: {len(kickers)} kickers, {len(schedule)} games to the database")


if __name__ == "__main__":
    now = datetime.now()
    current = now.year if now.month >= 3 else now.year - 1  # Jan/Feb belong to last season
    args = sys.argv[1:]
    do_push = "--push" in args
    seasons = [int(a) for a in args if a != "--push"] or [current]
    for s in seasons:
        kickers, schedule, games_stats, highlights = build(s)
        if do_push:
            push(s, kickers, schedule, games_stats, highlights)
