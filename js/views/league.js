// League page: header, tabs, and the My Team / Standings / Players / Waivers / Activity tabs.
import { sb, rpc, rows } from '../supa.js';
import { $, $$, esc, busy, toast, choose, confirmBox, fmtKickoff, fmtDate } from '../ui.js';
import { loadLeague } from '../league.js';
import { categoriesFor, formatStat } from '../data.js';
import { renderDraft } from './draft.js';
import { statPicker, sortKickers, statHeaders, statCells } from '../statview.js';
import { renderSettings } from './settings.js';

const TABS = [
  ['team', 'My Team'], ['standings', 'Standings'], ['players', 'Players'],
  ['waivers', 'Waivers'], ['draft', 'Draft'], ['activity', 'Activity'], ['settings', 'League'],
];

let stopTimers = () => {};

export async function renderLeague(app, user, id, tab) {
  stopTimers();
  const L = await loadLeague(id, user);
  if (tab === 'team' && L.league.status !== 'active') tab = L.league.status === 'setup' && L.isCommish ? 'settings' : 'draft';

  // Which team the user is acting for (commissioners can run placeholder teams).
  const key = `acting:${id}`;
  let acting = L.teamById.get(sessionStorage.getItem(key));
  if (!acting || !L.manageable.includes(acting)) acting = L.myTeam || L.manageable[0] || null;
  const reload = () => renderLeague(app, user, id, tab);

  app.innerHTML = `
    <div class="page-head">
      <h1>${esc(L.league.name)}</h1>
      <p class="muted">${L.league.size} teams · ${L.league.season} season · ${L.league.status === 'active' ? `Week ${L.week}` : statusText(L.league.status)}</p>
    </div>
    <nav class="tabs" role="tablist">
      ${TABS.map(([k, label]) => `<a class="tab ${k === tab ? 'active' : ''}" href="#/league/${id}/${k}">${label}</a>`).join('')}
    </nav>
    ${L.manageable.length > 1 && ['team', 'players', 'waivers', 'draft'].includes(tab) ? `
      <label class="acting">Managing
        <select id="acting">${L.manageable.map((t) => `<option value="${t.id}" ${t === acting ? 'selected' : ''}>${esc(t.name)}${t.owner ? '' : ' (placeholder)'}</option>`).join('')}</select>
      </label>` : ''}
    <section id="tab"></section>`;

  $('#acting')?.addEventListener('change', (e) => { sessionStorage.setItem(key, e.target.value); reload(); });

  const root = $('#tab');
  const ctx = { L, acting, reload, root, setTimers: (stop) => { stopTimers = stop; } };
  const views = { team: renderTeam, standings: renderStandings, players: renderPlayers, waivers: renderWaivers,
    draft: renderDraft, activity: renderActivity, settings: renderSettings };
  await (views[tab] || renderTeam)(ctx);
}

function statusText(s) {
  return { setup: 'Setting up', drafting: 'Draft in progress', complete: 'Season complete' }[s] || s;
}

// ---------------------------------------------------------------------------- My Team
function kickerRow(L, kid, actions) {
  const k = L.kicker(kid);
  const s = L.stats(kid);
  const m = L.matchup(kid);
  const status = k.status !== 'active' ? `<span class="tag">${esc(k.status)}</span>` : '';
  return `<div class="kicker-row ${m.locked ? 'locked' : ''}">
    <div class="who">
      <b>${esc(k.name)}</b> ${status}
      <div class="muted">${esc(k.team)} · ${m.text}${m.kickoff ? ` · ${m.locked ? '<span class="lock">Locked</span>' : fmtKickoff(m.kickoff)}` : ''}</div>
    </div>
    <div class="line muted">FG ${s.fgm}/${s.fga} · 50+ ${s.fg50} · XP ${s.xpm}/${s.xpa}</div>
    <div class="actions">${actions}</div>
  </div>`;
}

async function renderTeam({ L, acting, reload, root }) {
  if (!acting) {
    root.innerHTML = '<p class="muted">You don\'t have a team in this league.</p>';
    return;
  }
  const roster = L.rosterOf(acting.id);
  const starters = L.startersOf(acting.id);
  const bench = roster.filter((k) => !starters.includes(k));
  const slots = [starters[0] || null, starters[1] || null];

  const save = (btn, next) => busy(btn, async () => {
    await rpc('set_lineup', { p_team: acting.id, p_starters: next });
    toast('Lineup saved');
    reload();
  });

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>${esc(acting.name)}</h2>
        <span class="muted">Week ${L.week} · Adds used ${acting.adds_used}/${L.league.add_limit}</span>
      </div>
      <h3 class="section">Starters</h3>
      ${slots.map((kid, i) => kid
        ? kickerRow(L, kid, `${L.locked(kid) ? '' : `<button data-bench="${i}">Bench</button>`}`)
        : `<div class="kicker-row empty"><div class="who muted">Empty slot</div><div></div><div></div></div>`).join('')}
      <h3 class="section">Bench</h3>
      ${bench.length ? bench.map((kid) => kickerRow(L, kid, L.locked(kid) ? '' : `<button class="primary" data-start="${kid}">Start</button>`)).join('')
        : '<p class="muted">No one on the bench.</p>'}
      <p class="note">Lineups lock one kicker at a time, when that kicker's game kicks off. Kickers on a bye score nothing that week.</p>
    </div>
    <div class="card">
      <h3>Roster moves</h3>
      <div class="chips">${roster.map((kid) => `<button class="chip" data-drop="${kid}" ${L.locked(kid) && starters.includes(kid) ? 'disabled title="Locked"' : ''}>Drop ${esc(L.kicker(kid).name)}</button>`).join('')}</div>
      <p class="note">To pick someone up, go to <a href="#/league/${L.id}/players">Players</a>.</p>
    </div>`;

  $$('[data-bench]', root).forEach((b) => b.addEventListener('click', () => {
    const next = [...slots];
    next[+b.dataset.bench] = null;
    save(b, next);
  }));
  $$('[data-start]', root).forEach((b) => b.addEventListener('click', async () => {
    const kid = b.dataset.start;
    const open = slots.indexOf(null);
    if (open >= 0) {
      const next = [...slots];
      next[open] = kid;
      return save(b, next);
    }
    const swappable = slots.filter((s) => !L.locked(s));
    if (!swappable.length) return toast('Both starters are locked this week', 'error');
    const pick = await choose({
      title: `Start ${L.kicker(kid).name} in place of…`,
      body: '',
      buttons: [{ label: 'Cancel', value: 'cancel' }, ...swappable.map((s) => ({ label: L.kicker(s).name, value: s, primary: true }))],
    });
    if (pick) save(b, slots.map((s) => (s === pick.value ? kid : s)));
  }));
  $$('[data-drop]', root).forEach((b) => b.addEventListener('click', async () => {
    const name = L.kicker(b.dataset.drop).name;
    if (!(await confirmBox(`Drop ${name}?`, `${esc(name)} goes on waivers until the next waiver run.`, 'Drop', true))) return;
    busy(b, async () => {
      await rpc('add_drop', { p_team: acting.id, p_add: null, p_drop: b.dataset.drop });
      toast(`Dropped ${name}`);
      reload();
    });
  }));
}

// ---------------------------------------------------------------------------- Standings
const STAND_COLS = {
  fgm: ['fgm', 'pts_fgm'], fg50: ['fg50', 'pts_fg50'], xpm: ['xpm', 'pts_xpm'], fgPct: ['fg_pct', 'pts_fg_pct'],
  xpPct: ['xp_pct', 'pts_xp_pct'], avgDist: ['avg_dist', 'pts_avg_dist'], clutch: ['clutch', 'pts_clutch'],
};

async function renderStandings({ L, root }) {
  const table = await rpc('league_standings', { p_league: L.id });
  const cats = categoriesFor({ clutch: L.league.clutch });
  const weeks = table[0]?.weeks || 0;
  const min = Math.ceil(1.5 * weeks);
  const pts = (v) => (Number(v) % 1 ? Number(v).toFixed(1) : String(Number(v)));

  root.innerHTML = `
    <div class="table-wrap">
      <table class="standings">
        <thead><tr><th>#</th><th>Team</th>${cats.map((c) => `<th class="num" title="${c.title}">${c.label}</th>`).join('')}<th class="num">Total</th></tr></thead>
        <tbody>${table.map((r, i) => {
          const t = L.teamById.get(r.team_id);
          return `<tr class="${t === L.myTeam ? 'mine' : ''}">
            <td>${i + 1}</td>
            <td class="name">${esc(r.team_name)}<div class="muted small">${esc(L.teamLabel(t))}</div></td>
            ${cats.map((c) => {
              const [valKey, ptsKey] = STAND_COLS[c.key];
              const raw = r[valKey];
              const shown = raw == null ? '–' : formatStat(c.key, Number(raw));
              const under = c.type === 'rate' && weeks > 0 && (c.key === 'xpPct' ? r.xpa : r.fga) < min;
              return `<td class="num"><span class="${under ? 'under' : ''}" ${under ? 'title="Below the attempt minimum, ranked last"' : ''}>${shown}</span><div class="pts">${pts(r[ptsKey])}</div></td>`;
            }).join('')}
            <td class="num total">${pts(r.total)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <p class="note">Each category: best team gets ${L.league.size} points, worst gets 1, ties split. Small numbers are standings points.
    Rate stats (FG%, XP%, Avg Dist) need ${min || '1.5 per week'} attempts${weeks ? ` (1.5 × ${weeks} weeks)` : ''}, or the team ranks last in them.</p>`;
}

// ---------------------------------------------------------------------------- Players
async function renderPlayers({ L, acting, reload, root }) {
  const cats = categoriesFor({ clutch: L.league.clutch });
  const picker = await statPicker(L);
  const state = { filter: sessionStorage.getItem('playerFilter') || 'available', sort: sessionStorage.getItem('playerSort') || 'rank' };

  const draw = () => {
    let list = L.kickers.filter((k) => k.status !== 'non-kicker');
    if (state.filter === 'available') list = list.filter((k) => L.availability(k.id).kind !== 'rostered');
    sortKickers(list, picker, state.sort);

    root.innerHTML = `
      <div class="controls">
        <label>Show
          <select id="pf">
            <option value="available" ${state.filter === 'available' ? 'selected' : ''}>Available</option>
            <option value="all" ${state.filter === 'all' ? 'selected' : ''}>All kickers</option>
          </select>
        </label>
        ${picker.select()}
        ${L.league.status === 'active' && acting ? `<span class="muted">Adds used: ${acting.adds_used}/${L.league.add_limit}</span>` : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th class="num">#</th><th>Kicker</th><th>Status</th>${statHeaders(cats, state.sort)}<th>Wk ${L.week}</th><th></th></tr></thead>
          <tbody>${list.map((k, i) => {
            const a = L.availability(k.id);
            const m = L.matchup(k.id);
            const where = a.kind === 'rostered' ? esc(a.team.name) : a.kind === 'waivers' ? `Waivers until ${fmtDate(a.until)}` : 'Free agent';
            let action = '';
            if (L.league.status === 'active' && acting && a.kind !== 'rostered') {
              action = a.kind === 'waivers'
                ? `<button data-claim="${k.id}">Claim</button>`
                : `<button class="primary" data-add="${k.id}">Add</button>`;
            }
            return `<tr>
              <td class="num muted">${i + 1}</td>
              <td class="name">${esc(k.name)} ${k.status !== 'active' ? `<span class="tag">${esc(k.status)}</span>` : ''}<div class="muted small">${esc(k.team)}</div></td>
              <td class="small">${where}</td>
              ${statCells(k.id, picker, cats)}
              <td class="small">${m.text}${m.kickoff ? `<div class="muted">${m.locked ? 'Locked' : fmtKickoff(m.kickoff)}</div>` : ''}</td>
              <td>${action}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;

    $('#pf').addEventListener('change', (e) => { state.filter = e.target.value; sessionStorage.setItem('playerFilter', state.filter); draw(); });
    $('#statsfrom').addEventListener('change', (e) => { picker.choice = e.target.value; draw(); });
    $$('[data-sort]', root).forEach((th) => th.addEventListener('click', () => {
      state.sort = th.dataset.sort;
      sessionStorage.setItem('playerSort', state.sort);
      draw();
    }));
    $$('[data-add]', root).forEach((b) => b.addEventListener('click', () => pickup(b, b.dataset.add, false)));
    $$('[data-claim]', root).forEach((b) => b.addEventListener('click', () => pickup(b, b.dataset.claim, true)));
  };

  // Add a free agent now, or put in a waiver claim. Asks who to drop when the roster is full.
  const pickup = async (btn, kid, claim) => {
    const name = L.kicker(kid).name;
    const roster = L.rosterOf(acting.id);
    let drop = null;
    if (roster.length >= 3) {
      const options = roster.filter((r) => !(L.locked(r) && L.startersOf(acting.id).includes(r)));
      const res = await choose({
        title: `${claim ? 'Claim' : 'Add'} ${name}: who do you drop?`,
        body: options.map((r, i) => `<label class="radio"><input type="radio" name="drop" value="${r}" ${i === 0 ? 'checked' : ''}> ${esc(L.kicker(r).name)}</label>`).join(''),
        buttons: [{ label: 'Cancel', value: 'cancel' }, { label: claim ? 'Submit claim' : 'Add and drop', value: 'ok', primary: true }],
      });
      if (!res) return;
      drop = res.form.drop;
    } else if (!claim && !(await confirmBox(`Add ${name}?`, `This uses 1 of your ${L.league.add_limit} adds.`, 'Add'))) {
      return;
    }
    busy(btn, async () => {
      if (claim) {
        await rpc('submit_claim', { p_team: acting.id, p_add: kid, p_drop: drop });
        toast(`Claim on ${name} submitted`);
      } else {
        await rpc('add_drop', { p_team: acting.id, p_add: kid, p_drop: drop });
        toast(`Added ${name}`);
      }
      reload();
    });
  };

  draw();
}

// ---------------------------------------------------------------------------- Waivers
async function renderWaivers({ L, acting, reload, root }) {
  const [claims, standings] = await Promise.all([
    acting ? rows(sb.from('waiver_claims').select('*').eq('team_id', acting.id).order('created_at', { ascending: false }).limit(40)) : [],
    rpc('league_standings', { p_league: L.id }),
  ]);
  const pending = claims.filter((c) => c.status === 'pending').sort((a, b) => a.pref - b.pref);
  const done = claims.filter((c) => c.status !== 'pending');
  const order = standings
    .map((s) => ({ ...s, slot: L.teamById.get(s.team_id)?.draft_slot ?? 0 }))
    .sort((a, b) => Number(a.total) - Number(b.total) || b.slot - a.slot);
  const nextRun = nextWednesday();

  root.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <h2>${acting ? `${esc(acting.name)}: pending claims` : 'Pending claims'}</h2>
        <p class="muted">Next waiver run: ${fmtDate(nextRun)}. Claims are tried in this order.</p>
        ${pending.length ? `<ol class="claims">${pending.map((c, i) => `
          <li>
            <span><b>${esc(L.kicker(c.add_kicker).name)}</b>${c.drop_kicker ? ` <span class="muted">drop ${esc(L.kicker(c.drop_kicker).name)}</span>` : ''}</span>
            <span class="actions">
              <button class="icon" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
              <button class="icon" data-down="${i}" ${i === pending.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
              <button class="link" data-cancel="${c.id}">Cancel</button>
            </span>
          </li>`).join('')}</ol>` : '<p class="muted">No pending claims. Claim kickers on waivers from the <a href="#/league/' + L.id + '/players">Players</a> tab.</p>'}
        ${done.length ? `<h3 class="section">Results</h3><ul class="plain">${done.slice(0, 10).map((c) => `
          <li><span class="pill ${c.status}">${c.status}</span> ${esc(L.kicker(c.add_kicker).name)} <span class="muted">${c.note ? `· ${esc(c.note)}` : ''} · ${fmtDate(c.processed_at || c.created_at)}</span></li>`).join('')}</ul>` : ''}
      </div>
      <div class="card">
        <h2>Waiver order</h2>
        <p class="muted">Worst in the standings claims first. Before any games count, it's the reverse of the draft order.</p>
        <ol>${order.map((s) => `<li class="${L.teamById.get(s.team_id) === L.myTeam ? 'mine' : ''}">${esc(s.team_name)}</li>`).join('')}</ol>
      </div>
    </div>`;

  const ids = pending.map((c) => c.id);
  const move = (btn, i, d) => busy(btn, async () => {
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    await rpc('reorder_claims', { p_team: acting.id, p_claims: ids });
    reload();
  });
  $$('[data-up]', root).forEach((b) => b.addEventListener('click', () => move(b, +b.dataset.up, -1)));
  $$('[data-down]', root).forEach((b) => b.addEventListener('click', () => move(b, +b.dataset.down, 1)));
  $$('[data-cancel]', root).forEach((b) => b.addEventListener('click', () => busy(b, async () => {
    await rpc('cancel_claim', { p_claim: b.dataset.cancel });
    reload();
  })));
}

function nextWednesday() {
  const now = new Date();
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10));
  t.setUTCDate(t.getUTCDate() + ((3 - t.getUTCDay() + 7) % 7));
  if (t <= now) t.setUTCDate(t.getUTCDate() + 7);
  return t.toISOString();
}

// ---------------------------------------------------------------------------- Activity
async function renderActivity({ L, root }) {
  const log = await rows(sb.from('transactions').select('*').eq('league_id', L.id).order('created_at', { ascending: false }).limit(100));
  root.innerHTML = `<div class="card">
    <h2>Activity</h2>
    ${log.length ? `<ul class="plain activity">${log.map((t) => `
      <li><span class="pill ${t.kind}">${t.kind}</span> <b>${esc(L.teamById.get(t.team_id)?.name || '')}</b> ${esc(t.detail || '')}
      <span class="muted small">${fmtDate(t.created_at)}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}
  </div>`;
}
