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

const notifUrl = (offset, limit) => SITE + 'ajax/?command=getNotifications'
  + `&offset=${offset}&limit=${limit}&actPath=%2F&deviceMobile=0`
  + '&device=2560x1440%2F2560x1410%2F2560x642&app=';

if (!app.requestSingleInstanceLock()) app.quit();

let ses, win, loginWin, quitting = false;
let notifLoaded = NOTIF_PAGE;
const known = { threads: new Set(), notifs: new Set(), primed: false };

const state = {
  needLogin: false,
  loggingIn: false,
  loginMessage: '',
  loginError: false,
  loading: false,
  threads: [],
  notifs: [],
  notifOffset: 0,
  notifHasMore: false,
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

async function zbFetch(url, base = SITE) {
  const cookies = await ses.cookies.get({ url: base });
  if (!cookies.some((c) => c.name === 'token')) throw new NeedLogin('Nie jesteś zalogowany.');

  let res;
  try {
    res = await ses.fetch(url, {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'pl,pl-PL;q=0.9,en-US;q=0.8,en;q=0.7',
        'cookie': cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        'x-requested-with': 'XMLHttpRequest',
        'referer': base,
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
  try { return JSON.parse(body); }
  catch { throw new NeedLogin('Sesja wygasła. Zaloguj się ponownie.'); }
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

// ---------- odświeżanie ----------

async function refresh() {
  if (state.loading || !ses) return;
  state.loading = true;
  push();
  try {
    const [t, n] = await Promise.allSettled([getThreads(), getNotifications(0, Math.min(notifLoaded, NOTIF_MAX))]);
    const nl = [t, n].find((r) => r.status === 'rejected' && r.reason.needLogin);
    if (nl) {
      Object.assign(state, { needLogin: true, threads: [], notifs: [], error: null, loginMessage: state.loggingIn ? state.loginMessage : nl.reason.message });
      known.primed = false;
      return;
    }
    state.needLogin = false;
    const errs = [];
    if (t.status === 'fulfilled') state.threads = t.value; else errs.push('Wiadomości: ' + t.reason.message);
    if (n.status === 'fulfilled') {
      state.notifs = n.value.groups;
      state.notifOffset = n.value.nextOffset;
      state.notifHasMore = n.value.hasMore;
    } else errs.push('Powiadomienia: ' + n.reason.message);
    state.error = errs.join(' ') || null;
    state.updatedAt = Date.now();
    notifyNew();
  } finally {
    state.loading = false;
    push();
  }
}

async function loadMore() {
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
  known.threads.clear(); known.notifs.clear(); known.primed = false;
  notifLoaded = NOTIF_PAGE;
  Object.assign(state, {
    needLogin: true, threads: [], notifs: [], error: null, updatedAt: null,
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
ipcMain.handle('load-more', () => loadMore());
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
