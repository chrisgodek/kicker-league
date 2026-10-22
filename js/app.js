// Hash router: #/  ·  #/join/CODE  ·  #/league/<id>/<tab>
import { sb, currentUser } from './supa.js';
import { $, esc } from './ui.js';
import { renderHome, renderSignIn, renderJoin } from './views/home.js';
import { renderLeague } from './views/league.js';

const app = $('#app');

async function route() {
  const user = await currentUser();
  renderNav(user);
  const [, page, a, b] = location.hash.replace(/^#/, '').split('/');
  try {
    if (!user) {
      if (page === 'join' && a) sessionStorage.setItem('pendingJoin', a);
      return renderSignIn(app);
    }
    const pending = sessionStorage.getItem('pendingJoin');
    if (pending) {
      sessionStorage.removeItem('pendingJoin');
      location.hash = `#/join/${pending}`;
      return;
    }
    if (page === 'join' && a) return await renderJoin(app, user, a);
    if (page === 'league' && a) return await renderLeague(app, user, a, b || 'team');
    return await renderHome(app, user);
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${esc(err.message)}</p><p><a href="#/">Back to my leagues</a></p></div>`;
  }
}

function renderNav(user) {
  $('#nav').innerHTML = user
    ? `<a href="stats.html">Kicker stats</a><span class="muted who">${esc(user.email)}</span><button id="signout" class="link">Sign out</button>`
    : `<a href="stats.html">Kicker stats</a>`;
  $('#signout')?.addEventListener('click', () => sb.auth.signOut());
}

window.addEventListener('hashchange', route);
sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') route();
});
route();
