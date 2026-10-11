const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

const PET = 96;
const file = () => path.join(app.getPath('userData'), 'tasks.json');
const today = () => new Date().toLocaleDateString('en-CA');

function load() {
  let data;
  try { data = JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; data = { lastReset: today(), tasks: [] }; }
  return resetIfNewDay(data);
}

function resetIfNewDay(data) {
  const t = today();
  if (data.lastReset === t) return data;
  data.tasks = data.tasks
    .filter(x => x.kind === 'daily' || x.date === t)
    .map(x => x.kind === 'daily' ? { ...x, done: 0 } : x);
  data.lastReset = t;
  save(data);
  return data;
}

function save(data) {
  fs.writeFileSync(file(), JSON.stringify(data, null, 2));
}

let pet, panel, dir = 1, paused = false, walking = true, scale = 1;
const size = () => Math.round(PET * scale);
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { ({ walking = true, scale = 1 } = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}

function saveSettings() {
  fs.writeFileSync(settingsFile(), JSON.stringify({ walking, scale }));
}

function createWindows() {
  const area = screen.getPrimaryDisplay().workArea;
  const common = { frame: false, alwaysOnTop: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') } };

  pet = new BrowserWindow({ ...common, transparent: true, skipTaskbar: true,
    width: size(), height: size(), x: area.x + 100, y: area.y + area.height - size() });
  pet.loadFile('pet.html');
  pet.webContents.on('did-finish-load', () => pet.webContents.setZoomFactor(scale));

  panel = new BrowserWindow({ ...common, width: 360, height: 500, show: false });
  panel.loadFile('panel.html');
  panel.on('close', e => { if (!app.isQuitting) { e.preventDefault(); panel.hide(); } });

  setInterval(() => {
    if (paused) return;
    if (!walking) return pet.webContents.send('pet:dir', 0);
    const [x, y] = pet.getPosition();
    const min = area.x, max = area.x + area.width - size();
    // ponytail: random turn 0.5%/tick; add idle/sit states if it looks too robotic
    if (x <= min || x >= max || Math.random() < 0.005) dir = -dir;
    pet.setPosition(Math.max(min, Math.min(max, x + dir * 2)), y);
    pet.webContents.send('pet:dir', dir);
  }, 50);
}

function togglePanel() {
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
ipcMain.handle('tasks:save', (_, data) => save(data));
ipcMain.on('panel:toggle', togglePanel);
ipcMain.on('pet:hover', (_, h) => { paused = h; });
ipcMain.on('pet:moveBy', (_, dx, dy) => {
  const [x, y] = pet.getPosition();
  pet.setPosition(x + dx, y + dy);
});
ipcMain.on('pet:menu', () => Menu.buildFromTemplate([
  { label: 'Mostrar panel', click: togglePanel },
  { label: 'Caminar', type: 'checkbox', checked: walking, click: () => { walking = !walking; saveSettings(); } },
  { label: 'Tamaño', submenu: [['Pequeño', 0.6], ['Mediano', 1], ['Grande', 1.6]].map(([label, s]) =>
    ({ label, type: 'radio', checked: scale === s, click: () => resize(s) })) },
  { type: 'separator' },
  { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } },
]).popup({ window: pet }));

app.whenReady().then(() => {
  loadSettings();
  createWindows();
  setInterval(() => { load(); if (panel.isVisible()) panel.webContents.send('tasks:changed'); }, 60_000);
});
