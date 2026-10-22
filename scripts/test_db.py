#!/usr/bin/env python3
"""End-to-end test of the league rules against the real database.

Everything runs in one transaction that is rolled back at the end, so nothing is left behind.
Usage: python3 scripts/test_db.py
"""
import json
import uuid

from db import connect

passed = failed = 0


def check(label, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  ✓ {label}")
    else:
        failed += 1
        print(f"  ✗ {label} {detail}")


class DB:
    def __init__(self, conn):
        self.conn = conn
        self.cur = conn.cursor()

    def as_user(self, uid):
        self.cur.execute("reset role")
        if uid is None:
            self.cur.execute("select set_config('request.jwt.claims', '', true)")
            return
        claims = json.dumps({"sub": str(uid), "role": "authenticated"})
        self.cur.execute("select set_config('request.jwt.claims', %s, true)", (claims,))
        self.cur.execute("set local role authenticated")

    def q(self, sql, *args):
        self.cur.execute(sql, args)
        return self.cur.fetchall() if self.cur.description else None

    def one(self, sql, *args):
        rows = self.q(sql, *args)
        return rows[0][0] if rows else None

    def fails(self, sql, *args):
        """Run sql expecting an error; return the error message (or None if it succeeded)."""
        self.cur.execute("savepoint t")
        try:
            self.cur.execute(sql, args)
        except Exception as e:  # noqa: BLE001
            self.cur.execute("rollback to savepoint t")
            return str(e).splitlines()[0]
        self.cur.execute("release savepoint t")
        return None


def main():
    conn = connect()
    db = DB(conn)
    try:
        run(db)
    finally:
        conn.rollback()
        conn.close()
    print(f"\n{passed} passed, {failed} failed (all test data rolled back)")


def run(db):
    season = 2026
    users = {name: uuid.uuid4() for name in ["chris", "bob", "outsider"]}
    db.as_user(None)
    for name, uid in users.items():
        db.q("insert into auth.users (id, email, aud, role) values (%s, %s, 'authenticated', 'authenticated')",
             uid, f"{name}-{uid.hex[:6]}@test.invalid")
    check("profiles created on sign-up", db.one("select count(*) from profiles where id = any(%s)",
                                                 list(users.values())) == 3)

    print("League setup")
    db.as_user(users["chris"])
    lg = db.one("select create_league('Test League', 6, %s, 'Chris Kicks')", season)
    code = db.one("select invite_code from leagues where id = %s", lg)
    check("commissioner can read own league", db.one("select count(*) from leagues where id = %s", lg) == 1)

    db.as_user(users["outsider"])
    check("outsider can't see the league", db.one("select count(*) from leagues where id = %s", lg) == 0)
    check("outsider sees invite preview", db.one("select name from league_preview(%s)", code.lower()) == "Test League")

    custom = "KT" + uuid.uuid4().hex[:6].upper()
    db.as_user(users["chris"])
    check("commissioner sets a custom code", db.one("select set_invite_code(%s, %s)", lg, custom.lower() + " ") == custom)
    check("bad code rejected", "4 to 12" in (db.fails("select set_invite_code(%s, 'no!')", lg) or ""))
    check("old code stops working", db.q("select * from league_preview(%s)", code) == [])
    code = custom
    db.as_user(users["bob"])
    check("non-commissioner can't change the code", db.fails("select set_invite_code(%s, null)", lg) is not None)
    bob_team = db.one("select join_league(%s, 'Bob Boots')", code)
    check("bob joins with invite code", bob_team is not None)
    check("bob can't join twice", "already" in (db.fails("select join_league(%s, 'Again')", code) or ""))
    check("bob can't add placeholder teams", db.fails("select add_placeholder_team(%s, 'X')", lg) is not None)
    check("bob can't write rosters directly",
          db.fails("insert into rosters (league_id, kicker_id, team_id) values (%s, 'x', %s)", lg, bob_team) is not None)
    check("draft can't start with open spots (and not by bob)", db.fails("select start_draft(%s)", lg) is not None)

    db.as_user(users["chris"])
    check("draft can't start until league is full", "Fill all" in (db.fails("select start_draft(%s)", lg) or ""))
    for i in range(4):
        db.q("select add_placeholder_team(%s, %s)", lg, f"Bot {i + 1}")
    check("league full at 6", db.one("select count(*) from teams where league_id = %s", lg) == 6)
    check("7th team rejected", db.fails("select add_placeholder_team(%s, 'Bot 5')", lg) is not None)

    print("Draft")
    db.q("select start_draft(%s)", lg)
    check("draft running", db.one("select status from leagues where id = %s", lg) == "drafting")
    slots = dict(db.q("select id, draft_slot from teams where league_id = %s", lg))
    check("random draft order assigned", sorted(slots.values()) == [1, 2, 3, 4, 5, 6])

    order = []
    for pick in range(18):
        db.as_user(None)
        on_clock = db.one("select team_on_clock(%s)", lg)
        order.append(slots[on_clock])
        owner = db.one("select owner from teams where id = %s", on_clock)
        if owner == users["bob"]:
            db.as_user(users["bob"])
        else:
            if pick == 0:
                db.as_user(users["bob"])
                check("bob can't pick out of turn", "not your pick" in (db.fails(
                    "select make_pick(%s, (select id from nfl_kickers where season = %s and status = 'active' limit 1))",
                    lg, season) or ""))
                check("bob can't auto-pick before the clock runs out",
                      db.fails("select auto_pick(%s)", lg) is not None)
            db.as_user(users["chris"])
        db.q("select auto_pick(%s)", lg)
    check("snake order 1-6, 6-1, 1-6", order == [1, 2, 3, 4, 5, 6, 6, 5, 4, 3, 2, 1, 1, 2, 3, 4, 5, 6], str(order))
    check("league active after 18 picks", db.one("select status from leagues where id = %s", lg) == "active")
    check("every team has 3 kickers", db.q(
        "select count(*) from rosters where league_id = %s group by team_id", lg) == [(3,)] * 6)
    wk = db.one("select league_week(%s)", lg)
    check(f"first two picks start in week {wk}",
          db.one("select count(*) from lineups where league_id = %s and week = %s", lg, wk) == 12)

    print("Lineups and kickoff locks")
    db.as_user(users["bob"])
    # Use kickers who actually play this week (not on bye) so the lock test means something.
    plays = lambda k: db.one("select kicker_kickoff(%s, %s, %s)", season, k, wk) is not None  # noqa: E731
    roster = [r[0] for r in db.q("select kicker_id from rosters where team_id = %s", bob_team)]
    playing = [k for k in roster if plays(k)]
    check("bob has at least 2 kickers playing this week", len(playing) >= 2, str(len(playing)))
    bench, other = playing[0], playing[1]
    rest = [k for k in roster if k not in (bench, other)][0]
    db.q("select set_lineup(%s, %s)", bob_team, [rest, other])
    db.q("select set_lineup(%s, %s)", bob_team, [bench, other])
    now_starters = {r[0] for r in db.q("select kicker_id from lineups where team_id = %s and week = %s", bob_team, wk)}
    check("bob swaps bench kicker in", now_starters == {bench, other})
    starters = [rest, other]
    other_team = db.one("select id from teams where league_id = %s and id <> %s limit 1", lg, bob_team)
    check("bob can't set another team's lineup", db.fails("select set_lineup(%s, %s)", other_team, []) is not None)
    stranger = db.one("select r.kicker_id from rosters r where r.team_id = %s limit 1", other_team)
    check("can't start someone else's kicker", db.fails("select set_lineup(%s, %s)", bob_team, [bench, stranger]) is not None)

    # Pretend bench's game kicked off an hour ago.
    db.as_user(None)
    team_of = db.one("select team from nfl_kickers where season = %s and id = %s", season, bench)
    db.q("update nfl_games set kickoff = now() - interval '1 hour' where season = %s and week = %s and %s in (home, away)",
         season, wk, team_of)
    db.as_user(users["bob"])
    msg = db.fails("select set_lineup(%s, %s)", bob_team, [starters[0], starters[1]])
    check("locked starter can't be benched", msg is not None and "started" in msg, msg)
    check("locked starter stays when the other slot changes",
          db.fails("select set_lineup(%s, %s)", bob_team, [bench, starters[0]]) is None)
    check("locked kicker can't be moved in from the bench", db.fails(
        "select set_lineup(%s, %s)", users["bob"] and bob_team, [starters[0], starters[1]]) is not None)
    check("locked starter can't be dropped", db.fails("select add_drop(%s, null, %s)", bob_team, bench) is not None)

    print("Free agents and waivers")
    fa = db.q("select id from nfl_kickers k where season = %s and status = 'active' and not exists "
              "(select 1 from rosters r where r.league_id = %s and r.kicker_id = k.id) order by name", season, lg)
    fa = [r[0] for r in fa]
    check("free agents left (32ish active - 18)", len(fa) >= 10, str(len(fa)))
    check("roster full: add without drop rejected", "full" in (db.fails("select add_drop(%s, %s, null)", bob_team, fa[0]) or ""))
    bob_bench = db.one("select kicker_id from rosters where team_id = %s and kicker_id not in "
                       "(select kicker_id from lineups where team_id = %s and week = %s)", bob_team, bob_team, wk)
    db.q("select add_drop(%s, %s, %s)", bob_team, fa[0], bob_bench)
    check("bob adds a free agent and drops his bench kicker",
          db.one("select team_id from rosters where league_id = %s and kicker_id = %s", lg, fa[0]) == bob_team)
    check("add counted", db.one("select adds_used from teams where id = %s", bob_team) == 1)
    check("dropped kicker goes on waivers", db.one("select count(*) from waivers where league_id = %s and kicker_id = %s",
                                                   lg, bob_bench) == 1)

    db.as_user(users["chris"])
    bot = db.one("select id from teams where league_id = %s and owner is null order by draft_slot limit 1", lg)
    bot2 = db.one("select id from teams where league_id = %s and owner is null order by draft_slot desc limit 1", lg)
    bot_bench = lambda t: db.one("select kicker_id from rosters where team_id = %s and kicker_id not in "  # noqa: E731
                                 "(select kicker_id from lineups where team_id = %s and week = %s) limit 1", t, t, wk)
    check("waiver kicker can't be added instantly",
          "waivers" in (db.fails("select add_drop(%s, %s, %s)", bot, bob_bench, bot_bench(bot)) or ""))
    db.q("select submit_claim(%s, %s, %s)", bot, bob_bench, bot_bench(bot))
    db.q("select submit_claim(%s, %s, %s)", bot2, bob_bench, bot_bench(bot2))
    second_drop = db.one("select kicker_id from rosters where team_id = %s and kicker_id <> %s limit 1",
                         bot2, bot_bench(bot2))
    db.q("select submit_claim(%s, %s, %s)", bot2, fa[1], second_drop)
    db.as_user(users["bob"])
    check("bob can't see other teams' claims", db.one("select count(*) from waiver_claims where league_id = %s", lg) == 0)
    check("bob can't run waivers", db.fails("select process_waivers(%s)", lg) is not None)

    db.as_user(None)
    won = db.one("select process_waivers(%s)", lg)
    # No standings yet, so reverse draft order: bot2 (highest slot) claims first.
    check("waivers: reverse draft order before standings", db.one(
        "select team_id from rosters where league_id = %s and kicker_id = %s", lg, bob_bench) == bot2)
    statuses = dict(db.q("select team_id::text || add_kicker, status from waiver_claims where league_id = %s", lg))
    check("other claim on same kicker lost", statuses.get(f"{bot}{bob_bench}") == "lost", str(statuses))
    check("bot2's second claim processed in round 2", statuses.get(f"{bot2}{fa[1]}") == "won", str(statuses))
    check("2 claims won", won == 2, str(won))

    print("Standings")
    # Fill weeks 1..(wk-1) with each team's first two roster kickers so there's real data to rank.
    db.q("""insert into lineups (league_id, team_id, week, slot, kicker_id)
            select %s, team_id, w, rn, kicker_id from
              (select team_id, kicker_id, row_number() over (partition by team_id order by kicker_id) rn
               from rosters where league_id = %s) r, generate_series(1, %s - 1) w
            where rn <= 2 on conflict do nothing""", lg, lg, wk)
    db.as_user(users["bob"])
    rows = db.q("select team_name, fgm, fga, fg_pct, pts_fgm, pts_fg_pct, total from league_standings(%s)", lg)
    total = sum(r[6] for r in rows)
    check("six categories × (1+…+6) = 126 points handed out", total == 126, str(total))
    check("standings sorted by total", [r[6] for r in rows] == sorted((r[6] for r in rows), reverse=True))
    for r in rows:
        print(f"      {r[0]:12} FG {r[1]:>3}/{r[2]:<3} pts FG {r[4]:>4} FG% {r[5]:>4}  total {r[6]}")
    db.as_user(users["outsider"])
    check("outsider gets no standings", db.q("select * from league_standings(%s)", lg) == [])

    print("Weekly roll + reset")
    db.as_user(None)
    db.q("delete from lineups where league_id = %s and week = %s", lg, wk)
    db.q("select roll_league(%s)", lg)
    check("lineups carried forward from last week", db.one(
        "select count(*) from lineups where league_id = %s and week = %s", lg, wk) > 0)
    db.as_user(users["chris"])
    db.q("select reset_league(%s, 2027)", lg)
    check("reset clears rosters and keeps teams",
          db.one("select count(*) from rosters where league_id = %s", lg) == 0
          and db.one("select count(*) from teams where league_id = %s", lg) == 6
          and db.one("select season from leagues where id = %s", lg) == 2027)


if __name__ == "__main__":
    main()
