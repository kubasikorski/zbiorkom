// Nazwy typów powiadomień. Nowe typy wypisują się w terminalu przy `npm start` — dopisz je tutaj.
const TYPE_LABELS = {
  // 1: 'polubienie zdjęcia',
};

let S = null;
let tab = 'msgs', msgFilter = 'all', notifFilter = 'all';
const $ = (id) => document.getElementById(id);

const rtf = new Intl.RelativeTimeFormat('pl', { numeric: 'auto' });
function ago(unix) {
  const s = Math.round(unix - Date.now() / 1000), a = Math.abs(s);
  if (a < 60) return 'przed chwilą';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 7 * 86400) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(unix * 1000).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function avatar(nick, src, online) {
  const av = el('div', 'av');
  const initial = () => el('span', null, ((nick && nick[0]) || '?').toUpperCase());
  if (src) {
    const img = el('img');
    img.src = src; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
    img.onerror = () => img.replaceWith(initial());
    av.append(img);
  } else av.append(initial());
  if (online) { const d = el('i'); d.title = 'Online'; av.append(d); }
  return av;
}
function timeEl(unix) {
  const t = el('time', null, ago(unix));
  t.dateTime = new Date(unix * 1000).toISOString();
  t.title = new Date(unix * 1000).toLocaleString('pl-PL');
  return t;
}
function plural(n, one, few, many) {
  if (n === 1) return one;
  const d = n % 10, dd = n % 100;
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
}
const isUnreadThread = (t) => !t.self && (t.unread > 0 || !t.seen);

// ---------- widoki ----------

function renderLogin() {
  $('app').hidden = true;
  $('loginBox').hidden = false;
  $('updated').textContent = '';
  $('nMsgs').textContent = ''; $('nNotifs').textContent = '';
  $('loginBtn').disabled = S.loggingIn;
  $('loginBtn').textContent = S.loggingIn ? 'Czekam na zalogowanie…' : 'Zaloguj się';
  $('loginState').textContent = S.loginMessage || '';
  $('loginState').className = 'state' + (S.loginError ? ' err' : '');
}

function renderThreads(out, q) {
  const list = S.threads.filter((t) => {
    if (msgFilter === 'unread' && !isUnreadThread(t)) return false;
    if (msgFilter === 'reply' && t.self) return false;
    if (q && !(t.nick.toLowerCase().includes(q) || t.text.toLowerCase().includes(q))) return false;
    return true;
  });
  if (!list.length) {
    out.append(el('p', 'msg', S.updatedAt == null ? 'Ładowanie…' : q || msgFilter !== 'all' ? 'Nic nie pasuje do filtra.' : 'Brak rozmów.'));
    return;
  }
  const ul = el('ul');
  for (const t of list) {
    const li = el('li', isUnreadThread(t) ? 'unread' : '');
    const body = el('div'); body.style.minWidth = '0';
    const who = el('div', 'who');
    who.append(el('span', 'nick', t.nick));
    if (t.isVerified) { const v = el('span', 'tick', '✓'); v.title = 'Zweryfikowany'; who.append(v); }
    if (t.status) who.append(el('span', 'status', t.status));
    const prev = el('div', 'preview');
    if (t.self) prev.append(el('span', 'you', 'Ty: '));
    if (t.text) prev.append(t.text);
    else if (t.attachment) prev.append(el('span', 'att', 'Załącznik (' + t.attachment + ')'));
    body.append(who, prev);

    const meta = el('div', 'meta');
    meta.append(timeEl(t.time));
    if (!t.self && t.unread > 0) meta.append(el('div', 'badge', t.unread));
    else if (!t.self && !t.seen) meta.append(el('div', 'badge', '•'));
    if (t.self) meta.append(el('span', 'seen', t.seen ? 'Wyświetlone' : 'Wysłane'));

    li.append(avatar(t.nick, t.avatar, t.isOnline), body, meta);
    ul.append(li);
  }
  out.append(ul);
}

function describe(g) {
  if (g.texts.length) return g.texts[0];
  if (g.items.length === 1) return g.items[0].title || (g.items[0].isVideo ? 'Film' : 'Zdjęcie');
  if (g.items.length > 1) {
    const n = g.items.length, vids = g.items.filter((i) => i.isVideo).length;
    return vids === n ? n + ' ' + plural(n, 'film', 'filmy', 'filmów')
      : vids === 0 ? n + ' ' + plural(n, 'zdjęcie', 'zdjęcia', 'zdjęć')
      : n + ' ' + plural(n, 'materiał', 'materiały', 'materiałów');
  }
  return g.extra || (g.reason ? String(g.reason) : '');
}

function renderNotifs(out, q) {
  const list = S.notifs.filter((g) => {
    if (notifFilter === 'unseen' && g.seen) return false;
    if (!q) return true;
    const hay = [g.users.map((u) => u.nick).join(' '), g.texts.join(' '), g.items.map((i) => i.title).join(' ')].join(' ').toLowerCase();
    return hay.includes(q);
  });
  if (!list.length) {
    out.append(el('p', 'msg', S.updatedAt == null ? 'Ładowanie…' : q || notifFilter !== 'all' ? 'Nic nie pasuje do filtra.' : 'Brak powiadomień.'));
  }
  const ul = el('ul');
  for (const g of list) {
    const li = el('li', g.seen ? '' : 'unread');
    const first = g.users[0] || {};
    const body = el('div'); body.style.minWidth = '0';

    const who = el('div', 'who');
    who.append(el('span', 'nick', g.users.slice(0, 3).map((u) => u.nick).join(', ') || 'Zbiornik'));
    if (g.users.length > 3) who.append(el('span', 'status', 'i ' + (g.users.length - 3) + ' innych'));
    who.append(el('span', 'kind', TYPE_LABELS[g.type] || 'typ ' + g.type));
    body.append(who);

    const d = describe(g);
    if (d) body.append(el('div', 'preview', d));

    if (g.items.length) {
      const thumbs = el('div', 'thumbs'), max = 8;
      for (const it of g.items.slice(0, max)) {
        const a = el('a');
        a.href = it.full || it.thumb; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.title = [it.title, it.likes != null ? it.likes + ' polubień' : '', it.favs != null ? it.favs + ' w ulubionych' : ''].filter(Boolean).join('\n');
        const img = el('img');
        img.src = it.thumb; img.alt = it.title || ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
        a.append(img);
        if (it.isVideo) a.append(el('span', 'play', '▶'));
        thumbs.append(a);
      }
      if (g.items.length > max) thumbs.append(el('span', 'more', '+' + (g.items.length - max)));
      body.append(thumbs);
    }

    const meta = el('div', 'meta');
    meta.append(timeEl(g.date));
    if (!g.seen) meta.append(el('div', 'badge', '•'));

    li.append(avatar(first.nick, first.avatar, first.isOnline), body, meta);
    ul.append(li);
  }
  out.append(ul);

  if (S.notifHasMore && !q && notifFilter === 'all') {
    const more = el('button', 'btn loadmore', 'Pokaż starsze');
    more.addEventListener('click', async () => { more.disabled = true; await window.zb.loadMore(); });
    out.append(more);
  }
}

function render() {
  if (!S) return;
  if (S.needLogin) return renderLogin();
  $('loginBox').hidden = true;
  $('app').hidden = false;

  const m = S.threads.filter(isUnreadThread).length;
  const n = S.notifs.filter((g) => !g.seen).length;
  $('nMsgs').textContent = m || '';
  $('nNotifs').textContent = n || '';
  $('msgFilter').hidden = tab !== 'msgs';
  $('notifFilter').hidden = tab !== 'notifs';
  $('refresh').disabled = S.loading;
  tick();

  const out = $('out');
  out.innerHTML = '';
  if (S.error) out.append(el('p', 'msg err', S.error));
  const q = $('q').value.trim().toLowerCase();
  if (tab === 'msgs') renderThreads(out, q); else renderNotifs(out, q);
}

function tick() {
  if (!S || S.needLogin || !S.updatedAt) { $('updated').textContent = S && S.loading ? 'Odświeżanie…' : ''; return; }
  const s = Math.round((Date.now() - S.updatedAt) / 1000);
  $('updated').textContent = S.loading ? 'Odświeżanie…'
    : 'Zaktualizowano ' + (s < 5 ? 'teraz' : s < 60 ? s + ' s temu' : Math.round(s / 60) + ' min temu');
}

function setTab(t) {
  tab = t;
  document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', x.dataset.tab === t));
  render();
}

// ---------- zdarzenia ----------

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
function bindSeg(id, set) {
  const btns = document.querySelectorAll('#' + id + ' button');
  btns.forEach((b) => b.addEventListener('click', () => {
    set(b.dataset.f);
    btns.forEach((x) => x.setAttribute('aria-pressed', x === b));
    render();
  }));
}
bindSeg('msgFilter', (f) => { msgFilter = f; });
bindSeg('notifFilter', (f) => { notifFilter = f; });
$('q').addEventListener('input', render);
$('refresh').addEventListener('click', () => window.zb.refresh());
$('loginBtn').addEventListener('click', () => window.zb.login());

window.zb.onState((s) => { S = s; render(); });
window.zb.onGoto(setTab);
window.zb.getState().then((s) => { S = s; render(); });
setInterval(tick, 5000);
