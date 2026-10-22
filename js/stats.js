import { rankKickers, formatScore, SCORE_HELP } from './rank.js';
import { loadSeason, categoriesFor, kickerTotals, formatStat, gameFor, currentWeek } from './data.js';

const $ = (id) => document.getElementById(id);
const state = { sort: 'score', dir: -1 };

const kickoffFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function fillWeeks(maxWeek, dataWeeks) {
  const opts = Array.from({ length: maxWeek }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
  $('from').innerHTML = opts;
  $('to').innerHTML = opts;
  $('from').value = 1;
  $('to').value = Math.max(1, dataWeeks);
}

async function changeSeason() {
  const { schedule, stats } = await loadSeason($('season').value);
  const maxWeek = Math.max(...schedule.games.map((g) => g.week));
  fillWeeks(maxWeek, stats.weeksWithData);
  render();
}

async function render() {
  const season = $('season').value;
  const { kickers, schedule, stats } = await loadSeason(season);
  const from = +$('from').value, to = Math.max(+$('from').value, +$('to').value);
  const cats = categoriesFor({ clutch: $('clutch').checked });
  const week = currentWeek(schedule);
  const seasonOver = !schedule.games.some((g) => new Date(g.kickoff) > new Date());

  $('updated').textContent = `Data through week ${stats.weeksWithData} · updated ${new Date(stats.updated).toLocaleString()}`;

  let rows = kickers.kickers
    .filter((k) => $('show').value === 'all' ? stats.stats[k.id] : k.status !== 'non-kicker')
    .map((k) => ({ ...k, t: kickerTotals(stats.stats[k.id], from, to), next: seasonOver ? null : gameFor(schedule, k.team, week) }));

  const ranks = rankKickers(new Map(Object.keys(stats.stats).map((id) => [id, kickerTotals(stats.stats[id], from, to)])),
    { clutch: $('clutch').checked });
  rows.forEach((r) => { r.score = ranks.get(r.id)?.score ?? null; });
  const sortVal = (r) => state.sort === 'name' ? r.name : state.sort === 'score' ? (r.score ?? -99) : (r.t[state.sort] ?? -1);
  rows.sort((a, b) => {
    const x = sortVal(a), y = sortVal(b);
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * state.dir || a.name.localeCompare(b.name);
  });

  const th = (key, label, title = '') =>
    `<th data-sort="${key}" title="${title}" class="${state.sort === key ? 'sorted' : ''}">${label}${state.sort === key ? (state.dir < 0 ? ' ▾' : ' ▴') : ''}</th>`;
  $('table').tHead.innerHTML = `<tr>${th('name', 'Kicker')}<th>Team</th>${th('score', 'Leg Index', SCORE_HELP)}${cats.map((c) => th(c.key, c.label, c.title)).join('')}${th('long', 'Long')}${th('fga', 'FGA')}<th>${seasonOver ? '' : `Wk ${week} game`}</th></tr>`;

  $('table').tBodies[0].innerHTML = rows.map((r) => {
    const opp = r.next ? (r.next.home === r.team ? `vs ${r.next.away}` : `@ ${r.next.home}`) : (seasonOver ? '' : 'BYE');
    const when = r.next ? `<span class="muted">${kickoffFmt.format(new Date(r.next.kickoff))}</span>` : '';
    const status = r.status === 'active' ? '' : `<span class="tag">${r.status}</span>`;
    return `<tr>
      <td class="name">${r.name} ${status}</td>
      <td>${r.team}</td>
      <td class="num score ${r.score >= 0 ? 'pos' : 'neg'}">${formatScore(r.score)}</td>
      ${cats.map((c) => `<td class="num">${formatStat(c.key, r.t[c.key])}</td>`).join('')}
      <td class="num">${r.t.long || '–'}</td>
      <td class="num">${r.t.fga}</td>
      <td class="game">${opp} ${when}</td>
    </tr>`;
  }).join('');
}

$('table').tHead.addEventListener('click', (e) => {
  const key = e.target.closest('th')?.dataset.sort;
  if (!key) return;
  state.dir = state.sort === key ? -state.dir : (key === 'name' ? 1 : -1);
  state.sort = key;
  render();
});
$('season').addEventListener('change', changeSeason);
for (const id of ['from', 'to', 'show', 'clutch']) $(id).addEventListener('change', render);

changeSeason().catch((err) => { $('updated').textContent = err.message; });
