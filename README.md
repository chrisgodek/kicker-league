# Kicker League

Fantasy football for kickers only. Roto scoring, 6/8/10-team leagues, 2 starters + 1 bench,
lineups lock at each kicker's kickoff, waiver order by reverse standings.

## Data

`scripts/build_data.py` pulls free [nflverse](https://github.com/nflverse/nflverse-data) data
(play-by-play, schedule, rosters) and writes small JSON files to `data/<season>/`:

| File | Contents |
|---|---|
| `kickers.json` | Every kicker: name, NFL team, roster status, headshot |
| `schedule.json` | Regular-season games with kickoff time in UTC (used for lineup locks) |
| `stats.json` | Per-kicker, per-week totals: FGA, FGM, 50+, made-FG distance, XPA, XPM, clutch, long |
| `kicks.json` | Every FG/XP attempt, for auditing and detail views |

A GitHub Action (`.github/workflows/data.yml`) runs it daily at 3am PT, September through February,
and commits only when the data actually changed. Run it by hand from the Actions tab, or locally:

    python3 scripts/build_data.py 2026

Totals were checked against nflverse's official 2025 player stats: every kicker matches.

## Roto categories

FG made · 50+ FG made · XP made · FG% · XP% · Avg made-FG distance · (optional) Clutch FGs.
Rates are pooled (total made / total attempts). Clutch = made FG in the last 2:00 of the 4th or in
OT that ties or takes the lead.
