-- Kicker League database schema (Supabase / Postgres).
-- Safe to re-run: tables use IF NOT EXISTS, functions use OR REPLACE, policies are dropped first.
--
-- Security model: users can READ their own leagues' data through row-level security,
-- but every WRITE goes through a SECURITY DEFINER function below that checks the rules
-- (ownership, kickoff locks, roster size, add limit). There are no insert/update policies.

create extension if not exists pg_cron;

-------------------------------------------------------------------------------
-- NFL data (filled nightly by scripts/build_data.py --push)
-------------------------------------------------------------------------------
create table if not exists public.nfl_kickers (
  season   int  not null,
  id       text not null,
  name     text not null,
  team     text not null,
  status   text not null,
  headshot text,
  primary key (season, id)
);

create table if not exists public.nfl_games (
  id      text primary key,
  season  int  not null,
  week    int  not null,
  kickoff timestamptz not null,
  home    text not null,
  away    text not null
);
create index if not exists nfl_games_season_week on public.nfl_games (season, week);

create table if not exists public.kicker_weeks (
  season    int  not null,
  week      int  not null,
  kicker_id text not null,
  team      text,
  fga int not null default 0, fgm int not null default 0, fg50 int not null default 0,
  fg_dist int not null default 0, xpa int not null default 0, xpm int not null default 0,
  clutch int not null default 0, long int not null default 0,
  primary key (season, week, kicker_id)
);

-------------------------------------------------------------------------------
-- People, leagues, teams
-------------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text not null default 'Manager',
  created_at   timestamptz not null default now()
);

create table if not exists public.leagues (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 1 and 60),
  season       int  not null,
  size         int  not null check (size in (6, 8, 10)),
  commissioner uuid not null references auth.users,
  invite_code  text not null unique default upper(substr(md5(random()::text), 1, 6)),
  status       text not null default 'setup' check (status in ('setup', 'drafting', 'active', 'complete')),
  start_week   int  not null default 1 check (start_week between 1 and 18),
  clutch       boolean not null default false,
  add_limit    int  not null default 20 check (add_limit between 0 and 100),
  pick_seconds int  not null default 90 check (pick_seconds between 15 and 600),
  clock_started_at timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists public.teams (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references public.leagues on delete cascade,
  owner      uuid references auth.users on delete set null,  -- null = placeholder run by the commissioner
  name       text not null check (char_length(name) between 1 and 40),
  draft_slot int,
  adds_used  int not null default 0,
  created_at timestamptz not null default now(),
  unique (league_id, draft_slot)
);
create unique index if not exists teams_one_per_owner on public.teams (league_id, owner) where owner is not null;

create table if not exists public.rosters (
  league_id   uuid not null references public.leagues on delete cascade,
  kicker_id   text not null,
  team_id     uuid not null references public.teams on delete cascade,
  how         text not null default 'draft',
  acquired_at timestamptz not null default now(),
  primary key (league_id, kicker_id)          -- a kicker can be on only one team per league
);
create index if not exists rosters_team on public.rosters (team_id);

-- Starters for each week. Bench = roster minus starters.
create table if not exists public.lineups (
  league_id uuid not null references public.leagues on delete cascade,
  team_id   uuid not null references public.teams on delete cascade,
  week      int  not null,
  slot      smallint not null check (slot in (1, 2)),
  kicker_id text not null,
  primary key (team_id, week, slot),
  unique (team_id, week, kicker_id)
);

-- Recently dropped kickers: claim-only until the next waiver run.
create table if not exists public.waivers (
  league_id uuid not null references public.leagues on delete cascade,
  kicker_id text not null,
  clears_at timestamptz not null,
  primary key (league_id, kicker_id)
);

create table if not exists public.waiver_claims (
  id           uuid primary key default gen_random_uuid(),
  league_id    uuid not null references public.leagues on delete cascade,
  team_id      uuid not null references public.teams on delete cascade,
  add_kicker   text not null,
  drop_kicker  text,
  pref         int  not null default 1,       -- the team's own order for its claims
  status       text not null default 'pending' check (status in ('pending', 'won', 'lost', 'invalid', 'cancelled')),
  note         text,
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.draft_picks (
  league_id uuid not null references public.leagues on delete cascade,
  pick_no   int  not null,
  team_id   uuid not null references public.teams on delete cascade,
  kicker_id text not null,
  auto      boolean not null default false,
  made_at   timestamptz not null default now(),
  primary key (league_id, pick_no),
  unique (league_id, kicker_id)
);

create table if not exists public.transactions (
  id         bigint generated always as identity primary key,
  league_id  uuid not null references public.leagues on delete cascade,
  team_id    uuid references public.teams on delete set null,
  kind       text not null,   -- draft, add, drop, waiver, commissioner
  kicker_id  text,
  detail     text,
  created_at timestamptz not null default now()
);
create index if not exists transactions_league on public.transactions (league_id, created_at desc);

-------------------------------------------------------------------------------
-- New users get a profile
-------------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(split_part(new.email, '@', 1), ''), 'Manager'))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-------------------------------------------------------------------------------
-- Helpers
-------------------------------------------------------------------------------
create or replace function public.is_member(p_league uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from leagues where id = p_league and commissioner = auth.uid())
      or exists (select 1 from teams where league_id = p_league and owner = auth.uid());
$$;

create or replace function public.is_commish(p_league uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from leagues where id = p_league and commissioner = auth.uid());
$$;

-- Owner, or the commissioner for a placeholder team.
create or replace function public.can_manage(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from teams t join leagues l on l.id = t.league_id
    where t.id = p_team
      and (t.owner = auth.uid() or (t.owner is null and l.commissioner = auth.uid()))
  );
$$;

-- The first week whose last game kicked off less than 4 hours ago (or hasn't started).
create or replace function public.current_week(p_season int) returns int
language sql stable set search_path = public as $$
  select coalesce(
    (select min(week) from (select week, max(kickoff) as last from nfl_games
                            where season = p_season group by week) w
      where last + interval '4 hours' > now()),
    (select max(week) from nfl_games where season = p_season),
    1);
$$;

-- The week lineups are being set for in a league.
create or replace function public.league_week(p_league uuid) returns int
language sql stable set search_path = public as $$
  select greatest(current_week(season), start_week) from leagues where id = p_league;
$$;

create or replace function public.kicker_kickoff(p_season int, p_kicker text, p_week int) returns timestamptz
language sql stable set search_path = public as $$
  select g.kickoff from nfl_kickers k
  join nfl_games g on g.season = k.season and g.week = p_week and k.team in (g.home, g.away)
  where k.season = p_season and k.id = p_kicker
  limit 1;
$$;

-- Locked once his game for that week has kicked off. Bye week = never locked.
create or replace function public.kicker_locked(p_season int, p_kicker text, p_week int) returns boolean
language sql stable set search_path = public as $$
  select coalesce(kicker_kickoff(p_season, p_kicker, p_week) <= now(), false);
$$;

create or replace function public.kicker_name(p_season int, p_kicker text) returns text
language sql stable set search_path = public as $$
  select coalesce((select name from nfl_kickers where season = p_season and id = p_kicker), p_kicker);
$$;

-- Wednesday 10:00 UTC (3am Pacific in summer time, 2am in winter).
create or replace function public.next_waiver_run() returns timestamptz
language sql stable as $$
  select case when t > now() then t else t + interval '7 days' end
  from (select date_trunc('week', now()) + interval '2 days 10 hours' as t) x;
$$;

-------------------------------------------------------------------------------
-- League creation and joining
-------------------------------------------------------------------------------
create or replace function public.create_league(p_name text, p_size int, p_season int, p_team_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare lg uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into leagues (name, size, season, commissioner) values (trim(p_name), p_size, p_season, auth.uid())
  returning id into lg;
  insert into teams (league_id, owner, name) values (lg, auth.uid(), trim(p_team_name));
  return lg;
end $$;

-- What someone sees before joining with an invite code.
create or replace function public.league_preview(p_code text)
returns table (id uuid, name text, size int, season int, teams int, open_spots int, status text)
language sql stable security definer set search_path = public as $$
  select l.id, l.name, l.size, l.season,
         (select count(*)::int from teams t where t.league_id = l.id),
         l.size - (select count(*)::int from teams t where t.league_id = l.id and t.owner is not null),
         l.status
  from leagues l where l.invite_code = upper(trim(p_code));
$$;

-- Join with an invite code. If the league is full of placeholders, take one over.
create or replace function public.join_league(p_code text, p_team_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare lg leagues; tm uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into lg from leagues where invite_code = upper(trim(p_code)) for update;
  if not found then raise exception 'No league with that invite code'; end if;
  if exists (select 1 from teams where league_id = lg.id and owner = auth.uid()) then
    raise exception 'You are already in this league';
  end if;
  if (select count(*) from teams where league_id = lg.id) < lg.size then
    insert into teams (league_id, owner, name) values (lg.id, auth.uid(), trim(p_team_name)) returning id into tm;
  else
    select id into tm from teams where league_id = lg.id and owner is null order by draft_slot nulls last, created_at limit 1;
    if tm is null then raise exception 'This league is full'; end if;
    update teams set owner = auth.uid(), name = trim(p_team_name) where id = tm;
  end if;
  insert into transactions (league_id, team_id, kind, detail) values (lg.id, tm, 'join', trim(p_team_name) || ' joined');
  return tm;
end $$;

create or replace function public.rename_team(p_team uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_manage(p_team) then raise exception 'Not your team'; end if;
  update teams set name = trim(p_name) where id = p_team;
end $$;

create or replace function public.set_display_name(p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update profiles set display_name = trim(p_name) where id = auth.uid();
end $$;

-------------------------------------------------------------------------------
-- Commissioner tools
-------------------------------------------------------------------------------
create or replace function public.add_placeholder_team(p_league uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare lg leagues; tm uuid;
begin
  select * into lg from leagues where id = p_league for update;
  if not is_commish(p_league) then raise exception 'Commissioner only'; end if;
  if lg.status <> 'setup' then raise exception 'Teams can only be added before the draft'; end if;
  if (select count(*) from teams where league_id = p_league) >= lg.size then raise exception 'League is full'; end if;
  insert into teams (league_id, owner, name) values (p_league, null, trim(p_name)) returning id into tm;
  return tm;
end $$;

create or replace function public.remove_team(p_team uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t teams; lg leagues;
begin
  select * into t from teams where id = p_team;
  select * into lg from leagues where id = t.league_id;
  if not is_commish(t.league_id) then raise exception 'Commissioner only'; end if;
  if t.owner = lg.commissioner then raise exception 'You can''t remove your own team'; end if;
  if lg.status = 'setup' then
    delete from teams where id = p_team;
  else
    -- After the draft the roster stays; the commissioner takes the team over.
    update teams set owner = null where id = p_team;
  end if;
end $$;

create or replace function public.update_league_settings(p_league uuid, p_name text, p_start_week int,
  p_clutch boolean, p_add_limit int, p_pick_seconds int) returns void
language plpgsql security definer set search_path = public as $$
declare lg leagues;
begin
  select * into lg from leagues where id = p_league;
  if not is_commish(p_league) then raise exception 'Commissioner only'; end if;
  if lg.status <> 'setup' and (p_start_week <> lg.start_week or p_clutch <> lg.clutch) then
    raise exception 'Start week and categories are locked once the draft starts';
  end if;
  update leagues set name = trim(p_name), start_week = p_start_week, clutch = p_clutch,
                     add_limit = p_add_limit, pick_seconds = p_pick_seconds
  where id = p_league;
end $$;

-- p_order = team ids in draft order; null = random.
create or replace function public.set_draft_order(p_league uuid, p_order uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare lg leagues;
begin
  select * into lg from leagues where id = p_league;
  if not is_commish(p_league) then raise exception 'Commissioner only'; end if;
  if lg.status <> 'setup' then raise exception 'The draft has already started'; end if;
  update teams set draft_slot = null where league_id = p_league;
  if p_order is null then
    update teams t set draft_slot = r.n
    from (select id, row_number() over (order by random()) as n from teams where league_id = p_league) r
    where t.id = r.id;
  else
    if (select count(*) from teams where league_id = p_league and id <> all(p_order)) > 0 then
      raise exception 'Draft order must include every team';
    end if;
    update teams t set draft_slot = array_position(p_order, t.id) where league_id = p_league;
  end if;
end $$;

-- Remove a kicker from a team or put one on a team, bypassing the usual rules.
create or replace function public.commish_move(p_league uuid, p_kicker text, p_to_team uuid) returns void
language plpgsql security definer set search_path = public as $$
declare lg leagues; wk int;
begin
  select * into lg from leagues where id = p_league;
  if not is_commish(p_league) then raise exception 'Commissioner only'; end if;
  wk := league_week(p_league);
  delete from lineups where league_id = p_league and kicker_id = p_kicker and week >= wk;
  delete from rosters where league_id = p_league and kicker_id = p_kicker;
  delete from waivers where league_id = p_league and kicker_id = p_kicker;
  if p_to_team is not null then
    if (select count(*) from rosters where team_id = p_to_team) >= 3 then raise exception 'That roster is full'; end if;
    insert into rosters (league_id, kicker_id, team_id, how) values (p_league, p_kicker, p_to_team, 'commissioner');
  end if;
  insert into transactions (league_id, team_id, kind, kicker_id, detail)
  values (p_league, p_to_team, 'commissioner', p_kicker,
          kicker_name(lg.season, p_kicker) || case when p_to_team is null then ' removed by commissioner'
                                                   else ' moved by commissioner' end);
end $$;

-- Start a new season: keep the league and managers, clear everything else.
create or replace function public.reset_league(p_league uuid, p_season int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_commish(p_league) then raise exception 'Commissioner only'; end if;
  delete from lineups where league_id = p_league;
  delete from rosters where league_id = p_league;
  delete from waivers where league_id = p_league;
  delete from waiver_claims where league_id = p_league;
  delete from draft_picks where league_id = p_league;
  delete from transactions where league_id = p_league;
  update teams set adds_used = 0, draft_slot = null where league_id = p_league;
  update leagues set season = p_season, status = 'setup', start_week = 1, clock_started_at = null
  where id = p_league;
end $$;

-------------------------------------------------------------------------------
-- Draft (snake, 3 rounds)
-------------------------------------------------------------------------------
create or replace function public.team_on_clock(p_league uuid) returns uuid
language sql stable security definer set search_path = public as $$
  with lg as (select size, status from leagues where id = p_league),
       n  as (select count(*)::int as made from draft_picks where league_id = p_league),
       s  as (select case when (n.made / lg.size) % 2 = 0 then n.made % lg.size + 1
                          else lg.size - n.made % lg.size end as slot,
                     n.made < lg.size * 3 and lg.status = 'drafting' as live
              from lg, n)
  select t.id from teams t, s where t.league_id = p_league and t.draft_slot = s.slot and s.live;
$$;

create or replace function public.start_draft(p_league uuid) returns void
language plpgsql security definer set search_path = public as $$
declare lg leagues;
begin
  select * into lg from leagues where id = p_league for update;
  if not is_commish(p_league) then raise exception 'Commissioner only'; end if;
  if lg.status <> 'setup' then raise exception 'The draft has already started'; end if;
  if (select count(*) from teams where league_id = p_league) <> lg.size then
    raise exception 'Fill all % teams first (add placeholder teams if needed)', lg.size;
  end if;
  if exists (select 1 from teams where league_id = p_league and draft_slot is null) then
    perform set_draft_order(p_league, null);
  end if;
  update leagues set status = 'drafting', clock_started_at = now() where id = p_league;
end $$;

-- Internal: record a pick for whoever is on the clock (permission checks done by callers).
create or replace function public._pick(p_league uuid, p_kicker text, p_auto boolean) returns void
language plpgsql security definer set search_path = public as $$
declare lg leagues; tm uuid; n int; wk int;
begin
  select * into lg from leagues where id = p_league for update;
  if lg.status <> 'drafting' then raise exception 'The draft is not running'; end if;
  tm := team_on_clock(p_league);
  if not exists (select 1 from nfl_kickers where season = lg.season and id = p_kicker and status <> 'non-kicker') then
    raise exception 'Unknown kicker';
  end if;
  if exists (select 1 from rosters where league_id = p_league and kicker_id = p_kicker) then
    raise exception '% is already taken', kicker_name(lg.season, p_kicker);
  end if;
  n := (select count(*) from draft_picks where league_id = p_league) + 1;
  insert into draft_picks (league_id, pick_no, team_id, kicker_id, auto) values (p_league, n, tm, p_kicker, p_auto);
  insert into rosters (league_id, kicker_id, team_id, how) values (p_league, p_kicker, tm, 'draft');
  insert into transactions (league_id, team_id, kind, kicker_id, detail)
  values (p_league, tm, 'draft', p_kicker, 'Pick ' || n || ': ' || kicker_name(lg.season, p_kicker));

  if n >= lg.size * 3 then
    -- Draft done: each team starts its first two picks.
    update leagues set status = 'active', clock_started_at = null where id = p_league;
    wk := league_week(p_league);
    insert into lineups (league_id, team_id, week, slot, kicker_id)
    select p_league, team_id, wk, rn, kicker_id
    from (select team_id, kicker_id, row_number() over (partition by team_id order by pick_no) as rn
          from draft_picks where league_id = p_league) p
    where rn <= 2;
  else
    update leagues set clock_started_at = now() where id = p_league;
  end if;
end $$;

-- The team on the clock (or the commissioner) picks a kicker.
create or replace function public.make_pick(p_league uuid, p_kicker text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (can_manage(team_on_clock(p_league)) or is_commish(p_league)) then
    raise exception 'It''s not your pick';
  end if;
  perform _pick(p_league, p_kicker, false);
end $$;

-- Best available by last season-to-date FG made, then name.
-- Anyone in the league can trigger this once the pick clock runs out; the team on the
-- clock or the commissioner can use it any time.
create or replace function public.auto_pick(p_league uuid) returns void
language plpgsql security definer set search_path = public as $$
declare lg leagues; k text;
begin
  select * into lg from leagues where id = p_league;
  if lg.status <> 'drafting' then raise exception 'The draft is not running'; end if;
  if not (can_manage(team_on_clock(p_league)) or is_commish(p_league)
          or (is_member(p_league) and now() >= lg.clock_started_at + make_interval(secs => lg.pick_seconds))) then
    raise exception 'The pick clock hasn''t run out';
  end if;
  select nk.id into k from nfl_kickers nk
  left join (select kicker_id, sum(fgm) as fgm from kicker_weeks where season = lg.season group by kicker_id) s
    on s.kicker_id = nk.id
  where nk.season = lg.season and nk.status = 'active'
    and not exists (select 1 from rosters r where r.league_id = p_league and r.kicker_id = nk.id)
  order by coalesce(s.fgm, 0) desc, nk.name
  limit 1;
  if k is null then raise exception 'No kickers left'; end if;
  perform _pick(p_league, k, true);
end $$;

-------------------------------------------------------------------------------
-- Lineups
-------------------------------------------------------------------------------
-- Carry last week's starters into the current week for any team that hasn't set one.
create or replace function public.roll_league(p_league uuid) returns void
language plpgsql security definer set search_path = public as $$
declare wk int;
begin
  if (select status from leagues where id = p_league) <> 'active' then return; end if;
  wk := league_week(p_league);
  insert into lineups (league_id, team_id, week, slot, kicker_id)
  select l.league_id, l.team_id, wk, l.slot, l.kicker_id
  from lineups l
  join rosters r on r.league_id = l.league_id and r.team_id = l.team_id and r.kicker_id = l.kicker_id
  where l.league_id = p_league
    and l.week = (select max(x.week) from lineups x where x.team_id = l.team_id and x.week < wk)
    and not exists (select 1 from lineups y where y.team_id = l.team_id and y.week = wk)
  on conflict do nothing;
end $$;

create or replace function public.roll_lineups() returns void
language plpgsql security definer set search_path = public as $$
declare lg uuid;
begin
  for lg in select id from leagues where status = 'active' loop
    perform roll_league(lg);
  end loop;
end $$;

-- Set this week's two starters (null = empty slot). Kickers whose game has started can't move in or out.
create or replace function public.set_lineup(p_team uuid, p_starters text[]) returns void
language plpgsql security definer set search_path = public as $$
declare t teams; lg leagues; wk int; k text; want text[]; have text[];
begin
  select * into t from teams where id = p_team;
  if not found or not can_manage(p_team) then raise exception 'Not your team'; end if;
  select * into lg from leagues where id = t.league_id;
  if lg.status <> 'active' then raise exception 'Lineups open after the draft'; end if;
  perform roll_league(lg.id);
  wk := league_week(lg.id);

  want := array(select distinct x from unnest(p_starters) x where x is not null);
  if cardinality(want) > 2 then raise exception 'Only two starters'; end if;
  have := array(select kicker_id from lineups where team_id = p_team and week = wk);

  for k in select unnest(have) except select unnest(want) loop
    if kicker_locked(lg.season, k, wk) then
      raise exception '%''s game has started, so he stays in your lineup this week', kicker_name(lg.season, k);
    end if;
  end loop;
  for k in select unnest(want) except select unnest(have) loop
    if not exists (select 1 from rosters where team_id = p_team and kicker_id = k) then
      raise exception '% is not on your roster', kicker_name(lg.season, k);
    end if;
    if kicker_locked(lg.season, k, wk) then
      raise exception '%''s game has started, so he can''t be moved into your lineup', kicker_name(lg.season, k);
    end if;
  end loop;

  delete from lineups where team_id = p_team and week = wk and not (kicker_id = any(want));
  for k in select unnest(want) except select unnest(have) loop
    insert into lineups (league_id, team_id, week, slot, kicker_id)
    values (lg.id, p_team, wk,
            (select s from generate_series(1, 2) s
             where s not in (select slot from lineups where team_id = p_team and week = wk)
             order by s limit 1),
            k);
  end loop;
end $$;

-------------------------------------------------------------------------------
-- Free agents and waivers
-------------------------------------------------------------------------------
-- Internal: drop a kicker (checks done by callers).
create or replace function public._drop(lg leagues, p_team uuid, p_kicker text, wk int) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from lineups where team_id = p_team and kicker_id = p_kicker and week >= wk;
  delete from rosters where league_id = lg.id and kicker_id = p_kicker and team_id = p_team;
  insert into waivers (league_id, kicker_id, clears_at) values (lg.id, p_kicker, next_waiver_run())
  on conflict (league_id, kicker_id) do update set clears_at = excluded.clears_at;
  insert into transactions (league_id, team_id, kind, kicker_id, detail)
  values (lg.id, p_team, 'drop', p_kicker, 'Dropped ' || kicker_name(lg.season, p_kicker));
end $$;

-- Instant pickup of a free agent (not on waivers), with an optional drop. Either can be null.
create or replace function public.add_drop(p_team uuid, p_add text, p_drop text) returns void
language plpgsql security definer set search_path = public as $$
declare t teams; lg leagues; wk int;
begin
  select * into t from teams where id = p_team for update;
  if not found or not can_manage(p_team) then raise exception 'Not your team'; end if;
  select * into lg from leagues where id = t.league_id;
  if lg.status <> 'active' then raise exception 'Roster moves open after the draft'; end if;
  wk := league_week(lg.id);
  perform roll_league(lg.id);

  if p_drop is not null then
    if not exists (select 1 from rosters where team_id = p_team and kicker_id = p_drop) then
      raise exception '% is not on your roster', kicker_name(lg.season, p_drop);
    end if;
    if kicker_locked(lg.season, p_drop, wk)
       and exists (select 1 from lineups where team_id = p_team and week = wk and kicker_id = p_drop) then
      raise exception '%''s game has started and he''s in your lineup, so he can''t be dropped this week',
        kicker_name(lg.season, p_drop);
    end if;
  end if;

  if p_add is not null then
    if not exists (select 1 from nfl_kickers where season = lg.season and id = p_add) then
      raise exception 'Unknown kicker';
    end if;
    if exists (select 1 from rosters where league_id = lg.id and kicker_id = p_add) then
      raise exception '% is already on a team', kicker_name(lg.season, p_add);
    end if;
    if exists (select 1 from waivers where league_id = lg.id and kicker_id = p_add and clears_at > now()) then
      raise exception '% is on waivers. Put in a claim instead', kicker_name(lg.season, p_add);
    end if;
    if t.adds_used >= lg.add_limit then raise exception 'You''ve used all % adds this season', lg.add_limit; end if;
    if (select count(*) from rosters where team_id = p_team) - (case when p_drop is null then 0 else 1 end) >= 3 then
      raise exception 'Your roster is full. Pick someone to drop';
    end if;
  end if;

  if p_drop is not null then perform _drop(lg, p_team, p_drop, wk); end if;
  if p_add is not null then
    insert into rosters (league_id, kicker_id, team_id, how) values (lg.id, p_add, p_team, 'free agent');
    update teams set adds_used = adds_used + 1 where id = p_team;
    insert into transactions (league_id, team_id, kind, kicker_id, detail)
    values (lg.id, p_team, 'add', p_add, 'Added ' || kicker_name(lg.season, p_add));
  end if;
end $$;

create or replace function public.submit_claim(p_team uuid, p_add text, p_drop text) returns uuid
language plpgsql security definer set search_path = public as $$
declare t teams; lg leagues; new_id uuid;
begin
  select * into t from teams where teams.id = p_team;
  if not found or not can_manage(p_team) then raise exception 'Not your team'; end if;
  select * into lg from leagues where leagues.id = t.league_id;
  if lg.status <> 'active' then raise exception 'Waivers open after the draft'; end if;
  if exists (select 1 from rosters where league_id = lg.id and kicker_id = p_add) then
    raise exception '% is already on a team', kicker_name(lg.season, p_add);
  end if;
  if p_drop is not null and not exists (select 1 from rosters where team_id = p_team and kicker_id = p_drop) then
    raise exception '% is not on your roster', kicker_name(lg.season, p_drop);
  end if;
  if exists (select 1 from waiver_claims where team_id = p_team and add_kicker = p_add and status = 'pending') then
    raise exception 'You already have a claim on %', kicker_name(lg.season, p_add);
  end if;
  insert into waiver_claims (league_id, team_id, add_kicker, drop_kicker, pref)
  values (lg.id, p_team, p_add, p_drop,
          coalesce((select max(pref) from waiver_claims where team_id = p_team and status = 'pending'), 0) + 1)
  returning waiver_claims.id into new_id;
  return new_id;
end $$;

create or replace function public.cancel_claim(p_claim uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from waiver_claims where id = p_claim and can_manage(team_id) and status = 'pending') then
    raise exception 'Claim not found';
  end if;
  update waiver_claims set status = 'cancelled', processed_at = now() where id = p_claim;
end $$;

-- p_claims = this team's pending claim ids in the order it wants them tried.
create or replace function public.reorder_claims(p_team uuid, p_claims uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_manage(p_team) then raise exception 'Not your team'; end if;
  update waiver_claims set pref = array_position(p_claims, id)
  where team_id = p_team and status = 'pending' and id = any(p_claims);
end $$;

-------------------------------------------------------------------------------
-- Standings (roto)
-------------------------------------------------------------------------------
-- Each category: best team gets N points, worst gets 1, ties split the points.
-- Rate categories need 1.5 attempts per week played or the team ranks last in them.
create or replace function public.league_standings(p_league uuid)
returns table (
  team_id uuid, team_name text, owner uuid,
  fgm int, fg50 int, xpm int, clutch int, fga int, xpa int, fg_dist int,
  fg_pct numeric, xp_pct numeric, avg_dist numeric, weeks int,
  pts_fgm numeric, pts_fg50 numeric, pts_xpm numeric, pts_fg_pct numeric,
  pts_xp_pct numeric, pts_avg_dist numeric, pts_clutch numeric, total numeric)
language sql stable security definer set search_path = public as $$
  with lg as (select * from leagues where id = p_league),
  weeks as (
    select count(distinct kw.week)::int as n from kicker_weeks kw, lg
    where kw.season = lg.season and kw.week >= lg.start_week
  ),
  tot as (
    select t.id as team_id, t.name as team_name, t.owner, t.draft_slot,
      coalesce(sum(kw.fgm), 0)::int as fgm, coalesce(sum(kw.fg50), 0)::int as fg50,
      coalesce(sum(kw.xpm), 0)::int as xpm, coalesce(sum(kw.clutch), 0)::int as clutch,
      coalesce(sum(kw.fga), 0)::int as fga, coalesce(sum(kw.xpa), 0)::int as xpa,
      coalesce(sum(kw.fg_dist), 0)::int as fg_dist
    from teams t
    cross join lg
    left join lineups l on l.team_id = t.id and l.week >= lg.start_week
    left join kicker_weeks kw on kw.season = lg.season and kw.week = l.week and kw.kicker_id = l.kicker_id
    where t.league_id = p_league
    group by t.id, t.name, t.owner, t.draft_slot
  ),
  rates as (
    select tot.*, weeks.n as weeks,
      case when fga > 0 then round(fgm::numeric / fga, 4) end as fg_pct,
      case when xpa > 0 then round(xpm::numeric / xpa, 4) end as xp_pct,
      case when fgm > 0 then round(fg_dist::numeric / fgm, 2) end as avg_dist,
      -- value used for ranking; -1 = below the attempt minimum
      case when fga >= 1.5 * weeks.n and fga > 0 then fgm::numeric / fga else -1 end as r_fg,
      case when xpa >= 1.5 * weeks.n and xpa > 0 then xpm::numeric / xpa else -1 end as r_xp,
      case when fga >= 1.5 * weeks.n and fgm > 0 then fg_dist::numeric / fgm else -1 end as r_dist
    from tot, weeks
  ),
  pts as (
    select r.*,
      rank() over (order by fgm)   + (count(*) over (partition by fgm)   - 1) / 2.0 as p_fgm,
      rank() over (order by fg50)  + (count(*) over (partition by fg50)  - 1) / 2.0 as p_fg50,
      rank() over (order by xpm)   + (count(*) over (partition by xpm)   - 1) / 2.0 as p_xpm,
      rank() over (order by r_fg)  + (count(*) over (partition by r_fg)  - 1) / 2.0 as p_fg,
      rank() over (order by r_xp)  + (count(*) over (partition by r_xp)  - 1) / 2.0 as p_xp,
      rank() over (order by r_dist) + (count(*) over (partition by r_dist) - 1) / 2.0 as p_dist,
      rank() over (order by clutch) + (count(*) over (partition by clutch) - 1) / 2.0 as p_clutch
    from rates r
  )
  select p.team_id, p.team_name, p.owner, p.fgm, p.fg50, p.xpm, p.clutch, p.fga, p.xpa, p.fg_dist,
    p.fg_pct, p.xp_pct, p.avg_dist, p.weeks,
    p.p_fgm, p.p_fg50, p.p_xpm, p.p_fg, p.p_xp, p.p_dist,
    case when lg.clutch then p.p_clutch else 0 end,
    p.p_fgm + p.p_fg50 + p.p_xpm + p.p_fg + p.p_xp + p.p_dist + case when lg.clutch then p.p_clutch else 0 end
  from pts p, lg
  where is_member(p_league) or auth.role() is null   -- no role = server jobs (cron)
  order by 22 desc, p.team_name;
$$;

-- Weekly waiver run: worst team in the standings picks first, one claim per team per round.
create or replace function public.process_waivers(p_league uuid) returns int
language plpgsql security definer set search_path = public as $$
declare lg leagues; wk int; won int := 0; progress boolean; tm record; c record; why text; roster_n int;
begin
  select * into lg from leagues where id = p_league for update;
  if lg.status <> 'active' then return 0; end if;
  wk := league_week(p_league);

  create temp table if not exists _order (team_id uuid, ord int) on commit drop;
  delete from _order;
  insert into _order
  select s.team_id, row_number() over (order by s.total asc, t.draft_slot desc)
  from league_standings(p_league) s join teams t on t.id = s.team_id;

  loop
    progress := false;
    for tm in select o.team_id from _order o order by o.ord loop
      for c in select * from waiver_claims
               where team_id = tm.team_id and status = 'pending' order by pref, created_at loop
        why := null;
        roster_n := (select count(*) from rosters where team_id = tm.team_id);
        if exists (select 1 from rosters where league_id = p_league and kicker_id = c.add_kicker) then
          why := 'lost';
        elsif c.drop_kicker is not null and not exists
              (select 1 from rosters where team_id = tm.team_id and kicker_id = c.drop_kicker) then
          why := 'invalid: the kicker to drop is no longer on your roster';
        elsif roster_n - (case when c.drop_kicker is null then 0 else 1 end) >= 3 then
          why := 'invalid: roster full';
        elsif (select adds_used from teams where id = tm.team_id) >= lg.add_limit then
          why := 'invalid: no adds left';
        end if;

        if why is not null then
          update waiver_claims set status = case when why = 'lost' then 'lost' else 'invalid' end,
                 note = case when why = 'lost' then 'Claimed by a team higher in the waiver order'
                             else substr(why, 10) end,
                 processed_at = now()
          where id = c.id;
          continue;
        end if;

        if c.drop_kicker is not null then perform _drop(lg, tm.team_id, c.drop_kicker, wk); end if;
        insert into rosters (league_id, kicker_id, team_id, how) values (p_league, c.add_kicker, tm.team_id, 'waiver');
        update teams set adds_used = adds_used + 1 where id = tm.team_id;
        update waiver_claims set status = 'won', processed_at = now() where id = c.id;
        insert into transactions (league_id, team_id, kind, kicker_id, detail)
        values (p_league, tm.team_id, 'waiver', c.add_kicker, 'Claimed ' || kicker_name(lg.season, c.add_kicker));
        won := won + 1;
        progress := true;
        exit;  -- one claim per team per round
      end loop;
    end loop;
    exit when not progress;
  end loop;

  delete from waivers where league_id = p_league and clears_at <= now() + interval '1 minute';
  return won;
end $$;

create or replace function public.process_all_waivers() returns void
language plpgsql security definer set search_path = public as $$
declare lg uuid;
begin
  for lg in select id from leagues where status = 'active' loop
    perform process_waivers(lg);
  end loop;
end $$;

-------------------------------------------------------------------------------
-- Row-level security: members read their leagues; nobody writes directly.
-------------------------------------------------------------------------------
alter table public.nfl_kickers   enable row level security;
alter table public.nfl_games     enable row level security;
alter table public.kicker_weeks  enable row level security;
alter table public.profiles      enable row level security;
alter table public.leagues       enable row level security;
alter table public.teams         enable row level security;
alter table public.rosters       enable row level security;
alter table public.lineups       enable row level security;
alter table public.waivers       enable row level security;
alter table public.waiver_claims enable row level security;
alter table public.draft_picks   enable row level security;
alter table public.transactions  enable row level security;

drop policy if exists "public read" on public.nfl_kickers;
create policy "public read" on public.nfl_kickers  for select using (true);
drop policy if exists "public read" on public.nfl_games;
create policy "public read" on public.nfl_games    for select using (true);
drop policy if exists "public read" on public.kicker_weeks;
create policy "public read" on public.kicker_weeks for select using (true);

drop policy if exists "signed-in read" on public.profiles;
create policy "signed-in read" on public.profiles for select to authenticated using (true);

drop policy if exists "members read" on public.leagues;
create policy "members read" on public.leagues for select using (is_member(id));
drop policy if exists "members read" on public.teams;
create policy "members read" on public.teams for select using (is_member(league_id));
drop policy if exists "members read" on public.rosters;
create policy "members read" on public.rosters for select using (is_member(league_id));
drop policy if exists "members read" on public.lineups;
create policy "members read" on public.lineups for select using (is_member(league_id));
drop policy if exists "members read" on public.waivers;
create policy "members read" on public.waivers for select using (is_member(league_id));
drop policy if exists "members read" on public.draft_picks;
create policy "members read" on public.draft_picks for select using (is_member(league_id));
drop policy if exists "members read" on public.transactions;
create policy "members read" on public.transactions for select using (is_member(league_id));
drop policy if exists "own claims" on public.waiver_claims;
create policy "own claims" on public.waiver_claims for select using (can_manage(team_id) or is_commish(league_id));

-- Server-only functions: not callable from the app.
revoke execute on function public.roll_lineups()          from public, anon, authenticated;
revoke execute on function public.process_all_waivers()   from public, anon, authenticated;
revoke execute on function public.process_waivers(uuid)   from public, anon, authenticated;
revoke execute on function public._drop(public.leagues, uuid, text, int) from public, anon, authenticated;
revoke execute on function public._pick(uuid, text, boolean) from public, anon, authenticated;
revoke execute on function public.handle_new_user()       from public, anon, authenticated;

-------------------------------------------------------------------------------
-- Scheduled jobs
-------------------------------------------------------------------------------
select cron.schedule('roll-lineups',    '5 * * * *',  $$select public.roll_lineups()$$);
select cron.schedule('process-waivers', '0 10 * * 3', $$select public.process_all_waivers()$$);
