#!/usr/bin/env python3
"""Live kicker stats during games, from ESPN's public game feed.

While any game is in progress (or about to start), polls each live game's ESPN summary about
once a minute and writes that game's kicker totals into kicker_weeks with source = 'live'.
The nightly official (nflverse) update replaces live rows game by game, so corrections win.

  python3 scripts/live.py                run until no games are live (used by GitHub Actions)
  python3 scripts/live.py --check 2026 6 compare ESPN-derived stats with official data for a week
"""
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={id}"
POLL_SECONDS = 60
MAX_RUNTIME = timedelta(hours=5, minutes=40)   # GitHub Actions jobs stop at 6 hours
LEAD = timedelta(minutes=25)                    # start watching this long before kickoff
GAME_LENGTH = timedelta(hours=4, minutes=30)    # stop watching a game that never reported final


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "kicker-league-live"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def clock_seconds(display):
    try:
        m, s = display.split(":")
        return int(m) * 60 + int(s)
    except (ValueError, AttributeError):
        return 9999


def parse_summary(d, game, espn_to_id):
    """Turn one ESPN summary into {kicker_id: weekly totals} plus the game's live status."""
    comp = d["header"]["competitions"][0]
    side = {c["team"]["id"]: c["homeAway"] for c in comp["competitors"]}       # espn team id -> home/away
    ours = {"home": game["home"], "away": game["away"]}                        # home/away -> our team code
    status = comp["status"]["type"]
    scores = {c["homeAway"]: c.get("score") for c in comp["competitors"]}

    # Kickers in the box score, per team, with XP made/attempted.
    kickers = {}   # espn team id -> list of (espn athlete id, display name, xpm, xpa)
    for team in d.get("boxscore", {}).get("players", []):
        for st in team.get("statistics", []):
            if st.get("name") != "kicking":
                continue
            labels = st.get("labels", [])
            for a in st.get("athletes", []):
                vals = dict(zip(labels, a.get("stats", [])))
                xpm, _, xpa = (vals.get("XP", "0/0")).partition("/")
                kickers.setdefault(team["team"]["id"], []).append(
                    (a["athlete"]["id"], a["athlete"].get("displayName", ""), int(xpm or 0), int(xpa or 0)))

    out = {}

    def totals(espn_athlete, team_id):
        kid = espn_to_id.get(espn_athlete)
        if not kid:
            return None
        return out.setdefault(kid, {"fga": 0, "fgm": 0, "fg50": 0, "fgDist": 0, "xpa": 0, "xpm": 0,
                                    "clutch": 0, "long": 0, "team": ours[side[team_id]]})

    for team_id, ks in kickers.items():
        for espn_athlete, _, xpm, xpa in ks:
            t = totals(espn_athlete, team_id)
            if t:
                t["xpm"] += xpm
                t["xpa"] += xpa

    # Field goals from the play-by-play (distance, result, clock, score).
    seen = set()
    plays = []
    drives = d.get("drives", {})
    for drv in drives.get("previous", []) + ([drives["current"]] if drives.get("current") else []):
        for p in drv.get("plays", []):
            if p.get("id") not in seen:
                seen.add(p.get("id"))
                plays.append(p)
    for p in plays:
        kind = (p.get("type") or {}).get("text", "")
        text = p.get("text") or ""
        if "field goal" not in kind.lower() or "no play" in text.lower():
            continue
        team_id = ((p.get("start") or {}).get("team") or {}).get("id")
        candidates = kickers.get(team_id, [])
        if not candidates:
            continue
        kicker = candidates[0]
        if len(candidates) > 1:
            # Two kickers for one team: match the name right before the distance ("B.Grupe 44 yard"),
            # not the holder or snapper named later in the description.
            m = re.search(r"([A-Za-z.'\- ]+?)\s+\d+\s*(?:yard|yd)", text, re.I)
            who = (m.group(1).split(".")[-1].strip().lower() if m else "")
            for c in candidates:
                if who and c[1].split()[-1].lower() == who:
                    kicker = c
        t = totals(kicker[0], team_id)
        if not t:
            continue
        dist = p.get("statYardage")
        if not dist:
            m = re.search(r"(\d+)\s*(?:yard|yd)", text, re.I)
            dist = int(m.group(1)) if m else 0
        made = "good" in kind.lower()
        t["fga"] += 1
        if made:
            t["fgm"] += 1
            t["fgDist"] += dist
            t["long"] = max(t["long"], dist)
            if dist >= 50:
                t["fg50"] += 1
            period = (p.get("period") or {}).get("number", 0)
            late = period >= 5 or (period == 4 and clock_seconds((p.get("clock") or {}).get("displayValue")) <= 120)
            mine, theirs = ("homeScore", "awayScore") if side[team_id] == "home" else ("awayScore", "homeScore")
            diff = (p.get(mine, 0) - 3) - p.get(theirs, 0)    # margin before the kick
            if late and -3 <= diff <= 0:
                t["clutch"] += 1

    info = {
        "state": status.get("state"),                 # pre / in / post
        "detail": status.get("shortDetail") or status.get("detail"),
        "home_score": int(scores["home"]) if scores.get("home") not in (None, "") else None,
        "away_score": int(scores["away"]) if scores.get("away") not in (None, "") else None,
    }
    return out, info


# ---------------------------------------------------------------------------- database
def load_context(conn, season):
    games = [dict(zip(["id", "week", "kickoff", "home", "away", "espn_id"], r)) for r in conn.execute(
        "select id, week, kickoff, home, away, espn_id from nfl_games where season = %s and espn_id is not null",
        (season,)).fetchall()]
    espn_to_id = dict(conn.execute(
        "select espn_id, id from nfl_kickers where season = %s and espn_id is not null", (season,)).fetchall())
    return games, espn_to_id


def write_game(conn, season, game, stats, info):
    with conn.transaction():
        # Replace this game's live rows (never touch official ones).
        conn.execute("delete from kicker_weeks where season = %s and game_id = %s and source = 'live'", (season, game["id"]))
        for kid, s in stats.items():
            conn.execute(
                """insert into kicker_weeks (season, week, kicker_id, team, fga, fgm, fg50, fg_dist, xpa, xpm, clutch, long,
                                             source, game_id)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'live',%s)
                   on conflict (season, week, kicker_id) do nothing""",
                (season, game["week"], kid, s["team"], s["fga"], s["fgm"], s["fg50"], s["fgDist"],
                 s["xpa"], s["xpm"], s["clutch"], s["long"], game["id"]))
        conn.execute(
            """insert into live_games (game_id, season, week, state, detail, home_score, away_score, updated_at)
               values (%s,%s,%s,%s,%s,%s,%s, now())
               on conflict (game_id) do update set state = excluded.state, detail = excluded.detail,
                 home_score = excluded.home_score, away_score = excluded.away_score, updated_at = now()""",
            (game["id"], season, game["week"], info["state"], info["detail"], info["home_score"], info["away_score"]))


def current_season(now):
    return now.year if now.month >= 3 else now.year - 1


def run():
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
    from db import connect

    started = datetime.now(timezone.utc)
    season = current_season(started)
    finished = set()
    with connect() as conn:
        conn.autocommit = True
        games, espn_to_id = load_context(conn, season)
        finished |= {r[0] for r in conn.execute(
            "select game_id from live_games where season = %s and state = 'post'", (season,)).fetchall()}
        while datetime.now(timezone.utc) - started < MAX_RUNTIME:
            now = datetime.now(timezone.utc)
            watch = [g for g in games if g["id"] not in finished
                     and g["kickoff"] - LEAD <= now <= g["kickoff"] + GAME_LENGTH]
            if not watch:
                print(f"{now:%H:%M} no games live or starting soon; done")
                return
            for g in watch:
                if now < g["kickoff"]:
                    continue
                try:
                    stats, info = parse_summary(fetch_json(SUMMARY_URL.format(id=g["espn_id"])), g, espn_to_id)
                except Exception as e:  # noqa: BLE001 - one bad response shouldn't stop the loop
                    print(f"  {g['id']}: fetch failed ({e})")
                    continue
                if info["state"] == "pre":
                    continue
                write_game(conn, season, g, stats, info)
                kicks = ", ".join(f"{s['fgm']}/{s['fga']} FG {s['xpm']}/{s['xpa']} XP" for s in stats.values())
                print(f"{now:%H:%M} {g['id']} {info['detail']}: {kicks or 'no kicks yet'}")
                if info["state"] == "post":
                    finished.add(g["id"])
            time.sleep(POLL_SECONDS)
        print("Reached the time limit; the next scheduled run will pick up.")


# ---------------------------------------------------------------------------- self-check
def check(season, week):
    """Compare ESPN-derived per-game stats with the official kicks file for one week."""
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    sched = json.loads((root / f"data/{season}/schedule.json").read_text())["games"]
    kicks = json.loads((root / f"data/{season}/kicks.json").read_text())["kicks"]
    import csv, io
    espn_game = {}
    roster_espn = {}
    games_csv = urllib.request.urlopen("https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv").read().decode()
    for r in csv.DictReader(io.StringIO(games_csv)):
        espn_game[r["game_id"]] = r["espn"]
    roster = urllib.request.urlopen(f"https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_{season}.csv").read().decode()
    for r in csv.DictReader(io.StringIO(roster)):
        if r["espn_id"] and r["gsis_id"]:
            roster_espn[r["espn_id"]] = r["gsis_id"]

    official = {}
    for k in kicks:
        if k["w"] != week:
            continue
        t = official.setdefault((k["g"], k["k"]), {"fga": 0, "fgm": 0, "fg50": 0, "fgDist": 0, "xpa": 0, "xpm": 0, "clutch": 0, "long": 0})
        if k["type"] == "FG":
            t["fga"] += 1
            if k["made"]:
                t["fgm"] += 1; t["fgDist"] += k["dist"]; t["long"] = max(t["long"], k["dist"])
                t["fg50"] += k["dist"] >= 50; t["clutch"] += k["clutch"]
        else:
            t["xpa"] += 1; t["xpm"] += k["made"]

    mism = 0
    total = 0
    for g in [g for g in sched if g["week"] == week]:
        d = fetch_json(SUMMARY_URL.format(id=espn_game[g["id"]]))
        stats, info = parse_summary(d, g, roster_espn)
        for kid, s in stats.items():
            total += 1
            o = official.get((g["id"], kid))
            mine = {k: v for k, v in s.items() if k != "team"}
            if o != mine:
                mism += 1
                print(f"  MISMATCH {g['id']} {kid}\n    espn     {mine}\n    official {o}")
        for (gid, kid), o in official.items():
            if gid == g["id"] and kid not in stats and (o["fga"] or o["xpa"]):
                mism += 1
                print(f"  MISSING from ESPN {gid} {kid} {o}")
    print(f"Week {week}: {total} kicker-games compared, {mism} mismatches")
    return mism


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--check":
        sys.exit(1 if check(int(sys.argv[2]), int(sys.argv[3])) else 0)
    run()
