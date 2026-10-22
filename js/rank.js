// Kicker Score: one number that sums how far a kicker is above or below average in every roto category.
//
// For each category we take a per-game value (so missed games don't count against anyone):
//   FG, 50+, XP, Clutch    made per game
//   FG%, XP%               makes above what an average kicker would make on the same attempts, per game
//                          (volume-weighted, so 30/30 beats 5/5)
//   Avg Dist               yards above average across all made FGs, per game
// Each is turned into a z-score (how many standard deviations from the typical kicker) and the z-scores
// are added up. Small samples are pulled toward average: score × games / (games + 3).
// 0 = average kicker, about +5 = elite, negative = below average.
import { categoriesFor, emptyTotals, withRates } from './data.js';

const SHRINK_GAMES = 3;

export function rankKickers(totals, { clutch = false } = {}) {
  const list = [...totals].filter(([, t]) => t.weeks > 0).map(([id, t]) => ({ id, t }));
  const out = new Map();
  if (!list.length) return out;

  const sum = (f) => list.reduce((a, x) => a + x.t[f], 0);
  const lgFg = sum('fga') ? sum('fgm') / sum('fga') : 0;
  const lgXp = sum('xpa') ? sum('xpm') / sum('xpa') : 0;
  const lgDist = sum('fgm') ? sum('fgDist') / sum('fgm') : 0;

  for (const x of list) {
    const { t } = x;
    const g = t.weeks;
    x.p = {
      fgm: t.fgm / g,
      fg50: t.fg50 / g,
      xpm: t.xpm / g,
      clutch: t.clutch / g,
      fgPct: (t.fgm - t.fga * lgFg) / g,
      xpPct: (t.xpm - t.xpa * lgXp) / g,
      avgDist: (t.fgDist - t.fgm * lgDist) / g,
    };
  }

  // Average and spread come from kickers with a real sample (at least 4 games, or half the season so far).
  const maxG = Math.max(...list.map((x) => x.t.weeks));
  const base = list.filter((x) => x.t.weeks >= Math.min(4, Math.ceil(maxG / 2)));
  const keys = categoriesFor({ clutch }).map((c) => c.key);
  const norm = {};
  for (const k of keys) {
    const v = base.map((x) => x.p[k]);
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
    norm[k] = { m, sd };
  }

  for (const x of list) {
    const z = {};
    let s = 0;
    for (const k of keys) {
      z[k] = (x.p[k] - norm[k].m) / norm[k].sd;
      s += z[k];
    }
    out.set(x.id, { score: s * (x.t.weeks / (x.t.weeks + SHRINK_GAMES)), z, games: x.t.weeks });
  }
  return assignRanks(out);
}

// Weighted average of season scores (newest first, default 3:2:1) for a multi-year view.
export function blendRanks(seasonRanks, weights = [3, 2, 1]) {
  const out = new Map();
  const ids = new Set(seasonRanks.flatMap((r) => [...r.keys()]));
  for (const id of ids) {
    let num = 0, den = 0, games = 0;
    seasonRanks.forEach((r, i) => {
      const v = r.get(id);
      if (!v) return;
      num += v.score * weights[i];
      den += weights[i];
      games += v.games;
    });
    if (den) out.set(id, { score: num / den, games });
  }
  return assignRanks(out);
}

// Add totals from several seasons together (for the blend view's stat columns).
export function sumTotals(maps) {
  const out = new Map();
  for (const m of maps) {
    for (const [id, t] of m) {
      const acc = out.get(id) || emptyTotals();
      for (const f of ['fga', 'fgm', 'fg50', 'fgDist', 'xpa', 'xpm', 'clutch', 'weeks']) acc[f] += t[f];
      acc.long = Math.max(acc.long, t.long);
      out.set(id, acc);
    }
  }
  for (const [id, t] of out) out.set(id, withRates(t));
  return out;
}

function assignRanks(map) {
  [...map.entries()].sort((a, b) => b[1].score - a[1].score).forEach(([, v], i) => { v.rank = i + 1; });
  return map;
}

export const formatScore = (s) => (s == null ? '–' : `${s >= 0 ? '+' : '−'}${Math.abs(s).toFixed(1)}`);

export const SCORE_HELP = 'Kicker Score adds up how far a kicker is above or below average in each roto category, per game. '
  + 'FG% and XP% count makes above what an average kicker would make on the same attempts, so volume matters. '
  + '0 is average; about +5 is elite. Kickers with few games are pulled toward average.';
