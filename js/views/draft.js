// Draft tab. Before and during the draft: your autodraft switch, your private queue, and the available
// kickers (with Leg Index). While drafting: whose pick it is, the clock, and the board (polls every few seconds).
import { sb, rpc, rows } from '../supa.js';
import { $, $$, esc, busy, toast, fmtDate } from '../ui.js';
import { categoriesFor } from '../data.js';
import { statPicker, sortKickers, statHeaders, statCells } from '../statview.js';

const POLL_MS = 3000;

export function clockLabel(seconds) {
  if (seconds == null) return 'No time limit';
  if (seconds < 120) return `${seconds} seconds`;
  if (seconds < 3600) return `${seconds / 60} minutes`;
  return seconds === 3600 ? '1 hour' : `${seconds / 3600} hours`;
}

function formatLeft(sec) {
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export async function renderDraft(ctx) {
  const { L, root, reload, setTimers, acting } = ctx;
  const teams = [...L.teams].sort((a, b) => (a.draft_slot ?? 99) - (b.draft_slot ?? 99));
  const size = L.league.size;
  const picker = await statPicker(L);
  const cats = categoriesFor({ clutch: L.league.clutch });
  let sort = sessionStorage.getItem('draftSort') || 'rank';

  let league = L.league;
  let picks = await rows(sb.from('draft_picks').select('*').eq('league_id', L.id).order('pick_no'));
  let queue = acting && league.status !== 'active' && league.status !== 'complete'
    ? (await rows(sb.from('draft_queue').select('*').eq('team_id', acting.id).order('pos'))).map((q) => q.kicker_id)
    : [];
  let autodraft = acting?.autodraft ?? false;
  let onClock = league.status === 'drafting' ? await rpc('team_on_clock', { p_league: L.id }) : null;
  let autoTried = 0;

  const slotFor = (pickNo) => {
    const i = pickNo - 1;
    return Math.floor(i / size) % 2 === 0 ? (i % size) + 1 : size - (i % size);
  };

  const saveQueue = (btn, next) => busy(btn, async () => {
    await rpc('set_queue', { p_team: acting.id, p_kickers: next });
    queue = next;
    draw();
  });

  const draw = () => {
    const live = league.status === 'drafting';
    const before = league.status === 'setup';
    const taken = new Set(picks.map((p) => p.kicker_id));
    const mine = L.manageable.some((t) => t.id === onClock);
    const canPick = live && (L.isCommish || mine);
    const available = sortKickers(L.kickers.filter((k) => k.status !== 'non-kicker' && !taken.has(k.id)), picker, sort);
    const pickBy = new Map(picks.map((p) => [p.pick_no, p]));
    const clockTeam = L.teamById.get(onClock);
    const myQueue = queue.filter((k) => !taken.has(k));

    const status = before
      ? `<div class="card">
          <h2>Draft</h2>
          <p>The draft hasn't started. ${L.teams.length}/${size} teams have joined.
          ${L.isCommish ? `Set the order and start it from the <a href="#/league/${L.id}/settings">League</a> tab.` : ''}</p>
          <p class="note">Snake draft, 3 rounds (${size * 3} picks). Pick clock: <b>${clockLabel(league.pick_seconds)}</b>.
          ${league.pick_seconds == null ? 'The draft waits for each person, so it can run over several days.' : 'When the clock runs out, the computer picks for that team.'}
          Build your queue below now; automatic picks take from it first.</p>
        </div>`
      : live
        ? `<div class="card clock ${mine ? 'yours' : ''}">
            <div><span class="muted">Pick ${picks.length + 1} of ${size * 3} · ${clockLabel(league.pick_seconds)}</span>
              <h2>${clockTeam ? esc(clockTeam.name) : '…'} ${mine ? '<span class="pill">Your pick</span>' : ''}</h2>
              ${league.pick_seconds == null ? `<span class="muted small">On the clock since ${fmtDate(league.clock_started_at)}</span>` : ''}</div>
            <div class="timer" id="timer"></div>
          </div>`
        : `<div class="card"><h2>Draft complete</h2><p class="muted">Lineups start with each team's first two picks.</p></div>`;

    const board = before ? '' : `
      <div class="table-wrap">
        <table class="board">
          <thead><tr><th>Rd</th>${teams.map((t) => `<th>${esc(t.name)}${t.autodraft ? ' <span class="muted small" title="Autodraft on">⚙</span>' : ''}</th>`).join('')}</tr></thead>
          <tbody>${[0, 1, 2].map((r) => `<tr><td>${r + 1}</td>${teams.map((t) => {
            const pickNo = Array.from({ length: size }, (_, i) => r * size + i + 1).find((n) => slotFor(n) === t.draft_slot);
            const p = pickBy.get(pickNo);
            const isLive = !p && live && pickNo === picks.length + 1;
            return `<td class="${isLive ? 'live' : ''} ${p?.auto ? 'auto' : ''}" ${p?.auto ? 'title="Automatic pick"' : ''}>${p ? esc(L.kicker(p.kicker_id).name) : `<span class="muted">${pickNo}</span>`}</td>`;
          }).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>`;

    const mySide = (before || live) && acting ? `
      <div class="card">
        <div class="card-head">
          <h3>${esc(acting.name)}: my draft</h3>
          <label class="check switch"><input type="checkbox" id="autodraft" ${autodraft ? 'checked' : ''}> Autodraft for me</label>
        </div>
        <p class="note">${autodraft
          ? 'The computer picks for you the moment you\'re on the clock: your queue first, then the best available by Leg Index.'
          : 'Turn on Autodraft if you can\'t make your picks. Your queue is also used if your clock runs out.'}</p>
        <h3 class="section">My queue (only you can see this)</h3>
        ${myQueue.length ? `<ol class="claims">${myQueue.map((k, i) => `
          <li>
            <span><b>${esc(L.kicker(k).name)}</b> <span class="muted small">${esc(L.kicker(k).team)}</span></span>
            <span class="actions">
              ${canPick ? `<button class="primary" data-pick="${k}">Draft</button>` : ''}
              <button class="icon" data-qup="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
              <button class="icon" data-qdown="${i}" ${i === myQueue.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
              <button class="link" data-qremove="${k}">Remove</button>
            </span>
          </li>`).join('')}</ol>` : '<p class="muted">Empty. Use <b>+ Queue</b> on kickers below.</p>'}
      </div>` : '';

    const pool = before || live ? `
      <div class="card">
        <div class="card-head">
          <h3>Available kickers</h3>
          <div class="controls">${picker.select()}</div>
        </div>
        <div class="table-wrap flat"><table>
          <thead><tr><th class="num">#</th><th>Kicker</th>${statHeaders(cats, sort)}<th></th></tr></thead>
          <tbody>${available.map((k, i) => `<tr>
              <td class="num muted">${i + 1}</td>
              <td class="name">${esc(k.name)} ${k.status !== 'active' ? `<span class="tag">${esc(k.status)}</span>` : ''}<div class="muted small">${esc(k.team)}</div></td>
              ${statCells(k.id, picker, cats)}
              <td class="actions-cell">
                ${acting && !myQueue.includes(k.id) ? `<button data-queue="${k.id}">+ Queue</button>` : ''}
                ${canPick ? `<button class="primary" data-pick="${k.id}">Draft</button>` : ''}
              </td></tr>`).join('')}</tbody>
        </table></div>
        <p class="note">Click a column to sort. <b>Leg Index</b> adds up how far above or below average a kicker is in every category, per game (0 is average, about +5 is elite).
        ${L.isCommish ? ' As commissioner you can pick for any team, including placeholders.' : ''}</p>
      </div>` : '';

    root.innerHTML = status + board + (mySide ? `<div class="draft-cols">${mySide}${pool}</div>` : pool);

    $('#statsfrom')?.addEventListener('change', (e) => { picker.choice = e.target.value; draw(); });
    $$('[data-sort]', root).forEach((th) => th.addEventListener('click', () => {
      sort = th.dataset.sort;
      sessionStorage.setItem('draftSort', sort);
      draw();
    }));
    $$('[data-pick]', root).forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      await rpc('make_pick', { p_league: L.id, p_kicker: b.dataset.pick });
      await refresh(true);
    })));
    $('#autodraft')?.addEventListener('change', (e) => busy(e.target, async () => {
      await rpc('set_autodraft', { p_team: acting.id, p_on: e.target.checked });
      autodraft = e.target.checked;
      acting.autodraft = autodraft;
      toast(autodraft ? 'Autodraft on' : 'Autodraft off');
      await refresh(true);
    }));
    $$('[data-queue]', root).forEach((b) => b.addEventListener('click', () => saveQueue(b, [...myQueue, b.dataset.queue])));
    $$('[data-qremove]', root).forEach((b) => b.addEventListener('click', () => saveQueue(b, myQueue.filter((k) => k !== b.dataset.qremove))));
    const swap = (b, i, d) => {
      const next = [...myQueue];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      saveQueue(b, next);
    };
    $$('[data-qup]', root).forEach((b) => b.addEventListener('click', () => swap(b, +b.dataset.qup, -1)));
    $$('[data-qdown]', root).forEach((b) => b.addEventListener('click', () => swap(b, +b.dataset.qdown, 1)));
    tick();
  };

  const tick = () => {
    const el = $('#timer');
    if (!el || league.status !== 'drafting') return;
    if (league.pick_seconds == null) {
      el.textContent = '∞';
      el.title = 'No time limit';
      return;
    }
    const left = Math.max(0, Math.ceil((new Date(league.clock_started_at).getTime() + league.pick_seconds * 1000 - Date.now()) / 1000));
    el.textContent = formatLeft(left);
    el.classList.toggle('urgent', left <= 10);
    // Clock ran out: the server also does this every minute, but an open page makes it immediate.
    if (left === 0 && Date.now() - autoTried > 5000) {
      autoTried = Date.now();
      rpc('auto_pick', { p_league: L.id }).then(() => refresh(true)).catch(() => {});
    }
  };

  const refresh = async (force = false) => {
    const [p, lg] = await Promise.all([
      rows(sb.from('draft_picks').select('*').eq('league_id', L.id).order('pick_no')),
      rows(sb.from('leagues').select('*').eq('id', L.id)),
    ]);
    const changed = force || p.length !== picks.length || lg[0].status !== league.status;
    picks = p;
    const wasRunning = league.status !== 'active';
    league = lg[0];
    if (league.status === 'active' && wasRunning && changed) {
      toast('Draft complete!');
      return reload();
    }
    if (league.status === 'drafting' && changed && L.league.status === 'setup') return reload();
    onClock = league.status === 'drafting' ? await rpc('team_on_clock', { p_league: L.id }) : null;
    if (changed) draw();
  };

  draw();
  if (league.status === 'drafting' || league.status === 'setup') {
    const poll = setInterval(() => refresh().catch(() => {}), league.status === 'setup' ? 15000 : POLL_MS);
    const clock = setInterval(tick, 500);
    setTimers(() => { clearInterval(poll); clearInterval(clock); });
  }
}
