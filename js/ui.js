// Small DOM helpers shared by every view.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const kickoffFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const fmtKickoff = (iso) => kickoffFmt.format(new Date(iso));
export const fmtDate = (iso) => dateFmt.format(new Date(iso));

// League badges for rare kicker moments.
export const BADGE = {
  onside: { icon: '🎯', label: 'Onside recovery' },
  fake_run: { icon: '🎩', label: 'Fake FG run' },
  fake_pass: { icon: '🎩', label: 'Fake FG pass' },
};
export const badgeIcon = (b) => (BADGE[b.kind] || { icon: '🏅' }).icon;

export function toast(message, kind = 'ok') {
  let box = $('#toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    box.setAttribute('role', 'status');
    document.body.append(box);
  }
  box.textContent = message;
  box.className = `show ${kind}`;
  clearTimeout(box._t);
  box._t = setTimeout(() => { box.className = ''; }, kind === 'error' ? 6000 : 3000);
}

// Run an async action from a button: disables it while running and shows errors as a toast.
export async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err.message.replace(/^.*?ERROR:\s*/, ''), 'error');
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

// Modal built on <dialog>. Resolves with the clicked button's value (or null if dismissed).
export function choose({ title, body, buttons }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog">
      <h3>${esc(title)}</h3>
      <div class="dialog-body">${body}</div>
      <div class="dialog-actions">
        ${buttons.map((b) => `<button value="${esc(b.value)}" class="${b.primary ? 'primary' : ''}${b.danger ? ' danger' : ''}">${esc(b.label)}</button>`).join('')}
      </div>
    </form>`;
    document.body.append(d);
    d.addEventListener('close', () => {
      const form = d.querySelector('form');
      const picked = d.returnValue && d.returnValue !== 'cancel' ? d.returnValue : null;
      resolve(picked === null ? null : { value: picked, form: Object.fromEntries(new FormData(form)) });
      d.remove();
    });
    d.showModal();
  });
}

export const confirmBox = async (title, body, label = 'OK', danger = false) =>
  !!(await choose({ title, body: `<p>${body}</p>`, buttons: [{ label: 'Cancel', value: 'cancel' }, { label, value: 'yes', primary: !danger, danger }] }));
