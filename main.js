const { app, BrowserWindow, ipcMain, screen, Menu, Notification } = require('electron');
const fs = require('fs');
const path = require('path');

const PET = 96;
const file = () => path.join(app.getPath('userData'), 'tasks.json');
const today = () => new Date().toLocaleDateString('en-CA');

function readJson(f, fallback) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  try { return JSON.parse(text); }
  catch {
    const aside = `${f}.corrupt-${Date.now()}`;
    fs.renameSync(f, aside);
    console.error(`Corrupt ${f}, moved to ${aside}`);
    return fallback;
  }
}

function writeJson(f, data) {
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${f}.tmp`, f);
}

function load() {
  return resetIfNewDay(readJson(file(), { lastReset: today(), tasks: [] }));
}

const timeOrNull = v => /^\d{2}:\d{2}$/.test(v) ? v : null;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 };
// ponytail: 10s floor so a typo can't flood the Windows notification center
function interval(every, unit) {
  unit = Object.hasOwn(UNIT_MS, unit) ? unit : 'm';
  const n = Math.floor(+every);
  if (!(n >= 1)) return { every: null, unit };
  return { every: Math.min(Math.max(n, Math.ceil(10_000 / UNIT_MS[unit])), 86_400_000 / UNIT_MS[unit]), unit };
}
const kindOf = k => k === 'today' ? 'today' : 'daily';

const ops = {
  add: (data, t) => String(t.title).trim() && data.tasks.push({ id: crypto.randomUUID(), title: String(t.title).trim(), kind: kindOf(t.kind),
    required: Math.max(1, Math.floor(+t.required) || 1), done: 0, date: today(), at: timeOrNull(t.at), ...interval(t.every, t.unit) }),
  tick: (data, id) => { const t = data.tasks.find(x => x.id === id); if (t) t.done = Math.min(t.required, t.done + 1); },
  untick: (data, id) => { const t = data.tasks.find(x => x.id === id); if (t) t.done = Math.max(0, t.done - 1); },
  remove: (data, id) => { data.tasks = data.tasks.filter(x => x.id !== id); },
  edit: (data, a) => {
    const t = data.tasks.find(x => x.id === a.id), title = String(a.title).trim();
    if (!t || !title) return;
    t.title = title;
    t.kind = kindOf(a.kind ?? t.kind);
    t.required = Math.max(1, Math.floor(+a.required) || 1);
    t.done = Math.min(t.done, t.required);
    t.at = timeOrNull(a.at);
    Object.assign(t, interval(a.every, a.unit));
  },
  move: (data, a) => {
    const i = data.tasks.findIndex(x => x.id === a.id);
    if (i < 0) return;
    const same = data.tasks.map((x, j) => j).filter(j => data.tasks[j].kind === data.tasks[i].kind);
    const j = same[same.indexOf(i) + (a.delta < 0 ? -1 : 1)];
    if (j !== undefined) [data.tasks[i], data.tasks[j]] = [data.tasks[j], data.tasks[i]];
  },
};

function apply(op, arg) {
  const data = load();
  ops[op](data, arg);
  save(data);
  sendProgress(data);
  notifyTasks();
  if (panel && !panel.isDestroyed()) panel.webContents.send('tasks:changed');
  return data;
}

const started = Date.now(), notified = {};
let taskTimer;

function todayAt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date().setHours(h, m, 0, 0);
}

function dueAt(t) {
  if (t.done >= t.required || (!t.at && !t.every)) return null;
  const base = t.at ? todayAt(t.at) : null, last = notified[t.id];
  if (base && Date.now() < base) return base;
  if (!t.every) return last >= base ? null : base;
  const ms = t.every * UNIT_MS[t.unit ?? 'm'];
  return last ? last + ms : base ?? started + ms;
}

function notifyTasks() {
  clearTimeout(taskTimer);
  const { tasks } = load(), now = Date.now();
  const due = tasks.filter(t => { const d = dueAt(t); return d !== null && d <= now + 250; });
  if (due.length) {
    due.forEach(t => { notified[t.id] = now; });
    notify(`Pendiente: ${due.map(t => t.title).join(', ')}`);
  }
  const next = Math.min(...tasks.map(dueAt).filter(d => d !== null));
  if (next < Infinity) taskTimer = setTimeout(notifyTasks, Math.max(0, next - Date.now()) + 200);
}

function notify(body) {
  const note = new Notification({ title: 'Daily Pet', body });
  note.on('click', () => { if (panel.isDestroyed() || !panel.isVisible()) togglePanel(); });
  note.show();
}

function sendProgress({ tasks }) {
  if (pet && !pet.isDestroyed()) pet.webContents.send('pet:progress', tasks.filter(x => x.done >= x.required).length, tasks.length);
}

function resetIfNewDay(data) {
  const t = today();
  if (data.lastReset === t) return data;
  data.tasks = data.tasks
    .filter(x => x.kind === 'daily' || x.date === t)
    .map(x => x.kind === 'daily' ? { ...x, done: 0 } : x);
  data.lastReset = t;
  save(data);
  sendProgress(data);
  return data;
}

function save(data) {
  writeJson(file(), data);
}

let pet, panel, dir = 1, paused = false, walking = true, scale = 1, pos, reminder = null, firedOn;
const size = () => Math.round(PET * scale);
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  ({ walking = true, scale = 1, pos, reminder = null } = readJson(settingsFile(), {}));
}

function saveSettings() {
  writeJson(settingsFile(), { walking, scale, reminder, pos: pet && !pet.isDestroyed() ? pet.getPosition() : pos });
}

// Dev runs (npm start) must pass the app folder to electron.exe, or Windows launches an empty Electron.
const loginArgs = () => app.isPackaged ? [] : [app.getAppPath()];
const startsWithWindows = () => app.getLoginItemSettings({ args: loginArgs() }).openAtLogin;

const common = { frame: false, alwaysOnTop: true, resizable: false,
  webPreferences: { preload: path.join(__dirname, 'preload.js') } };

function createPanel() {
  panel = new BrowserWindow({ ...common, width: 360, height: 500, show: false });
  panel.loadFile('panel.html');
  panel.on('close', e => { if (!app.isQuitting) { e.preventDefault(); panel.hide(); } });
}

const areaOf = bounds => screen.getDisplayMatching(bounds).workArea;
const petArea = () => areaOf(pet.getBounds());

function createWindows() {
  const saved = pos && areaOf({ x: pos[0], y: pos[1], width: size(), height: size() });
  const fits = saved && pos[0] >= saved.x && pos[0] <= saved.x + saved.width - size()
    && pos[1] >= saved.y && pos[1] <= saved.y + saved.height - size();
  const area = screen.getPrimaryDisplay().workArea;
  const [x, y] = fits ? pos : [area.x + 100, area.y + area.height - size()];
  pet = new BrowserWindow({ ...common, transparent: true, skipTaskbar: true, width: size(), height: size(), x, y });
  pet.loadFile('pet.html');
  pet.webContents.on('did-finish-load', () => { pet.webContents.setZoomFactor(scale); sendProgress(load()); });

  createPanel();

  const walker = setInterval(() => {
    if (paused) return;
    if (!walking) return pet.webContents.send('pet:dir', 0);
    const [x, y] = pet.getPosition();
    const area = petArea();
    const min = area.x, max = area.x + area.width - size();
    // ponytail: random turn 0.5%/tick; add idle/sit states if it looks too robotic
    if (x <= min || x >= max || Math.random() < 0.005) dir = -dir;
    pet.setPosition(Math.max(min, Math.min(max, x + dir * 2)), y);
    pet.webContents.send('pet:dir', dir);
  }, 50);
  pet.on('closed', () => clearInterval(walker));
}

function togglePanel() {
  if (panel.isDestroyed()) createPanel();
  if (panel.isVisible()) return panel.hide();
  const area = petArea();
  const [x] = pet.getPosition();
  panel.setPosition(Math.max(area.x, Math.min(area.x + area.width - 360, x - 132)), area.y + area.height - size() - 500);
  panel.show();
  panel.webContents.send('tasks:changed');
}

const hhmm = () => new Date().toTimeString().slice(0, 5);
// Times already past when the app starts or the reminder is set count as fired today.
let reminderTimer;
function armReminder() {
  firedOn = reminder && hhmm() >= reminder ? today() : null;
  clearTimeout(reminderTimer);
  if (!reminder) return;
  const [h, m] = reminder.split(':').map(Number);
  const at = new Date();
  at.setHours(h, m, 0, 0);
  if (at <= Date.now()) at.setDate(at.getDate() + 1);
  // The 60s interval stays as a fallback for timers delayed by sleep.
  reminderTimer = setTimeout(() => { checkReminder(load()); armReminder(); }, at - Date.now() + 200);
}

function checkReminder(data) {
  if (!reminder || firedOn === today() || hhmm() < reminder) return;
  firedOn = today();
  const n = data.tasks.filter(t => t.done < t.required).length;
  if (!n) return;
  notify(`Tienes ${n} tareas pendientes`);
}

function resize(s) {
  scale = s;
  const area = petArea();
  const [x] = pet.getPosition();
  pet.setBounds({ x: Math.min(x, area.x + area.width - size()), y: area.y + area.height - size(), width: size(), height: size() });
  pet.webContents.setZoomFactor(s);
  saveSettings();
}

ipcMain.handle('tasks:get', () => load());
ipcMain.handle('tasks:op', (_, op, arg) => {
  if (!Object.hasOwn(ops, op)) throw new Error(`Unknown op ${op}`);
  return apply(op, arg);
});
ipcMain.handle('reminder:get', () => reminder);
ipcMain.handle('reminder:set', (_, t) => {
  if (t !== null && !/^\d{2}:\d{2}$/.test(t)) throw new Error(`Invalid reminder ${t}`);
  reminder = t;
  armReminder();
  saveSettings();
});
ipcMain.on('panel:toggle', togglePanel);
let editor;
ipcMain.on('editor:open', (_, id) => {
  if (editor && !editor.isDestroyed()) editor.destroy();
  editor = new BrowserWindow({ ...common, width: 340, height: 380 });
  editor.loadFile('editor.html', id ? { query: { id: String(id) } } : {});
});
ipcMain.on('pet:hover', (_, h) => { paused = h; });
ipcMain.on('pet:moveBy', (_, dx, dy) => {
  const [x, y] = pet.getPosition();
  pet.setPosition(x + dx, y + dy);
});
ipcMain.on('pet:dragEnd', saveSettings);
ipcMain.on('pet:menu', () => Menu.buildFromTemplate([
  { label: 'Mostrar panel', click: togglePanel },
  { label: 'Caminar', type: 'checkbox', checked: walking, click: () => { walking = !walking; saveSettings(); } },
  { label: 'Tamaño', submenu: [['Pequeño', 0.6], ['Mediano', 1], ['Grande', 1.6]].map(([label, s]) =>
    ({ label, type: 'radio', checked: scale === s, click: () => resize(s) })) },
  { label: 'Iniciar con Windows', type: 'checkbox', checked: startsWithWindows(),
    click: i => app.setLoginItemSettings({ openAtLogin: i.checked, path: process.execPath, args: loginArgs() }) },
  { type: 'separator' },
  { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } },
]).popup({ window: pet }));

app.on('before-quit', saveSettings);

// Windows drops toasts from apps without an AppUserModelId; unpackaged runs must use the exe path.
app.setAppUserModelId(app.isPackaged ? 'com.dailypet.app' : process.execPath);

app.whenReady().then(() => {
  loadSettings();
  armReminder();
  createWindows();
  notifyTasks();
  setInterval(() => { checkReminder(load()); notifyTasks(); if (!panel.isDestroyed() && panel.isVisible()) panel.webContents.send('tasks:changed'); }, 60_000);
});
