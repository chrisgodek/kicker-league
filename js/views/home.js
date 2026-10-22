// Sign in, my leagues, create a league, join a league.
import { sb, rpc, rows } from '../supa.js';
import { $, esc, busy, toast } from '../ui.js';

const STATUS_LABEL = { setup: 'Setting up', drafting: 'Drafting now', active: 'In season', complete: 'Complete' };

export function renderSignIn(app) {
  const joining = sessionStorage.getItem('pendingJoin');
  app.innerHTML = `
    <section class="hero">
      <h1>Fantasy football, kickers only.</h1>
      <p>Roto scoring across field goals, 50-yarders, extra points, accuracy and distance. Two starters, one bench, 6 to 10 teams.</p>
    </section>
    <section class="card narrow">
      ${joining ? `<p class="callout">Sign in or create an account to join the league (invite code <b>${esc(joining)}</b>).</p>` : ''}
      <div class="tabs small" role="tablist">
        <button class="tab active" data-mode="in">Sign in</button>
        <button class="tab" data-mode="up">Create account</button>
      </div>
      <form id="auth" class="stack">
        <label class="only-up" hidden>Your name <input name="name" autocomplete="nickname" maxlength="40"></label>
        <label>Email <input name="email" type="email" autocomplete="email" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" minlength="6" required></label>
        <button class="primary" type="submit">Sign in</button>
      </form>
    </section>`;

  let mode = 'in';
  const form = $('#auth');
  app.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    app.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('active', x === b));
    form.querySelector('.only-up').hidden = mode !== 'up';
    form.password.autocomplete = mode === 'up' ? 'new-password' : 'current-password';
    form.querySelector('[type=submit]').textContent = mode === 'up' ? 'Create account' : 'Sign in';
  }));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    const password = form.password.value;
    busy(form.querySelector('[type=submit]'), async () => {
      if (mode === 'in') {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          toast('Check your email to confirm your account, then sign in.');
          return;
        }
        const name = form.name.value.trim();
        if (name) await rpc('set_display_name', { p_name: name });
      }
    });
  });
}

export async function renderHome(app, user) {
  const [leagues, myTeams, profile] = await Promise.all([
    rows(sb.from('leagues').select('*').order('created_at', { ascending: false })),
    rows(sb.from('teams').select('*').eq('owner', user.id)),
    rows(sb.from('profiles').select('*').eq('id', user.id)),
  ]);
  const teamFor = new Map(myTeams.map((t) => [t.league_id, t]));
  const thisSeason = new Date().getMonth() >= 2 ? new Date().getFullYear() : new Date().getFullYear() - 1;

  app.innerHTML = `
    <div class="page-head">
      <h1>My leagues</h1>
      <p class="muted">Signed in as <b>${esc(profile[0]?.display_name || user.email)}</b> · <button class="link" id="rename-me">change name</button></p>
    </div>
    ${leagues.length ? `<div class="league-list">${leagues.map((l) => `
      <a class="card league-card" href="#/league/${l.id}">
        <div><b>${esc(l.name)}</b><span class="pill ${l.status}">${STATUS_LABEL[l.status]}</span></div>
        <div class="muted">${l.size} teams · ${l.season} season${teamFor.get(l.id) ? ` · ${esc(teamFor.get(l.id).name)}` : ''}${l.commissioner === user.id ? ' · Commissioner' : ''}</div>
      </a>`).join('')}</div>`
      : '<p class="muted">You\'re not in any leagues yet. Create one or join with an invite code.</p>'}

    <div class="grid-2">
      <form class="card stack" id="create">
        <h2>Create a league</h2>
        <label>League name <input name="name" required maxlength="60" placeholder="Leg Day League"></label>
        <label>Your team name <input name="team" required maxlength="40" placeholder="Wide Right"></label>
        <div class="row">
          <label>Teams
            <select name="size"><option>6</option><option selected>8</option><option>10</option></select>
          </label>
          <label>Season
            <select name="season">
              <option value="${thisSeason}">${thisSeason}</option>
              <option value="${thisSeason + 1}">${thisSeason + 1}</option>
            </select>
          </label>
        </div>
        <button class="primary" type="submit">Create league</button>
      </form>
      <form class="card stack" id="join">
        <h2>Join a league</h2>
        <label>Invite code <input name="code" required maxlength="12" placeholder="ABC123" autocapitalize="characters"></label>
        <button type="submit">Look up league</button>
      </form>
    </div>`;

  $('#create').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f.querySelector('button'), async () => {
      const id = await rpc('create_league', {
        p_name: f.name.value, p_size: +f.size.value, p_season: +f.season.value, p_team_name: f.team.value,
      });
      location.hash = `#/league/${id}/settings`;
    });
  });
  $('#join').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/join/${encodeURIComponent(e.target.code.value.trim().toUpperCase())}`;
  });
  $('#rename-me').addEventListener('click', async () => {
    const name = prompt('Your name (shown to your leagues):', profile[0]?.display_name || '');
    if (name && name.trim()) {
      await busy(null, () => rpc('set_display_name', { p_name: name }));
      renderHome(app, user);
    }
  });
}

export async function renderJoin(app, user, code) {
  const [preview] = await rpc('league_preview', { p_code: code });
  if (!preview) {
    app.innerHTML = `<div class="card narrow"><h2>No league found</h2><p>There's no league with invite code <b>${esc(code)}</b>. Check the code and try again.</p><p><a href="#/">Back</a></p></div>`;
    return;
  }
  const mine = await rows(sb.from('teams').select('id').eq('league_id', preview.id).eq('owner', user.id));
  if (mine.length) {
    location.hash = `#/league/${preview.id}`;
    return;
  }
  app.innerHTML = `
    <form class="card narrow stack" id="joinform">
      <h2>Join ${esc(preview.name)}</h2>
      <p class="muted">${preview.size}-team league · ${preview.season} season · ${preview.open_spots} open spot${preview.open_spots === 1 ? '' : 's'}</p>
      ${preview.open_spots > 0 ? `
        <label>Your team name <input name="team" required maxlength="40"></label>
        <button class="primary" type="submit">Join league</button>`
      : '<p>This league is full.</p>'}
      <p><a href="#/">Cancel</a></p>
    </form>`;
  $('#joinform').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.target.querySelector('button'), async () => {
      await rpc('join_league', { p_code: code, p_team_name: e.target.team.value });
      location.hash = `#/league/${preview.id}`;
    });
  });
}
