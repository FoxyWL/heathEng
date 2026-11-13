'use strict';
// Оболочка Hearth: собственное окно на Chromium из поставки (браузер на ПК не нужен), значок в трее,
// один экземпляр программы, корректная остановка серверов при выходе и выключении Windows.
const fs = require('fs');
const path = require('path');

// «Hearth.exe relay» запускает релей-сервер без окна (для VPS и тестов)
if (process.argv[1] === 'relay') {
  process.argv.splice(1, 1);
  require('../relay/relay.js');
  return;
}

const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell, screen, Notification } = require('electron');

process.env.NO_BROWSER = '1'; // окно рисует оболочка, не агент
process.env.HEARTH_APP = '0';
const hidden = process.argv.includes('--startup'); // запуск вместе с Windows: сразу в трей

let agent;
let win = null;
let tray = null;
let panelUrl = '';
let quitting = false;
let hintShown = false;
const ICON = [path.join(__dirname, '..', 'build', 'hearth.ico'), path.join(__dirname, '..', 'build', 'hearth.png')].find((p) => fs.existsSync(p)) || '';
const origin = () => (panelUrl ? new URL(panelUrl).origin : '');

function logFatal(err) {
  const text = `[${new Date().toISOString()}] ${err && err.stack ? err.stack : err}\n`;
  for (const dir of [agent && agent.dataDir, process.env.DATA_DIR, app.getPath('temp')]) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'hearth-error.log'), text);
      return path.join(dir, 'hearth-error.log');
    } catch {}
  }
  return '';
}

function fatal(err) {
  const where = logFatal(err);
  try {
    dialog.showErrorBox('Hearth', 'Hearth не смог запуститься или остановился из-за ошибки:\n\n' + String(err && err.message ? err.message : err) + (where ? '\n\nПодробности: ' + where : ''));
  } catch {}
  process.exit(1);
}
process.on('uncaughtException', (e) => {
  if (!agent || !panelUrl) return fatal(e);
  logFatal(e); // после запуска одна случайная ошибка не должна ронять серверы игроков
});
process.on('unhandledRejection', (e) => console.error('[hearth] необработанная ошибка: ' + (e && e.stack ? e.stack : e)));

function stateFile() {
  return path.join(agent.dataDir, 'window.json');
}
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const area = screen.getDisplayMatching(b).workArea;
    const fits = b.x + 80 > area.x && b.y >= area.y && b.x < area.x + area.width - 80 && b.y < area.y + area.height - 60;
    return fits ? b : { width: b.width, height: b.height, maximized: b.maximized };
  } catch {
    return {};
  }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized }));
  } catch {}
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  const b = loadBounds();
  win = new BrowserWindow({
    width: Math.max(900, b.width || 1280),
    height: Math.max(600, b.height || 860),
    x: b.x,
    y: b.y,
    minWidth: 900,
    minHeight: 600,
    title: 'Hearth',
    icon: ICON || undefined,
    backgroundColor: '#14110f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, devTools: !app.isPackaged || process.env.HEARTH_DEVTOOLS === '1' },
  });
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win && !win.isDestroyed() && win.show());
  win.on('close', saveBounds);
  win.on('closed', () => {
    win = null;
    if (quitting) return;
    // Окно закрыто: если серверы работают, Hearth остаётся в трее, иначе выходим
    if (agent.running() > 0) {
      if (!hintShown && Notification.isSupported()) {
        hintShown = true;
        new Notification({ title: 'Hearth работает в фоне', body: `Серверов запущено: ${agent.running()}. Значок в трее открывает окно, «Выйти» останавливает всё.` }).show();
      }
    } else quit();
  });
  // Чужие адреса и ссылки наружу открываем в браузере по умолчанию, а в окне остаётся только панель
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== origin()) {
      e.preventDefault();
      openExternal(url);
    }
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.loadURL(panelUrl);
}

function openExternal(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
}

function quit() {
  if (quitting) return;
  quitting = true;
  agent.shutdown(); // останавливает серверы и завершает процесс
}

function makeTray() {
  try {
    const img = ICON ? nativeImage.createFromPath(ICON) : nativeImage.createEmpty();
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
    tray.setToolTip('Hearth');
    const refresh = () => {
      const n = agent.running();
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Открыть Hearth', click: showWindow },
          { label: n ? `Серверов запущено: ${n}` : 'Серверы остановлены', enabled: false },
          { type: 'separator' },
          { label: 'Выйти из Hearth', click: quit },
        ])
      );
    };
    refresh();
    setInterval(refresh, 5000).unref();
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
  } catch (e) {
    console.error('[hearth] трей недоступен: ' + e.message);
  }
}

function makeMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Вид',
        submenu: [
          { role: 'reload', label: 'Обновить' },
          { type: 'separator' },
          { role: 'zoomIn', label: 'Крупнее' },
          { role: 'zoomOut', label: 'Мельче' },
          { role: 'resetZoom', label: 'Обычный масштаб' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: 'Во весь экран' },
        ],
      },
    ])
  );
}

async function boot() {
  agent = require('../agent/server.js');
  // профиль Chromium держим в папке данных Hearth, а не в общем %APPDATA%
  app.setPath('userData', path.join(agent.dataDir, 'app-profile'));
  if (!app.requestSingleInstanceLock()) return app.exit(0);
  app.on('second-instance', () => showWindow());
  agent.hooks.openExternal = openExternal;
  agent.hooks.openPath = (p) => shell.openPath(p).catch(() => {});

  app.on('window-all-closed', () => {}); // жизнь приложения определяют трей и «Выйти», а не окно
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quit();
  });
  app.on('session-end', quit); // выключение или выход из Windows
  await app.whenReady();
  makeMenu();
  const r = await agent.start();
  if (r.already) {
    dialog.showErrorBox('Hearth', 'Hearth уже запущен (возможно, старая версия). Закройте её кнопкой «Выйти из Hearth» и запустите программу снова.');
    return app.exit(0);
  }
  panelUrl = r.url;
  makeTray();
  if (!hidden) showWindow();
}

// для автотестов: доступ к Electron из отладчика Node (включается только переменной окружения)
if (process.env.HEARTH_TEST_HOOK === '1') globalThis.__hearthTest = { electron: require('electron') };

boot().catch(fatal);
