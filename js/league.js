// Loads everything a league page needs in one go, plus lookups built on top of it.
import { sb, rpc, rows } from './supa.js';
import { emptyTotals, addWeek, withRates } from './data.js';

export async function loadLeague(id, user) {
  const leagues = await rows(sb.from('leagues').select('*').eq('id', id));
  const league = leagues[0];
  if (!league) throw new Error("League not found, or you're not in it.");

  const [teams, roster, week, kickers, games, weeks, waivers] = await Promise.all([
    rows(sb.from('teams').select('*').eq('league_id', id).order('draft_slot', { nullsFirst: false }).order('created_at')),
    rows(sb.from('rosters').select('*').eq('league_id', id)),
    rpc('league_week', { p_league: id }),
    rows(sb.from('nfl_kickers').select('*').eq('season', league.season)),
    rows(sb.from('nfl_games').select('*').eq('season', league.season)),
    rows(sb.from('kicker_weeks').select('*').eq('season', league.season)),
    rows(sb.from('waivers').select('*').eq('league_id', id)),
  ]);
  const [lineups, live, badges] = await Promise.all([
    rows(sb.from('lineups').select('*').eq('league_id', id).eq('week', week)),
    rows(sb.from('live_games').select('*').eq('season', league.season).eq('week', week)),
    rows(sb.from('league_badges').select('*').eq('league_id', id).order('week')),
  ]);
  const ownerIds = teams.map((t) => t.owner).filter(Boolean);
  const profiles = ownerIds.length ? await rows(sb.from('profiles').select('*').in('id', ownerIds)) : [];

  return new League({ league, teams, roster, week, kickers, games, weeks, waivers, lineups, profiles, live, badges, user });
}

export class League {
  constructor(d) {
    Object.assign(this, d);
    this.id = d.league.id;
    this.isCommish = d.league.commissioner === d.user.id;
    this.myTeam = d.teams.find((t) => t.owner === d.user.id) || null;
    this.kickerById = new Map(d.kickers.map((k) => [k.id, k]));
    this.teamById = new Map(d.teams.map((t) => [t.id, t]));
    this.ownerName = new Map(d.profiles.map((p) => [p.id, p.display_name]));
    this.rosterTeam = new Map(d.roster.map((r) => [r.kicker_id, r.team_id]));
    this.liveByGame = new Map(d.live.map((g) => [g.game_id, g]));
    this.thisWeek = new Map(d.weeks.filter((w) => w.week === d.week).map((w) => [w.kicker_id, w]));
    this.waiverUntil = new Map(d.waivers.filter((w) => new Date(w.clears_at) > new Date()).map((w) => [w.kicker_id, w.clears_at]));

    // Season-to-date totals per kicker.
    this.totals = new Map();
    for (const w of d.weeks) {
      if (!this.totals.has(w.kicker_id)) this.totals.set(w.kicker_id, emptyTotals());
      addWeek(this.totals.get(w.kicker_id), { ...w, fgDist: w.fg_dist });
    }
    for (const [k, t] of this.totals) this.totals.set(k, withRates(t));
  }

  // Teams the signed-in user can act for: their own, plus placeholders if commissioner.
  get manageable() {
    return this.teams.filter((t) => t.owner === this.user.id || (this.isCommish && !t.owner));
  }

  teamLabel(team) {
    if (!team) return '';
    return team.owner ? (this.ownerName.get(team.owner) || 'Manager') : 'Placeholder';
  }

  kicker(id) {
    return this.kickerById.get(id) || { id, name: id, team: '?', status: 'unknown' };
  }

  stats(id) {
    return this.totals.get(id) || withRates(emptyTotals());
  }

  badgesOf(teamId) {
    return this.badges.filter((b) => b.team_id === teamId);
  }

  rosterOf(teamId) {
    return this.roster.filter((r) => r.team_id === teamId).map((r) => r.kicker_id);
  }

  startersOf(teamId) {
    return this.lineups.filter((l) => l.team_id === teamId).sort((a, b) => a.slot - b.slot).map((l) => l.kicker_id);
  }

  game(kickerId, week = this.week) {
    const team = this.kicker(kickerId).team;
    return this.games.find((g) => g.week === week && (g.home === team || g.away === team)) || null;
  }

  locked(kickerId) {
    const g = this.game(kickerId);
    return !!g && new Date(g.kickoff) <= new Date();
  }

  // "vs DAL · Sun 1:25 PM", "@ KC · Locked", or "BYE". While a game is on, includes the score and clock.
  matchup(kickerId) {
    const k = this.kicker(kickerId);
    const g = this.game(kickerId);
    if (!g) return { text: 'BYE', locked: false };
    const opp = g.home === k.team ? `vs ${g.away}` : `@ ${g.home}`;
    const lg = this.liveByGame.get(g.id);
    const score = lg && lg.home_score != null
      ? (g.home === k.team ? `${lg.home_score}–${lg.away_score}` : `${lg.away_score}–${lg.home_score}`) : '';
    return {
      text: opp, kickoff: g.kickoff, locked: new Date(g.kickoff) <= new Date(),
      live: lg?.state === 'in', final: lg?.state === 'post', score, detail: lg?.detail || '',
    };
  }

  // This week's kicking so far ("FG 2/3 · Long 55 · XP 1/1"), or '' if he hasn't kicked.
  weekLine(kickerId) {
    const w = this.thisWeek.get(kickerId);
    if (!w || !(w.fga || w.xpa)) return '';
    return `FG ${w.fgm}/${w.fga}${w.fgm ? ` · Long ${w.long}` : ''} · XP ${w.xpm}/${w.xpa}`;
  }

  // Any game this week in progress (or kicked off and not yet reported final).
  get isLive() {
    const now = Date.now();
    return this.games.some((g) => {
      if (g.week !== this.week) return false;
      const lg = this.liveByGame.get(g.id);
      if (lg) return lg.state === 'in';
      const k = new Date(g.kickoff).getTime();
      return k <= now && now <= k + 4.5 * 3600e3;
    });
  }

  availability(kickerId) {
    const team = this.rosterTeam.get(kickerId);
    if (team) return { kind: 'rostered', team: this.teamById.get(team) };
    const until = this.waiverUntil.get(kickerId);
    if (until) return { kind: 'waivers', until };
    return { kind: 'free' };
  }
}
