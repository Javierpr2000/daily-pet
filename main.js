const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
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

const ops = {
  add: (data, t) => data.tasks.push({ id: crypto.randomUUID(), title: String(t.title).trim(), kind: t.kind === 'today' ? 'today' : 'daily',
    required: Math.max(1, Math.floor(+t.required) || 1), done: 0, date: today() }),
  tick: (data, id) => { const t = data.tasks.find(x => x.id === id); if (t) t.done = t.done >= t.required ? 0 : t.done + 1; },
  remove: (data, id) => { data.tasks = data.tasks.filter(x => x.id !== id); },
};

function apply(op, arg) {
  const data = load();
  ops[op](data, arg);
  save(data);
  sendProgress(data);
  return data;
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

let pet, panel, dir = 1, paused = false, walking = true, scale = 1, pos;
const size = () => Math.round(PET * scale);
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  ({ walking = true, scale = 1, pos } = readJson(settingsFile(), {}));
}

function saveSettings() {
  writeJson(settingsFile(), { walking, scale, pos: pet && !pet.isDestroyed() ? pet.getPosition() : pos });
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

function createWindows() {
  const area = screen.getPrimaryDisplay().workArea;

  const fits = pos && pos[0] >= area.x && pos[0] <= area.x + area.width - size()
    && pos[1] >= area.y && pos[1] <= area.y + area.height - size();
  const [x, y] = fits ? pos : [area.x + 100, area.y + area.height - size()];
  pet = new BrowserWindow({ ...common, transparent: true, skipTaskbar: true, width: size(), height: size(), x, y });
  pet.loadFile('pet.html');
  pet.webContents.on('did-finish-load', () => { pet.webContents.setZoomFactor(scale); sendProgress(load()); });

  createPanel();

  const walker = setInterval(() => {
    if (paused) return;
    if (!walking) return pet.webContents.send('pet:dir', 0);
    const [x, y] = pet.getPosition();
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
  const area = screen.getPrimaryDisplay().workArea;
  const [x] = pet.getPosition();
  panel.setPosition(Math.max(area.x, Math.min(area.x + area.width - 360, x - 132)), area.y + area.height - size() - 500);
  panel.show();
  panel.webContents.send('tasks:changed');
}

function resize(s) {
  scale = s;
  const area = screen.getPrimaryDisplay().workArea;
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
ipcMain.on('panel:toggle', togglePanel);
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

app.whenReady().then(() => {
  loadSettings();
  createWindows();
  setInterval(() => { load(); if (!panel.isDestroyed() && panel.isVisible()) panel.webContents.send('tasks:changed'); }, 60_000);
});
