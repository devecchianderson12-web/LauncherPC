const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

// Rendimiento: rasterizado por GPU
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

if (!app.requestSingleInstanceLock()) app.quit();

let win, tray, cfg;
const userDir = () => app.getPath('userData');
const coversDir = () => path.join(userDir(), 'covers');
const cfgFile = () => path.join(userDir(), 'config.json');
const DEFAULTS = { custom: [], apiKey: '', hotkey: 'Control+Alt+P', layout: 'ps4', recent: {} };

function loadCfg() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function saveCfg() { fs.mkdirSync(userDir(), { recursive: true }); fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2)); }

const norm = p => path.resolve(p).toLowerCase();
const nkey = s => (s.toLowerCase().replace(/[^a-z0-9]/g, '') || s.toLowerCase());

// ---------- Escaneo de juegos ----------
function steamPath() {
  return new Promise(res => {
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true }, (e, out) => {
      const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(out || '');
      res(m ? m[1].trim().replace(/\//g, '\\') : null);
    });
  });
}

async function scanSteam() {
  const sp = await steamPath();
  if (!sp) return [];
  // Bibliotecas normalizadas: evita contar dos veces la misma carpeta (c:/ vs C:\)
  const libs = new Map([[norm(sp), sp]]);
  try {
    const vdf = fs.readFileSync(path.join(sp, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
      const p = m[1].replace(/\\\\/g, '\\');
      libs.set(norm(p), p);
    }
  } catch {}
  const apps = new Map();
  for (const lib of libs.values()) {
    const dir = path.join(lib, 'steamapps');
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => /^appmanifest_\d+\.acf$/.test(f)); } catch { continue; }
    for (const f of files) {
      try {
        const t = fs.readFileSync(path.join(dir, f), 'utf8');
        const id = /"appid"\s+"(\d+)"/.exec(t)?.[1];
        const name = /"name"\s+"([^"]+)"/.exec(t)?.[1];
        const inst = /"installdir"\s+"([^"]+)"/.exec(t)?.[1];
        if (!id || !name || id === '228980' || /^(Proton|Steam Linux Runtime|Steamworks)/i.test(name)) continue;
        if (!apps.has(id)) apps.set(id, { id: 'steam:' + id, type: 'steam', name, appid: id, dir: inst ? path.join(dir, 'common', inst) : '' });
      } catch {}
    }
  }
  return [...apps.values()];
}

function scanEpic() {
  const dir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
  const out = new Map();
  try {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.item'))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!j.DisplayName || !j.LaunchExecutable || !j.AppName) continue;
        if (!out.has(j.AppName)) out.set(j.AppName, { id: 'epic:' + j.AppName, type: 'epic', name: j.DisplayName, dir: j.InstallLocation, exe: path.join(j.InstallLocation, j.LaunchExecutable) });
      } catch {}
    }
  } catch {}
  return [...out.values()];
}

async function getGames() {
  const all = [...await scanSteam(), ...scanEpic(), ...cfg.custom.map(c => ({ ...c, type: 'custom', dir: path.dirname(c.exe) }))];
  const seen = new Set(), out = [];
  for (const g of all) {
    const keys = ['n:' + nkey(g.name)];
    if (g.exe) keys.push('e:' + norm(g.exe));
    if (keys.some(k => seen.has(k))) continue;   // mismo nombre o mismo .exe = duplicado
    keys.forEach(k => seen.add(k));
    out.push({ ...g, last: cfg.recent[g.id] || 0 });
  }
  return out.sort((a, b) => b.last - a.last || a.name.localeCompare(b.name));
}

// ---------- Portadas ----------
const safe = id => id.replace(/[^a-z0-9_-]/gi, '_');
const coverFile = id => path.join(coversDir(), safe(id) + '.jpg');
const fileUrl = f => 'file:///' + f.replace(/\\/g, '/');

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
  if (fs.existsSync(f)) return fileUrl(f);
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
      const icon = await app.getFileIcon(item.exe, { size: 'large' });
      if (!icon.isEmpty()) buf = icon.toPNG();
    }
  } catch {}
  if (!buf) return null;
  fs.writeFileSync(f, buf);
  return fileUrl(f);
}

// ---------- Estadísticas del sistema (solo mientras el launcher está visible) ----------
const run = (cmd, args, t = 2500) => new Promise(r => execFile(cmd, args, { timeout: t, windowsHide: true }, (e, o) => r(e ? null : String(o))));
let prevCpu = os.cpus().map(c => ({ ...c.times }));
let statsTimer = null, busy = false, nv, tp, lhmDown = 0;

function cpuUse() {
  const cur = os.cpus();
  let idle = 0, total = 0;
  cur.forEach((c, i) => {
    const p = prevCpu[i] || c.times;
    const sum = o => o.user + o.nice + o.sys + o.idle + o.irq;
    total += sum(c.times) - sum(p);
    idle += c.times.idle - p.idle;
  });
  prevCpu = cur.map(c => ({ ...c.times }));
  return total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
}

async function nvidia() {
  if (nv === false) return null;
  const o = await run('nvidia-smi', ['--query-gpu=utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits']);
  if (!o) { nv = false; return null; }
  const [use, temp] = o.trim().split(/\r?\n/)[0].split(',').map(s => parseFloat(s));
  nv = true;
  return { use: isFinite(use) ? use : null, temp: isFinite(temp) ? temp : null };
}

function walk(n, trail, out) {
  const p = [...trail, n.Text];
  if (n.Children?.length) n.Children.forEach(c => walk(c, p, out));
  else out.push({ path: p, text: n.Text, value: n.Value });
}
const num = v => { const x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : null; };

// LibreHardwareMonitor (opcional) con "Remote Web Server" activado: da temperaturas de CPU y GPU AMD/Intel
async function lhm() {
  if (Date.now() < lhmDown) return null;
  try {
    const j = await (await fetch('http://localhost:8085/data.json', { signal: AbortSignal.timeout(1200) })).json();
    const s = [];
    walk(j, [], s);
    const pick = (grp, re) => { const x = s.find(v => v.path.includes(grp) && re.test(v.text)); return x ? num(x.value) : null; };
    return {
      cpuTemp: pick('Temperatures', /^(CPU Package|Core \(Tctl\/Tdie\)|Core \(Tctl\)|Core \(Tdie\)|Core Max)$/),
      gpuTemp: pick('Temperatures', /^GPU Core$/),
      gpuUse: pick('Load', /^GPU Core$/)
    };
  } catch { lhmDown = Date.now() + 15000; return null; }
}

// Uso de GPU genérico (AMD/Intel) con contadores de Windows; si no funciona en tu idioma se desactiva solo
async function typeperf() {
  if (tp === false) return null;
  const o = await run('typeperf', ['\\GPU Engine(*engtype_3D)\\Utilization Percentage', '-sc', '1'], 4000);
  const line = o && o.split(/\r?\n/).filter(l => l.startsWith('"'))[1];
  if (!line) { tp = false; return null; }
  const sum = line.split('","').slice(1).map(v => parseFloat(v.replace(/"/g, '').replace(',', '.'))).filter(isFinite).reduce((a, b) => a + b, 0);
  tp = true;
  return Math.min(100, Math.round(sum));
}

async function tick() {
  if (busy || !win || !win.isVisible()) return;
  busy = true;
  try {
    const cpu = { use: cpuUse(), temp: null };
    const total = os.totalmem();
    const ram = { used: total - os.freemem(), total };
    let gpu = { use: null, temp: null };
    const n = await nvidia();
    if (n) gpu = n;
    const l = await lhm();
    if (l) {
      cpu.temp = l.cpuTemp;
      if (gpu.use == null) gpu.use = l.gpuUse;
      if (gpu.temp == null) gpu.temp = l.gpuTemp;
    }
    if (gpu.use == null) gpu.use = await typeperf();
    if (win && win.isVisible()) win.webContents.send('stats', { cpu, ram, gpu });
  } finally { busy = false; }
}
function startStats() { if (!statsTimer) { tick(); statsTimer = setInterval(tick, 2000); } }
function stopStats() { clearInterval(statsTimer); statsTimer = null; }

// ---------- Ventana ----------
function createWin() {
  win = new BrowserWindow({
    show: false, fullscreen: true, frame: false, backgroundColor: '#0a2a86',
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
  startStats();
}
function hideLauncher() {
  if (!win) return;
  stopStats();
  win.webContents.send('leave');
  win.hide();
}
function toggle() { win.isVisible() ? hideLauncher() : showLauncher(); }
function registerHotkey() {
  globalShortcut.unregisterAll();
  try { globalShortcut.register(cfg.hotkey, toggle); } catch {}
}

// ---------- IPC ----------
ipcMain.handle('games', getGames);
ipcMain.handle('cover', (e, item) => getCover(item));

ipcMain.handle('launch', (e, item) => {
  cfg.recent[item.id] = Date.now();
  saveCfg();
  if (item.type === 'steam') shell.openExternal('steam://rungameid/' + item.appid);
  else if (item.exe) spawn(item.exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(item.exe) }).unref();
  hideLauncher();
});

ipcMain.handle('add', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Elige el juego o aplicación', properties: ['openFile'],
    filters: [{ name: 'Programas', extensions: ['exe', 'lnk', 'bat'] }]
  });
  if (r.canceled || !r.filePaths[0]) return { status: 'cancel' };
  const exe = r.filePaths[0];
  const name = path.basename(exe).replace(/\.[^.]+$/, '');
  if (cfg.custom.some(c => norm(c.exe) === norm(exe))) return { status: 'dup', name };
  const id = 'custom:' + Date.now();
  cfg.custom.push({ id, name, exe });
  // si coincide con un juego ya detectado, no se añade
  if (!(await getGames()).some(g => g.id === id)) { cfg.custom.pop(); return { status: 'dup', name }; }
  saveCfg();
  return { status: 'added', id };
});

ipcMain.handle('remove', (e, id) => {
  cfg.custom = cfg.custom.filter(c => c.id !== id);
  delete cfg.recent[id];
  saveCfg();
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
  return fileUrl(coverFile(id)) + '?t=' + Date.now();
});

ipcMain.handle('getCfg', () => ({ apiKey: cfg.apiKey, layout: cfg.layout, user: os.userInfo().username }));
ipcMain.handle('setCfg', (e, patch) => {
  if (typeof patch.apiKey === 'string') cfg.apiKey = patch.apiKey.trim();
  if (patch.layout === 'ps4' || patch.layout === 'center') cfg.layout = patch.layout;
  saveCfg();
});
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
