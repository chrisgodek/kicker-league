// Loading the nightly data files and turning raw kicking stats into roto categories.

export const CATEGORIES = [
  { key: 'fgm',    label: 'FG',      title: 'Field goals made',          type: 'count' },
  { key: 'fg50',   label: '50+',     title: '50+ yard field goals made', type: 'count' },
  { key: 'xpm',    label: 'XP',      title: 'Extra points made',         type: 'count' },
  { key: 'fgPct',  label: 'FG%',     title: 'Field goal percentage',     type: 'rate' },
  { key: 'xpPct',  label: 'XP%',     title: 'Extra point percentage',    type: 'rate' },
  { key: 'avgDist', label: 'Avg Dist', title: 'Average made FG distance', type: 'rate' },
];
export const CLUTCH = { key: 'clutch', label: 'Clutch', title: 'Go-ahead or tying FGs, final 2:00 or OT', type: 'count' };

export function categoriesFor(settings = {}) {
  return settings.clutch ? [...CATEGORIES, CLUTCH] : CATEGORIES;
}

const cache = {};
export async function loadSeason(season) {
  if (!cache[season]) {
    const get = (name) => fetch(`data/${season}/${name}.json`).then((r) => {
      if (!r.ok) throw new Error(`No ${name} data for ${season}`);
      return r.json();
    });
    cache[season] = Promise.all([get('kickers'), get('schedule'), get('stats')])
      .then(([kickers, schedule, stats]) => ({ kickers, schedule, stats }));
  }
  return cache[season];
}

export function emptyTotals() {
  return { fga: 0, fgm: 0, fg50: 0, fgDist: 0, xpa: 0, xpm: 0, clutch: 0, long: 0, weeks: 0 };
}

// Add one week of raw stats into a running total.
export function addWeek(total, week) {
  if (!week) return total;
  for (const f of ['fga', 'fgm', 'fg50', 'fgDist', 'xpa', 'xpm', 'clutch']) total[f] += week[f];
  total.long = Math.max(total.long, week.long);
  total.weeks += 1;
  return total;
}

// Rates are pooled (total made / total attempts), never averages of percentages.
export function withRates(t) {
  return {
    ...t,
    fgPct: t.fga ? t.fgm / t.fga : null,
    xpPct: t.xpa ? t.xpm / t.xpa : null,
    avgDist: t.fgm ? t.fgDist / t.fgm : null,
  };
}

export function kickerTotals(statsByWeek, from, to) {
  const t = emptyTotals();
  for (let w = from; w <= to; w++) addWeek(t, statsByWeek?.[w]);
  return withRates(t);
}

export function formatStat(key, value) {
  if (value == null) return '–';
  if (key === 'fgPct' || key === 'xpPct') return (value * 100).toFixed(1);
  if (key === 'avgDist') return value.toFixed(1);
  return String(value);
}

// The game a team plays in a given week (null = bye).
export function gameFor(schedule, team, week) {
  return schedule.games.find((g) => g.week === week && (g.home === team || g.away === team)) || null;
}

// First week whose last game hasn't kicked off yet.
export function currentWeek(schedule, now = new Date()) {
  const lastKick = {};
  for (const g of schedule.games) lastKick[g.week] = g.kickoff > (lastKick[g.week] || '') ? g.kickoff : lastKick[g.week];
  const weeks = Object.keys(lastKick).map(Number).sort((a, b) => a - b);
  return weeks.find((w) => new Date(lastKick[w]) > now) ?? weeks[weeks.length - 1];
}

export function isLocked(game, now = new Date()) {
  return !!game && new Date(game.kickoff) <= now;
}
