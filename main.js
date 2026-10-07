// Proces główny: okna, sesja, zapytania do zbiornika, powiadomienia systemowe, badge w Docku.
const { app, BrowserWindow, session, ipcMain, Notification, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const LOGIN_URL = 'https://zbiornik.com/';
const DEBUG = !!process.env.ZB_DEBUG;

// Subdomena (np. karynka.zbiornik.com) przydzielana po zalogowaniu — zapamiętywana w ustawieniach.
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } }
function saveSettings(s) { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); }
let SITE = 'https://karynka.zbiornik.com/';
const PARTITION = 'persist:zbiornik';           // ciasteczka trzymane trwale przez Chromium
const REFRESH_MS = 60_000;
const NOTIF_PAGE = 21;
const NOTIF_MAX = 210;

const DEVICE_QS = '&actPath=%2F&deviceMobile=0&device=2560x1440%2F2560x1410%2F2560x642&app=';
const notifUrl = (offset, limit) => SITE + 'ajax/?command=getNotifications'
  + `&offset=${offset}&limit=${limit}` + DEVICE_QS;
const meUrl = () => SITE + 'ajax/?command=noop' + DEVICE_QS;
const visitorsBody = (offset, limit) => 'command=whoWatched&type=profile&nick='
  + `&offset=${offset}&limit=${limit}` + DEVICE_QS;

if (!app.requestSingleInstanceLock()) app.quit();

let ses, win, loginWin, quitting = false;
let notifLoaded = NOTIF_PAGE;
let visitorsLoaded = NOTIF_PAGE;
let csrf = null;                                 // nagłówek x-zb-csrf wymagany przy POST-ach; nie trafia do renderera
const known = { threads: new Set(), notifs: new Set(), primed: false };

const state = {
  needLogin: false,
  loggingIn: false,
  loginMessage: '',
  loginError: false,
  loading: false,
  me: null,                                      // { nick, avatar, isVerified, isVIP } z command=noop
  threads: [],
  notifs: [],
  notifOffset: 0,
  notifHasMore: false,
  visitors: [],                                  // kto oglądał mój profil (command=whoWatched)
  visitorsOffset: 0,
  visitorsHasMore: false,
  error: null,
  updatedAt: null,
  refreshSeconds: REFRESH_MS / 1000,
};

// ---------- pomocnicze ----------

// Tożsamość zwykłego Chrome na macOS, bez "Electron/..." i nazwy aplikacji w User-Agencie.
const CHROME_MAJOR = process.versions.chrome.split('.')[0];
const CHROME_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
const CHROME_CH_UA = `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not=A?Brand";v="24"`;
app.userAgentFallback = CHROME_UA;

class NeedLogin extends Error { constructor(msg) { super(msg); this.needLogin = true; } }
const abs = (u) => (u ? new URL(u, SITE).href : null);

function push() {
  if (win && !win.isDestroyed()) win.webContents.send('state', state);
  const unread = state.threads.filter(isUnreadThread).length + state.notifs.filter((g) => !g.seen).length;
  app.dock?.setBadge(unread ? String(unread) : '');
}

// `form` (string x-www-form-urlencoded) zamienia zapytanie na POST.
async function zbFetch(url, base = SITE, form = null) {
  const cookies = await ses.cookies.get({ url: base });
  if (!cookies.some((c) => c.name === 'token')) throw new NeedLogin('Nie jesteś zalogowany.');

  let res;
  try {
    res = await ses.fetch(url, {
      method: form ? 'POST' : 'GET',
      body: form ?? undefined,
      headers: {
        'accept-language': 'pl,pl-PL;q=0.9,en-US;q=0.8,en;q=0.7',
        'cookie': cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        // POST-y wyglądają jak fetch ze strony głównej zbiornika (tak robi przeglądarka).
        ...(form ? {
          'accept': '*/*',
          'content-type': 'application/x-www-form-urlencoded',
          'origin': 'https://zbiornik.com',
          'referer': 'https://zbiornik.com/',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-site',
          ...(csrf && { 'x-zb-csrf': csrf }),
        } : {
          'accept': 'application/json, text/plain, */*',
          'x-requested-with': 'XMLHttpRequest',
          'referer': base,
        }),
      },
    });
  } catch (e) {
    throw new Error(`Brak połączenia z zbiornik.com (${e.message}).`);
  }
  const body = await res.text();
  const snippet = body.slice(0, 300).replace(/\s+/g, ' ');
  if (DEBUG) console.log(`[zbFetch] ${res.status} ${url}\n  ${snippet}`);
  if (res.status === 401 || (res.status === 403 && !/cloudflare|just a moment/i.test(body))) {
    throw new NeedLogin('Sesja wygasła. Zaloguj się ponownie.');
  }
  if (!res.ok) throw new Error(`Serwer odpowiedział HTTP ${res.status}. ${snippet}`);
  let data;
  try { data = JSON.parse(body); }
  catch { throw new NeedLogin('Sesja wygasła. Zaloguj się ponownie.'); }
  return isApiNote(data) ? JSON.parse(openApiNote(data.t, data.n, data.r)) : data;
}

// Część odpowiedzi przychodzi zamaskowana jako {r:1, n, t} — odpowiednik isApiNote/openApiNote z zbiornik.js:
// base64url → XOR z ciągiem xorshift32, którego ziarno to hash FNV z `n` i `r` → UTF-8 JSON.
function isApiNote(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  if (d.r !== 1 && d.r !== '1') return false;
  if (typeof d.n !== 'string' || typeof d.t !== 'string' || !d.n || !d.t) return false;
  if (d.ok !== undefined || d.error !== undefined) return false;
  return Object.keys(d).length <= 3;
}

function openApiNote(t, n, r) {
  let seed = 2166136261 ^ parseInt(r, 10);
  for (let i = 0; i < n.length; i++) {
    seed ^= n.charCodeAt(i) + i;
    seed += (seed << 1) + (seed << 4) + (seed << 7) + (seed << 8) + (seed << 24);
    seed >>>= 0;
  }
  let x = seed || 2654435769;
  const bytes = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  for (let i = 0; i < bytes.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    bytes[i] ^= x & 255;
  }
  return bytes.toString('utf8');
}

// ---------- wiadomości ----------

const isUnreadThread = (t) => !t.self && (t.unread > 0 || !t.seen);

function parseThread(t) {
  const u = t.user ?? {};
  return {
    nick: t.nick ?? u.nick ?? '?',
    time: t.time,
    self: !!t.self,
    text: t.text ?? '',
    seen: !!t.seen,
    unread: Number(t.unread) || 0,
    attachment: t.attach ? (t.attachType || 'plik') : null,
    isOnline: !!(t.isOnline ?? u.isOnline),
    isVerified: !!(t.isVerified ?? u.isVerified),
    status: t.status ?? u.status ?? '',
    avatar: abs(t.avatar?.c40 ?? u.avatar?.c40),
  };
}

async function getThreads(base = SITE) {
  const data = await zbFetch(base + 'ajax/?command=getThreads', base);
  if (!Array.isArray(data.threads)) throw new NeedLogin('Serwer nie zwrócił wątków — prawdopodobnie sesja wygasła.');
  return data.threads.map(parseThread).sort((a, b) => b.time - a.time);
}

// ---------- zalogowany użytkownik ----------

// Szuka tokenu CSRF w odpowiedzi (klucz zawierający "csrf", na dowolnym poziomie).
function findCsrf(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(o)) {
    if (/csrf/i.test(k) && typeof v === 'string' && v) return v;
  }
  for (const v of Object.values(o)) {
    const f = findCsrf(v, depth + 1);
    if (f) return f;
  }
  return null;
}

async function getMe() {
  const data = await zbFetch(meUrl());
  const found = data.session?.csrfToken || findCsrf(data);
  if (found) csrf = found;
  else if (DEBUG) console.log('[csrf] brak w command=noop, klucze session:', Object.keys(data.session ?? data));
  const u = data.session?.user;
  if (!u?.nick) throw new Error('Brak danych użytkownika w odpowiedzi.');
  return { nick: u.nick, avatar: abs(u.avatar?.c40), isVerified: !!u.isVerified, isVIP: !!u.isVIP };
}

// ---------- powiadomienia ----------

const EXTRA_KEYS = ['event', 'comment', 'post', 'forumThread', 'motion', 'pollVotes'];
const seenTypes = new Set();

function parseNotification(n) {
  if (!seenTypes.has(n.type)) {
    seenTypes.add(n.type);
    const extras = EXTRA_KEYS.filter((k) => n[k] != null);
    console.log(`[powiadomienia] typ ${n.type}: item=${!!n.item}, extra=[${extras.join(', ')}], text=${JSON.stringify(n.text)}`);
  }
  const it = n.item;
  return {
    type: n.type,
    date: n.date,
    groupTime: n.groupTime ?? n.date,
    seen: !!n.seen,
    users: (n.userList ?? []).map((u) => ({
      nick: u.nick, avatar: abs(u.avatar?.c40), isOnline: !!u.isOnline, isVerified: !!u.isVerified,
    })),
    item: it ? {
      title: it.title || '',
      thumb: abs(it.src240 || it.src180 || it.src120),
      full: abs(it.src1280 || it.src960 || it.origSrc || it.src640),
      isVideo: it.duration != null,
      likes: it.likes, favs: it.favs, views: it.views, comments: it.cntComments,
    } : null,
    text: n.text ?? n.comment?.text ?? n.post?.text ?? null,
    extra: EXTRA_KEYS.find((k) => n[k] != null) ?? null,
    reason: n.reason ?? null,
  };
}

function groupNotifications(list) {
  const groups = new Map();
  for (const n of list) {
    const key = [n.type, n.groupTime, n.users.map((u) => u.nick).join(',')].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { key, type: n.type, date: n.date, seen: true, users: n.users, items: [], texts: [], extra: n.extra, reason: n.reason };
      groups.set(key, g);
    }
    g.date = Math.max(g.date, n.date);
    g.seen = g.seen && n.seen;
    if (n.item) g.items.push(n.item);
    if (n.text) g.texts.push(n.text);
  }
  return [...groups.values()].sort((a, b) => b.date - a.date);
}

async function getNotifications(offset, limit) {
  const data = await zbFetch(notifUrl(offset, limit));
  if (!Array.isArray(data.list)) throw new NeedLogin('Serwer nie zwrócił powiadomień — prawdopodobnie sesja wygasła.');
  return {
    groups: groupNotifications(data.list.map(parseNotification)),
    nextOffset: offset + data.list.length,
    hasMore: data.list.length >= limit,
  };
}

// ---------- kto mnie oglądał ----------

let visitorShapeLogged = false;

function parseVisitor(v) {
  if (!visitorShapeLogged) {
    visitorShapeLogged = true;
    console.log('[oglądający] przykładowy wpis:', JSON.stringify(v).slice(0, 600));
  }
  const u = v.user ?? v;
  return {
    nick: u.nick ?? v.nick ?? '?',
    time: Number(v.time ?? v.date ?? v.lastVisit ?? v.watchTime) || 0,
    count: Number(v.count ?? v.cnt ?? v.visits) || 0,
    isNew: v.seen === false || v.isNew === true || v.new === true,
    isOnline: !!(u.isOnline ?? v.isOnline),
    isVerified: !!(u.isVerified ?? v.isVerified),
    status: u.status ?? v.status ?? '',
    avatar: abs(u.avatar?.c40 ?? v.avatar?.c40),
  };
}

// Pierwsza tablica obiektów w odpowiedzi — najpierw znane klucze, potem dowolne (do 2 poziomów w głąb).
function findList(o, depth = 0) {
  if (Array.isArray(o)) return o.length === 0 || typeof o[0] === 'object' ? o : null;
  if (!o || typeof o !== 'object' || depth > 2) return null;
  for (const k of ['list', 'users', 'watched', 'whoWatched', 'items', 'data']) {
    const f = Array.isArray(o[k]) ? o[k] : null;
    if (f) return f;
  }
  for (const v of Object.values(o)) {
    const f = findList(v, depth + 1);
    if (f) return f;
  }
  return null;
}

async function getVisitors(offset, limit) {
  if (!csrf) await getMe().catch(() => {});
  if (!csrf) throw new Error('Nie znalazłem tokenu CSRF (x-zb-csrf) w odpowiedzi serwera.');
  let data;
  try {
    data = await zbFetch(SITE + 'ajax/', SITE, visitorsBody(offset, limit));
  } catch (e) {
    csrf = null;                                 // może wygasł — przy następnej próbie pobierz od nowa
    throw e;
  }
  const raw = findList(data);
  if (!raw) {
    const shape = JSON.stringify(data).slice(0, 300);
    console.warn('[oglądający] nieznany format odpowiedzi:', shape);
    throw new Error('Nieznany format odpowiedzi: ' + shape);
  }
  return {
    list: raw.filter((x) => x?.user?.isExists !== false).map(parseVisitor),
    nextOffset: offset + raw.length,
    hasMore: raw.length >= limit,
  };
}

// ---------- odświeżanie ----------

async function refresh() {
  if (state.loading || !ses) return;
  state.loading = true;
  push();
  try {
    const [t, n, me, v] = await Promise.allSettled([
      getThreads(), getNotifications(0, Math.min(notifLoaded, NOTIF_MAX)), getMe(),
      getVisitors(0, Math.min(visitorsLoaded, NOTIF_MAX)),
    ]);
    const nl = [t, n].find((r) => r.status === 'rejected' && r.reason.needLogin);
    if (nl) {
      Object.assign(state, { needLogin: true, me: null, threads: [], notifs: [], visitors: [], error: null, loginMessage: state.loggingIn ? state.loginMessage : nl.reason.message });
      known.primed = false;
      return;
    }
    state.needLogin = false;
    // Brak danych profilu nie jest błędem wartym komunikatu — nagłówek po prostu zostaje bez nicka.
    if (me.status === 'fulfilled') state.me = me.value;
    else console.warn('[noop]', me.reason.message);
    const errs = [];
    if (t.status === 'fulfilled') state.threads = t.value; else errs.push('Wiadomości: ' + t.reason.message);
    if (n.status === 'fulfilled') {
      state.notifs = n.value.groups;
      state.notifOffset = n.value.nextOffset;
      state.notifHasMore = n.value.hasMore;
    } else errs.push('Powiadomienia: ' + n.reason.message);
    if (v.status === 'fulfilled') {
      state.visitors = v.value.list;
      state.visitorsOffset = v.value.nextOffset;
      state.visitorsHasMore = v.value.hasMore;
    } else errs.push('Kto mnie oglądał: ' + v.reason.message);
    state.error = errs.join(' ') || null;
    state.updatedAt = Date.now();
    notifyNew();
  } finally {
    state.loading = false;
    push();
  }
}

async function loadMore(which) {
  if (which === 'visitors') return loadMoreVisitors();
  try {
    const n = await getNotifications(state.notifOffset, NOTIF_PAGE);
    const have = new Set(state.notifs.map((g) => g.key));
    state.notifs = state.notifs.concat(n.groups.filter((g) => !have.has(g.key)));
    state.notifOffset = n.nextOffset;
    state.notifHasMore = n.hasMore;
    notifLoaded = n.nextOffset;
  } catch (e) {
    if (e.needLogin) state.needLogin = true;
    else state.error = 'Powiadomienia: ' + e.message;
  }
  push();
}

async function loadMoreVisitors() {
  try {
    const v = await getVisitors(state.visitorsOffset, NOTIF_PAGE);
    const have = new Set(state.visitors.map((x) => `${x.nick}|${x.time}`));
    state.visitors = state.visitors.concat(v.list.filter((x) => !have.has(`${x.nick}|${x.time}`)));
    state.visitorsOffset = v.nextOffset;
    state.visitorsHasMore = v.hasMore;
    visitorsLoaded = v.nextOffset;
  } catch (e) {
    state.error = 'Kto mnie oglądał: ' + e.message;   // np. 403 przez zły CSRF — to nie powód do wylogowania
  }
  push();
}

// Systemowe powiadomienia o rzeczach, których nie było przy poprzednim odświeżeniu.
function notifyNew() {
  const tNew = state.threads.filter(isUnreadThread).map((t) => ({ key: `${t.nick}|${t.time}`, t }));
  const nNew = state.notifs.filter((g) => !g.seen).map((g) => ({ key: g.key, g }));

  if (known.primed && Notification.isSupported()) {
    const fresh = [
      ...tNew.filter((x) => !known.threads.has(x.key)).map(({ t }) => ({
        tab: 'msgs', title: t.nick, body: t.text || (t.attachment ? 'Załącznik' : 'Nowa wiadomość'),
      })),
      ...nNew.filter((x) => !known.notifs.has(x.key)).map(({ g }) => ({
        tab: 'notifs',
        title: g.users.map((u) => u.nick).slice(0, 3).join(', ') || 'Zbiornik',
        body: g.texts[0] || (g.items.length ? `Nowe powiadomienie (${g.items.length})` : 'Nowe powiadomienie'),
      })),
    ];
    const shown = fresh.length > 3
      ? [{ tab: fresh[0].tab, title: 'Zbiornik', body: `${fresh.length} nowych wiadomości i powiadomień` }]
      : fresh;
    for (const f of shown) {
      const note = new Notification({ title: f.title, body: f.body.slice(0, 200), silent: false });
      note.on('click', () => { showWindow(); win.webContents.send('goto', f.tab); });
      note.show();
    }
  }
  known.threads = new Set(tNew.map((x) => x.key));
  known.notifs = new Set(nNew.map((x) => x.key));
  known.primed = true;
}

// ---------- logowanie ----------

function openLogin() {
  if (loginWin && !loginWin.isDestroyed()) return loginWin.focus();

  Object.assign(state, { loggingIn: true, loginError: false, loginMessage: 'Zaloguj się w oknie, które się otworzyło.' });
  push();

  loginWin = new BrowserWindow({
    width: 520, height: 760, title: 'Logowanie — zbiornik.com',
    webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
  });
  if (DEBUG) loginWin.webContents.openDevTools({ mode: 'detach' });
  loginWin.loadURL(LOGIN_URL);

  let checking = false, done = false;
  let candidate = SITE;
  const isUserHost = (h) => h.endsWith('.zbiornik.com') && !['www.zbiornik.com', 'p.zbiornik.com'].includes(h);
  const tryFinish = async () => {
    if (checking || done || !loginWin || loginWin.isDestroyed()) return;
    try {
      const u = new URL(loginWin.webContents.getURL());
      if (isUserHost(u.hostname)) candidate = u.origin + '/';
    } catch {}
    checking = true;
    try {
      await getThreads(candidate);              // token istnieje i naprawdę działa
      SITE = candidate;
      saveSettings({ ...loadSettings(), site: SITE });
      console.log('[login] OK, subdomena:', SITE);
      done = true;
      Object.assign(state, { loggingIn: false, needLogin: false, loginMessage: '' });
      loginWin?.close();
      refresh();
    } catch (e) {
      if (!e.needLogin) {
        Object.assign(state, { loginError: true, loginMessage: e.message });
        push();
      }
    } finally {
      checking = false;
    }
  };
  const onCookie = (_e, cookie, _cause, removed) => {
    if (DEBUG) console.log(`[cookie] ${removed ? '-' : '+'} ${cookie.name} @ ${cookie.domain}`);
    if (!removed && cookie.name === 'token') tryFinish();
  };
  ses.cookies.on('changed', onCookie);
  loginWin.webContents.on('did-navigate', (_e, url, code) => {
    if (DEBUG) console.log(`[login] nawigacja ${code} ${url}`);
    tryFinish();
  });
  loginWin.webContents.on('did-navigate-in-page', tryFinish);

  loginWin.on('closed', () => {
    ses.cookies.removeListener('changed', onCookie);
    loginWin = null;
    if (!done) {
      Object.assign(state, { loggingIn: false, loginError: false, loginMessage: 'Okno logowania zostało zamknięte.' });
      push();
    }
  });
}

async function logout() {
  await ses.clearStorageData();
  csrf = null;
  known.threads.clear(); known.notifs.clear(); known.primed = false;
  notifLoaded = NOTIF_PAGE;
  visitorsLoaded = NOTIF_PAGE;
  Object.assign(state, {
    needLogin: true, me: null, threads: [], notifs: [], visitors: [], error: null, updatedAt: null,
    loginMessage: 'Wylogowano. Dane sesji zostały usunięte z aplikacji.', loginError: false,
  });
  push();
}

// ---------- okno główne ----------

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 780, height: 900, minWidth: 420, minHeight: 500,
    title: 'Zbiornik Inbox',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#171a24',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: PARTITION,                     // ta sama sesja → miniatury ładują się z ciasteczkami
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', push);

  // Linki (np. pełne zdjęcia) otwieraj w domyślnej przeglądarce, nie w aplikacji.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Zamknięcie okna chowa je — aplikacja dalej sprawdza nowości w tle.
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

function buildMenu() {
  const goto = (tab) => { showWindow(); win.webContents.send('goto', tab); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about', label: 'O aplikacji' },
        { type: 'separator' },
        {
          label: 'Uruchamiaj przy logowaniu', type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        },
        { label: 'Wyloguj z zbiornika', click: logout },
        { type: 'separator' },
        { role: 'hide', label: 'Ukryj' },
        { role: 'hideOthers', label: 'Ukryj pozostałe' },
        { role: 'unhide', label: 'Pokaż wszystkie' },
        { type: 'separator' },
        { role: 'quit', label: 'Zakończ' },
      ],
    },
    { role: 'editMenu', label: 'Edycja' },
    {
      label: 'Widok',
      submenu: [
        { label: 'Odśwież', accelerator: 'CmdOrCtrl+R', click: () => refresh() },
        { label: 'Wiadomości', accelerator: 'CmdOrCtrl+1', click: () => goto('msgs') },
        { label: 'Powiadomienia', accelerator: 'CmdOrCtrl+2', click: () => goto('notifs') },
        { label: 'Kto mnie oglądał', accelerator: 'CmdOrCtrl+3', click: () => goto('visitors') },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Narzędzia deweloperskie' },
      ],
    },
    { role: 'windowMenu', label: 'Okno' },
  ]));
}

// ---------- start ----------

ipcMain.handle('get-state', () => state);
ipcMain.handle('refresh', () => refresh());
ipcMain.handle('load-more', (_e, which) => loadMore(which));
ipcMain.handle('login', () => openLogin());
ipcMain.handle('logout', () => logout());

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; });

app.whenReady().then(async () => {
  SITE = loadSettings().site || SITE;
  ses = session.fromPartition(PARTITION);
  ses.setUserAgent(CHROME_UA, 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7');

  // Client Hints jak w Chrome — dotyczy okna logowania, miniatur i zapytań AJAX.
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*.zbiornik.com/*', '*://zbiornik.com/*'] }, (details, cb) => {
    const h = details.requestHeaders;
    h['User-Agent'] = CHROME_UA;
    h['sec-ch-ua'] = CHROME_CH_UA;
    h['sec-ch-ua-mobile'] = '?0';
    h['sec-ch-ua-platform'] = '"macOS"';
    cb({ requestHeaders: h });
  });

  // Diagnostyka: odpowiedzi 4xx/5xx w terminalu (z ZB_DEBUG=1 także nagłówki i netlog partycji).
  const mask = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) =>
    [k, /cookie/i.test(k) ? String(v).replace(/=([^;\s]{4})[^;\s]*/g, '=$1…') : v]));
  if (DEBUG) {
    ses.webRequest.onSendHeaders({ urls: ['*://*.zbiornik.com/*', '*://zbiornik.com/*'] }, (d) => {
      if (d.resourceType === 'mainFrame' || d.url.includes('/ajax/'))
        console.log(`[wysłane] ${d.method} ${d.url}\n`, mask(d.requestHeaders));
    });
  }
  ses.webRequest.onCompleted({ urls: ['*://*.zbiornik.com/*', '*://zbiornik.com/*'] }, (d) => {
    if (d.statusCode >= 400) {
      console.warn(`[http] ${d.statusCode} ${d.method} ${d.url}`);
      if (DEBUG) console.warn('  odpowiedź:', mask(d.responseHeaders || {}));
    }
  });
  if (DEBUG) {
    const logPath = path.join(app.getPath('temp'), 'zb-netlog.json');
    await ses.netLog.startLogging(logPath, { captureMode: 'includeSensitive' });
    console.log('[debug] netlog partycji zbiornika:', logPath);
    app.on('will-quit', () => { ses.netLog.stopLogging(); });
  }

  buildMenu();
  createWindow();
  refresh();
  setInterval(refresh, REFRESH_MS);
});
