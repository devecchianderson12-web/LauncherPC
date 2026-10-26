const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

if (!app.requestSingleInstanceLock()) app.quit();

let win, tray;
const userDir = () => app.getPath('userData');
const coversDir = () => path.join(userDir(), 'covers');
const cfgFile = () => path.join(userDir(), 'config.json');

// ---------- Config ----------
function loadCfg() {
  try { return { custom: [], apiKey: '', hotkey: 'Control+Alt+P', ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; }
  catch { return { custom: [], apiKey: '', hotkey: 'Control+Alt+P' }; }
}
function saveCfg(c) { fs.mkdirSync(userDir(), { recursive: true }); fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 2)); }
let cfg;

// ---------- Escaneo de juegos ----------
function steamPath() {
  return new Promise(res => {
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], (e, out) => {
      const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(out || '');
      res(m ? m[1].trim().replace(/\//g, '\\') : null);
    });
  });
}

async function scanSteam() {
  const sp = await steamPath();
  if (!sp) return [];
  const libs = new Set([sp]);
  try {
    const vdf = fs.readFileSync(path.join(sp, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
  } catch {}
  const out = [];
  for (const lib of libs) {
    const dir = path.join(lib, 'steamapps');
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => /^appmanifest_\d+\.acf$/.test(f)); } catch { continue; }
    for (const f of files) {
      try {
        const t = fs.readFileSync(path.join(dir, f), 'utf8');
        const id = /"appid"\s+"(\d+)"/.exec(t)?.[1];
        const name = /"name"\s+"([^"]+)"/.exec(t)?.[1];
        if (!id || !name || id === '228980' || /^(Proton|Steam Linux Runtime|Steamworks)/i.test(name)) continue;
        out.push({ id: 'steam:' + id, type: 'steam', name, appid: id });
      } catch {}
    }
  }
  return out;
}

function scanEpic() {
  const dir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
  const out = [];
  try {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.item'))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!j.DisplayName || !j.LaunchExecutable) continue;
        out.push({ id: 'epic:' + j.AppName, type: 'epic', name: j.DisplayName, exe: path.join(j.InstallLocation, j.LaunchExecutable) });
      } catch {}
    }
  } catch {}
  return out;
}

async function getGames() {
  const [steam, epic] = [await scanSteam(), scanEpic()];
  const custom = cfg.custom.map(c => ({ ...c, type: 'custom' }));
  return [...steam, ...epic, ...custom].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Portadas ----------
const safe = id => id.replace(/[^a-z0-9_-]/gi, '_');
const coverFile = id => path.join(coversDir(), safe(id) + '.jpg');

async function download(url, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function steamGridCover(name) {
  if (!cfg.apiKey) return null;
  const h = { Authorization: 'Bearer ' + cfg.apiKey };
  const s = await (await fetch('https://www.steamgriddb.com/api/v2/search/autocomplete/' + encodeURIComponent(name), { headers: h })).json();
  const gid = s?.data?.[0]?.id;
  if (!gid) return null;
  const g = await (await fetch(`https://www.steamgriddb.com/api/v2/grids/game/${gid}?dimensions=600x900`, { headers: h })).json();
  const url = g?.data?.[0]?.url;
  return url ? download(url) : null;
}

async function getCover(item) {
  const f = coverFile(item.id);
  if (fs.existsSync(f)) return 'file:///' + f.replace(/\\/g, '/');
  fs.mkdirSync(coversDir(), { recursive: true });
  let buf = null;
  try {
    if (item.type === 'steam') {
      const base = `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.appid}/`;
      for (const n of ['library_600x900.jpg', 'header.jpg']) {
        try { buf = await download(base + n); break; } catch {}
      }
    }
    if (!buf) buf = await steamGridCover(item.name);
    if (!buf && item.exe) {
      // último recurso: icono del ejecutable
      const icon = await app.getFileIcon(item.exe, { size: 'large' });
      if (!icon.isEmpty()) buf = icon.toPNG();
    }
  } catch {}
  if (!buf) return null;
  fs.writeFileSync(f, buf);
  return 'file:///' + f.replace(/\\/g, '/');
}

// ---------- Ventana ----------
function createWin() {
  win = new BrowserWindow({
    show: false, fullscreen: true, frame: false, backgroundColor: '#0a2a6b',
    skipTaskbar: true, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, contextIsolation: true }
  });
  win.loadFile('index.html');
  win.on('close', e => { if (!app.isQuitting) { e.preventDefault(); hideLauncher(); } });
}

function showLauncher() {
  if (!win) return;
  win.show(); win.focus();
  win.webContents.send('enter');
}
function hideLauncher() { if (win) win.hide(); }
function toggle() { win.isVisible() ? hideLauncher() : showLauncher(); }

function registerHotkey() {
  globalShortcut.unregisterAll();
  try { globalShortcut.register(cfg.hotkey, toggle); } catch {}
}

// ---------- IPC ----------
ipcMain.handle('games', getGames);
ipcMain.handle('cover', (e, item) => getCover(item));

ipcMain.handle('launch', (e, item) => {
  if (item.type === 'steam') shell.openExternal('steam://rungameid/' + item.appid);
  else if (item.exe) spawn(item.exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(item.exe) }).unref();
  hideLauncher();
});

ipcMain.handle('add', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Elige el juego o aplicación',
    properties: ['openFile'],
    filters: [{ name: 'Programas', extensions: ['exe', 'lnk', 'bat'] }]
  });
  if (r.canceled || !r.filePaths[0]) return false;
  const exe = r.filePaths[0];
  const name = path.basename(exe).replace(/\.[^.]+$/, '');
  cfg.custom.push({ id: 'custom:' + Date.now(), name, exe });
  saveCfg(cfg);
  return true;
});

ipcMain.handle('remove', (e, id) => {
  cfg.custom = cfg.custom.filter(c => c.id !== id);
  saveCfg(cfg);
  try { fs.unlinkSync(coverFile(id)); } catch {}
});

ipcMain.handle('setCover', async (e, id) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Elige una portada', properties: ['openFile'],
    filters: [{ name: 'Imágenes', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  fs.mkdirSync(coversDir(), { recursive: true });
  fs.copyFileSync(r.filePaths[0], coverFile(id));
  return 'file:///' + coverFile(id).replace(/\\/g, '/') + '?t=' + Date.now();
});

ipcMain.handle('getKey', () => cfg.apiKey);
ipcMain.handle('setKey', (e, k) => { cfg.apiKey = (k || '').trim(); saveCfg(cfg); });
ipcMain.handle('hide', hideLauncher);

// ---------- Arranque ----------
app.on('second-instance', showLauncher);
app.whenReady().then(() => {
  cfg = loadCfg();
  app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  createWin();

  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('PS Launcher');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir', click: showLauncher },
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', toggle);

  registerHotkey();
  win.webContents.once('did-finish-load', () => { if (!process.argv.includes('--hidden')) showLauncher(); });
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', e => e.preventDefault());
