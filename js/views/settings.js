// League tab: invite link, teams, and (for the commissioner) settings, draft order, roster fixes, reset.
import { rpc } from '../supa.js';
import { $, $$, esc, busy, toast, confirmBox } from '../ui.js';
import { clockLabel } from './draft.js';

const CLOCKS = [30, 60, 90, 120, 300, 3600, 14400, 28800, 86400, null];

export async function renderSettings({ L, reload, root }) {
  const lg = L.league;
  const c = L.isCommish;
  const setup = lg.status === 'setup';
  const invite = `${location.origin}${location.pathname}#/join/${lg.invite_code}`;
  const ordered = [...L.teams].sort((a, b) => (a.draft_slot ?? 99) - (b.draft_slot ?? 99));
  // Each week's first kickoff, and the first week that hasn't started yet.
  const firstKick = {};
  for (const g of L.games) if (!firstKick[g.week] || g.kickoff < firstKick[g.week]) firstKick[g.week] = g.kickoff;
  const weeks = Object.keys(firstKick).map(Number).sort((a, b) => a - b);
  const openFrom = weeks.find((w) => new Date(firstKick[w]) > new Date()) ?? 19;
  const weekDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  root.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <h2>Invite friends</h2>
        <p class="muted">Give them this code. They create an account, click <b>Join a league</b>, and enter it.</p>
        <div class="invite-code" id="code">${esc(lg.invite_code)}</div>
        <div class="row">
          <button id="copy-code">Copy code</button>
          <button id="copy">Copy invite link</button>
        </div>
        ${c ? `
          <form id="codeform" class="row">
            <label>Choose your own code <input name="code" maxlength="12" placeholder="KICKERS26" autocapitalize="characters" pattern="[A-Za-z0-9]{4,12}" title="4 to 12 letters and numbers"></label>
            <button type="submit">Set code</button>
            <button type="button" id="newcode" class="link">New random code</button>
          </form>
          <p class="note">Changing the code stops the old code and link from working. People already in the league stay in.</p>` : ''}
        ${L.myTeam ? `
          <form id="rename" class="row">
            <label>Your team name <input name="name" value="${esc(L.myTeam.name)}" maxlength="40" required></label>
            <button type="submit">Save</button>
          </form>` : ''}
      </div>

      <div class="card">
        <h2>Teams <span class="muted">${L.teams.length}/${lg.size}</span></h2>
        <ol class="teams">${ordered.map((t, i) => `
          <li>
            <span><b>${esc(t.name)}</b> <span class="muted small">${esc(L.teamLabel(t))}${t.owner === lg.commissioner ? ' · Commissioner' : ''}</span></span>
            ${c ? `<span class="actions">
              ${setup ? `<button class="icon" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button class="icon" data-down="${i}" ${i === ordered.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>` : ''}
              ${t.owner !== lg.commissioner && (setup || t.owner) ? `<button class="link danger" data-remove="${t.id}">${setup ? 'Remove' : 'Take over'}</button>` : ''}
            </span>` : ''}
          </li>`).join('')}</ol>
        ${c && setup ? `
          <p class="muted small">${ordered.some((t) => t.draft_slot) ? 'This is the draft order.' : 'Draft order is random until you set it.'} Use the arrows to set it.</p>
          <div class="row">
            ${L.teams.length < lg.size ? '<button id="placeholder">Add placeholder team</button>' : ''}
            <button id="randomize">Randomize order</button>
            <button class="primary" id="start" ${L.teams.length < lg.size ? 'disabled' : ''}>Start draft</button>
          </div>
          ${L.teams.length < lg.size ? `<p class="note">The draft can start once all ${lg.size} spots are filled. Placeholder teams are run by you; a friend who joins later takes one over.</p>` : ''}` : ''}
      </div>
    </div>

    ${c ? `
    <div class="grid-2">
      <form class="card stack" id="settings">
        <h2>Settings</h2>
        <label>League name <input name="name" value="${esc(lg.name)}" maxlength="60" required></label>
        <div class="row">
          <label>First scoring week
            <select name="start" ${setup ? '' : 'disabled'}>${weeks.map((w) => `<option value="${w}" ${w === lg.start_week ? 'selected' : ''} ${w < openFrom && w !== lg.start_week ? 'disabled' : ''}>Week ${w} (${weekDate.format(new Date(firstKick[w]))})${w < openFrom ? ' – started' : ''}</option>`).join('')}</select>
          </label>
          <label>Adds per team
            <input name="adds" type="number" min="0" max="100" value="${lg.add_limit}">
          </label>
          <label>Pick clock
            <select name="clock">
              <optgroup label="Live draft">${CLOCKS.slice(0, 5).map((v) => `<option value="${v}" ${v === lg.pick_seconds ? 'selected' : ''}>${clockLabel(v)}</option>`).join('')}</optgroup>
              <optgroup label="Slow draft (over days)">${CLOCKS.slice(5).map((v) => `<option value="${v ?? ''}" ${v === lg.pick_seconds ? 'selected' : ''}>${clockLabel(v)}</option>`).join('')}</optgroup>
            </select>
          </label>
        </div>
        <label class="check"><input type="checkbox" name="clutch" ${lg.clutch ? 'checked' : ''} ${setup ? '' : 'disabled'}> Clutch FGs category (go-ahead or tying FGs in the last 2:00 or OT)</label>
        <p class="note">${setup
          ? 'Stats count from the first scoring week on. You can draft any time before it; lineups for that week open after the draft. If the week has already started when the draft ends, scoring starts the next week.'
          : 'First scoring week and categories are locked once the draft starts.'}</p>
        <button class="primary" type="submit">Save settings</button>
      </form>

      <div class="card stack">
        <h2>Commissioner tools</h2>
        ${lg.status === 'active' ? `
          <form id="move" class="stack">
            <h3>Fix a roster</h3>
            <div class="row">
              <label>Kicker
                <select name="kicker">${L.kickers.filter((k) => k.status !== 'non-kicker').sort((a, b) => a.name.localeCompare(b.name))
                  .map((k) => `<option value="${k.id}">${esc(k.name)}${L.rosterTeam.get(k.id) ? ` (${esc(L.teamById.get(L.rosterTeam.get(k.id)).name)})` : ''}</option>`).join('')}</select>
              </label>
              <label>Move to
                <select name="team"><option value="">Nobody (release)</option>${L.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
              </label>
            </div>
            <button type="submit">Move kicker</button>
          </form>` : '<p class="muted">Roster fixes open after the draft.</p>'}
        <h3>New season</h3>
        <p class="muted small">Keeps the league and its managers. Clears rosters, lineups, claims, the draft and activity. Use this to go from the trial season to the real one.</p>
        <div class="row">
          <select id="newseason"><option>${lg.season + 1}</option><option>${lg.season}</option></select>
          <button class="danger" id="reset">Start new season</button>
        </div>
      </div>
    </div>` : ''}`;

  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text); toast(`${label} copied`); } catch { toast(text); }
  };
  $('#copy-code').addEventListener('click', () => copy(lg.invite_code, 'Code'));
  $('#copy').addEventListener('click', () => copy(invite, 'Invite link'));
  $('#codeform')?.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.target.querySelector('[type=submit]'), async () => {
      const code = await rpc('set_invite_code', { p_league: L.id, p_code: e.target.code.value });
      toast(`Invite code is now ${code}`);
      reload();
    });
  });
  $('#newcode')?.addEventListener('click', async (e) => {
    if (!(await confirmBox('New random code?', 'The current code and link will stop working.', 'Make new code'))) return;
    busy(e.target, async () => {
      const code = await rpc('set_invite_code', { p_league: L.id, p_code: null });
      toast(`Invite code is now ${code}`);
      reload();
    });
  });
  $('#rename')?.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.target.querySelector('button'), async () => {
      await rpc('rename_team', { p_team: L.myTeam.id, p_name: e.target.name.value });
      toast('Team renamed');
      reload();
    });
  });
  if (!c) return;

  const ids = ordered.map((t) => t.id);
  const move = (btn, i, d) => busy(btn, async () => {
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    await rpc('set_draft_order', { p_league: L.id, p_order: ids });
    reload();
  });
  $$('[data-up]', root).forEach((b) => b.addEventListener('click', () => move(b, +b.dataset.up, -1)));
  $$('[data-down]', root).forEach((b) => b.addEventListener('click', () => move(b, +b.dataset.down, 1)));
  $$('[data-remove]', root).forEach((b) => b.addEventListener('click', async () => {
    const t = L.teamById.get(b.dataset.remove);
    const msg = setup ? `Remove ${esc(t.name)} from the league?` : `Remove ${esc(L.teamLabel(t))} as manager? You'll run ${esc(t.name)} as a placeholder and its roster stays.`;
    if (await confirmBox('Are you sure?', msg, setup ? 'Remove' : 'Take over', true)) {
      busy(b, async () => { await rpc('remove_team', { p_team: t.id }); reload(); });
    }
  }));
  $('#placeholder')?.addEventListener('click', (e) => busy(e.target, async () => {
    const names = new Set(L.teams.map((t) => t.name));
    let n = 2;
    while (names.has(`Team ${n}`)) n++;
    await rpc('add_placeholder_team', { p_league: L.id, p_name: `Team ${n}` });
    reload();
  }));
  $('#randomize')?.addEventListener('click', (e) => busy(e.target, async () => {
    await rpc('set_draft_order', { p_league: L.id, p_order: null });
    toast('Draft order randomized');
    reload();
  }));
  $('#start')?.addEventListener('click', async (e) => {
    if (!(await confirmBox('Start the draft?', 'The pick clock starts right away for the first team.', 'Start draft'))) return;
    busy(e.target, async () => {
      await rpc('start_draft', { p_league: L.id });
      location.hash = `#/league/${L.id}/draft`;
    });
  });
  $('#settings').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f.querySelector('[type=submit]'), async () => {
      await rpc('update_league_settings', {
        p_league: L.id, p_name: f.name.value, p_start_week: +f.start.value, p_clutch: f.clutch.checked,
        p_add_limit: +f.adds.value, p_pick_seconds: f.clock.value === '' ? null : +f.clock.value,
      });
      toast('Settings saved');
      reload();
    });
  });
  $('#move')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f.querySelector('button'), async () => {
      await rpc('commish_move', { p_league: L.id, p_kicker: f.kicker.value, p_to_team: f.team.value || null });
      toast('Roster updated');
      reload();
    });
  });
  $('#reset').addEventListener('click', async (e) => {
    const season = +$('#newseason').value;
    if (!(await confirmBox(`Start the ${season} season?`, 'This clears every roster, lineup, claim, draft pick and activity entry. Teams and managers stay. This can\'t be undone.', 'Start new season', true))) return;
    busy(e.target, async () => {
      await rpc('reset_league', { p_league: L.id, p_season: season });
      toast(`Ready for ${season}`);
      reload();
    });
  });
}
