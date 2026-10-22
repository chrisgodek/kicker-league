// "Stats from" picker shared by the Draft and Players tabs: one of the last three seasons, or a blend,
// with Leg Index ranks for whichever is chosen.
import { sb, rows } from './supa.js';
import { emptyTotals, addWeek, withRates, formatStat } from './data.js';
import { rankKickers, blendRanks, sumTotals, formatScore, SCORE_HELP } from './rank.js';
import { esc } from './ui.js';

const cache = new Map();

function seasonTotals(season) {
  if (!cache.has(season)) {
    cache.set(season, rows(sb.from('kicker_weeks').select('*').eq('season', season)).then((list) => {
      const totals = new Map();
      let lastWeek = 0;
      for (const w of list) {
        if (!totals.has(w.kicker_id)) totals.set(w.kicker_id, emptyTotals());
        addWeek(totals.get(w.kicker_id), { ...w, fgDist: w.fg_dist });
        lastWeek = Math.max(lastWeek, w.week);
      }
      for (const [k, t] of totals) totals.set(k, withRates(t));
      return { season, totals, lastWeek };
    }));
  }
  return cache.get(season);
}

export async function statPicker(L) {
  const S = L.league.season;
  const loaded = await Promise.all([S, S - 1, S - 2, S - 3].map(seasonTotals));
  const seasons = loaded.filter((x) => x.totals.size).slice(0, 3);
  const clutch = L.league.clutch;

  const options = seasons.map((x) => ({
    value: String(x.season),
    label: x.lastWeek < 18 ? `${x.season} (thru week ${x.lastWeek})` : String(x.season),
  }));
  if (seasons.length > 1) options.push({ value: 'blend', label: `${seasons.length}-year blend` });

  const key = `statsFrom:${L.id}`;
  const fallback = seasons[0] && seasons[0].season === S && seasons[0].lastWeek < 4 && seasons[1] ? seasons[1] : seasons[0];
  let choice = sessionStorage.getItem(key);
  if (!options.some((o) => o.value === choice)) choice = fallback ? String(fallback.season) : null;

  const views = new Map();
  const view = (value) => {
    if (!views.has(value)) {
      if (value === 'blend') {
        const ranks = blendRanks(seasons.map((x) => rankKickers(x.totals, { clutch })));
        views.set(value, { totals: sumTotals(seasons.map((x) => x.totals)), ranks });
      } else {
        const x = seasons.find((s) => String(s.season) === value);
        views.set(value, x ? { totals: x.totals, ranks: rankKickers(x.totals, { clutch }) } : { totals: new Map(), ranks: new Map() });
      }
    }
    return views.get(value);
  };

  return {
    options,
    get choice() { return choice; },
    set choice(v) { choice = v; sessionStorage.setItem(key, v); },
    get current() { return view(choice); },
    stats(id) { return this.current.totals.get(id) || withRates(emptyTotals()); },
    rank(id) { return this.current.ranks.get(id) || null; },
    select(id = 'statsfrom') {
      return `<label>Stats from <select id="${id}">${options.map((o) => `<option value="${o.value}" ${o.value === choice ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
    },
  };
}

// Sorting: 'rank' uses Leg Index; anything else is a stat key (higher is better).
export function sortKickers(list, picker, sort) {
  const val = (id) => (sort === 'rank' ? (picker.rank(id)?.score ?? -99) : (picker.stats(id)[sort] ?? -1));
  return list.sort((a, b) => val(b.id) - val(a.id) || a.name.localeCompare(b.name));
}

export function statHeaders(cats, sort) {
  const th = (key, label, title = '') =>
    `<th class="num sortable ${sort === key ? 'sorted' : ''}" data-sort="${key}" title="${esc(title)}">${label}${sort === key ? ' ▾' : ''}</th>`;
  return `${th('rank', 'Leg Index', SCORE_HELP)}<th class="num" title="Games with a kick">G</th>${cats.map((c) => th(c.key, c.label, c.title)).join('')}`;
}

export function statCells(id, picker, cats) {
  const s = picker.stats(id);
  const r = picker.rank(id);
  return `<td class="num score ${r && r.score >= 0 ? 'pos' : 'neg'}">${r ? formatScore(r.score) : '–'}</td>
    <td class="num muted">${s.weeks || '–'}</td>
    ${cats.map((c) => `<td class="num">${formatStat(c.key, s[c.key])}</td>`).join('')}`;
}

