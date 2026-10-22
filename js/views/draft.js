// Draft tab: order before the draft, live board while drafting (polls every few seconds), results after.
import { sb, rpc, rows } from '../supa.js';
import { $, $$, esc, busy, toast } from '../ui.js';

const POLL_MS = 3000;

export async function renderDraft(ctx) {
  const { L, root, reload, setTimers } = ctx;
  const teams = [...L.teams].sort((a, b) => (a.draft_slot ?? 99) - (b.draft_slot ?? 99));
  const size = L.league.size;

  if (L.league.status === 'setup') {
    root.innerHTML = `<div class="card">
      <h2>Draft</h2>
      <p>The draft hasn't started. ${L.teams.length}/${size} teams have joined.</p>
      ${teams.some((t) => t.draft_slot) ? `<h3 class="section">Draft order</h3><ol>${teams.map((t) => `<li>${esc(t.name)}</li>`).join('')}</ol>` : '<p class="muted">Draft order will be random unless the commissioner sets it.</p>'}
      ${L.isCommish ? `<p>Set the order and start the draft from the <a href="#/league/${L.id}/settings">League</a> tab.</p>` : ''}
      <p class="note">Snake draft, 3 rounds (${size * 3} picks). Each pick has a ${L.league.pick_seconds}-second clock; when it runs out the best available kicker is picked automatically.</p>
    </div>`;
    return;
  }

  let picks = await rows(sb.from('draft_picks').select('*').eq('league_id', L.id).order('pick_no'));
  let league = L.league;
  let onClock = league.status === 'drafting' ? await rpc('team_on_clock', { p_league: L.id }) : null;
  let autoTried = 0;

  const slotFor = (pickNo) => {
    const i = pickNo - 1;
    const round = Math.floor(i / size);
    return round % 2 === 0 ? (i % size) + 1 : size - (i % size);
  };

  const draw = () => {
    const taken = new Set(picks.map((p) => p.kicker_id));
    const canPick = league.status === 'drafting' && (L.isCommish || L.manageable.some((t) => t.id === onClock));
    const available = L.kickers
      .filter((k) => k.status !== 'non-kicker' && !taken.has(k.id))
      .sort((a, b) => (L.stats(b.id).fgm - L.stats(a.id).fgm) || a.name.localeCompare(b.name));
    const pickBy = new Map(picks.map((p) => [p.pick_no, p]));
    const clockTeam = L.teamById.get(onClock);

    root.innerHTML = `
      ${league.status === 'drafting' ? `
        <div class="card clock ${L.manageable.some((t) => t.id === onClock) ? 'yours' : ''}">
          <div><span class="muted">Pick ${picks.length + 1} of ${size * 3}</span>
            <h2>${clockTeam ? esc(clockTeam.name) : '…'} ${L.manageable.some((t) => t.id === onClock) ? '<span class="pill">Your pick</span>' : ''}</h2></div>
          <div class="timer" id="timer"></div>
        </div>` : `<div class="card"><h2>Draft complete</h2><p class="muted">Lineups start with each team's first two picks.</p></div>`}
      <div class="table-wrap">
        <table class="board">
          <thead><tr><th>Rd</th>${teams.map((t) => `<th>${esc(t.name)}</th>`).join('')}</tr></thead>
          <tbody>${[0, 1, 2].map((r) => `<tr><td>${r + 1}</td>${teams.map((t) => {
            const pickNo = Array.from({ length: size }, (_, i) => r * size + i + 1).find((n) => slotFor(n) === t.draft_slot);
            const p = pickBy.get(pickNo);
            const live = !p && league.status === 'drafting' && pickNo === picks.length + 1;
            return `<td class="${live ? 'live' : ''} ${p?.auto ? 'auto' : ''}">${p ? esc(L.kicker(p.kicker_id).name) : `<span class="muted">${pickNo}</span>`}</td>`;
          }).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>
      ${league.status === 'drafting' ? `
        <div class="card">
          <h3>Available kickers</h3>
          <div class="table-wrap flat"><table>
            <thead><tr><th>Kicker</th><th class="num">FG</th><th class="num">50+</th><th class="num">XP</th><th class="num">FG%</th><th></th></tr></thead>
            <tbody>${available.map((k) => {
              const s = L.stats(k.id);
              return `<tr><td class="name">${esc(k.name)} ${k.status !== 'active' ? `<span class="tag">${esc(k.status)}</span>` : ''}<div class="muted small">${esc(k.team)}</div></td>
                <td class="num">${s.fgm}</td><td class="num">${s.fg50}</td><td class="num">${s.xpm}</td>
                <td class="num">${s.fgPct == null ? '–' : (s.fgPct * 100).toFixed(1)}</td>
                <td>${canPick ? `<button class="primary" data-pick="${k.id}">Draft</button>` : ''}</td></tr>`;
            }).join('')}</tbody>
          </table></div>
          ${L.isCommish ? '<p class="note">As commissioner you can pick for any team, including placeholders.</p>' : ''}
        </div>` : ''}`;

    $$('[data-pick]', root).forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      await rpc('make_pick', { p_league: L.id, p_kicker: b.dataset.pick });
      await refresh();
    })));
    tick();
  };

  const tick = () => {
    const el = $('#timer');
    if (!el || league.status !== 'drafting') return;
    const left = Math.max(0, Math.ceil((new Date(league.clock_started_at).getTime() + league.pick_seconds * 1000 - Date.now()) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    el.classList.toggle('urgent', left <= 10);
    // Clock ran out: any member's browser can trigger the auto-pick (the database checks the time).
    if (left === 0 && Date.now() - autoTried > 5000) {
      autoTried = Date.now();
      rpc('auto_pick', { p_league: L.id }).then(refresh).catch(() => {});
    }
  };

  const refresh = async () => {
    const [p, lg] = await Promise.all([
      rows(sb.from('draft_picks').select('*').eq('league_id', L.id).order('pick_no')),
      rows(sb.from('leagues').select('*').eq('id', L.id)),
    ]);
    const changed = p.length !== picks.length || lg[0].status !== league.status;
    picks = p;
    league = lg[0];
    if (league.status === 'active' && changed) {
      toast('Draft complete!');
      return reload();
    }
    onClock = league.status === 'drafting' ? await rpc('team_on_clock', { p_league: L.id }) : null;
    if (changed) draw();
  };

  draw();
  if (league.status === 'drafting') {
    const poll = setInterval(() => refresh().catch(() => {}), POLL_MS);
    const clock = setInterval(tick, 500);
    setTimers(() => { clearInterval(poll); clearInterval(clock); });
  }
}
