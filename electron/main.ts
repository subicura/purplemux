import { capturePristineEnv } from './pristine-env';
import { applyResolvedShellEnv } from './shell-env';
import { app, BrowserWindow, shell, Menu, ipcMain, session, screen, Notification, nativeTheme, dialog, type IpcMainInvokeEvent } from 'electron';
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { execFileSync } from 'child_process';
import { pickTaglines } from './splash-taglines';
import { initBrowserBridge } from './browser-bridge';

const isDev = process.env.NODE_ENV === 'development';
const devUrl = process.env.ELECTRON_DEV_URL;

const assertLocalRenderer = (event: IpcMainInvokeEvent) => {
  const url = event.sender.getURL();
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopback) return;
  } catch {
    // fall through
  }
  throw new Error('Startup settings can only be changed from the local purplemux app.');
};

const fixEnv = () => {
  const additions = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const current = process.env.PATH || '';
  const parts = current.split(':');
  for (const dir of additions) {
    if (!parts.includes(dir)) parts.unshift(dir);
  }
  process.env.PATH = parts.join(':');

  // Finder/Dock에서 실행 시 locale 환경변수가 없어 Nerd Font 글리프가 깨짐
  if (!process.env.LANG) {
    process.env.LANG = 'en_US.UTF-8';
  }
};

// --- Server Config (~/.purplemux/config.json) ---

interface IServerConfig {
  mode: 'local' | 'remote';
  remoteUrl?: string;
}

interface IWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
  isFullScreen?: boolean;
  displayId?: number;
}

interface IAppConfig {
  server?: IServerConfig;
  recentRemoteUrls?: string[];
  windowState?: IWindowState;
  appTheme?: string;
}

const MAX_RECENT_REMOTE_URLS = 10;

const CONFIG_DIR = path.join(os.homedir(), '.purplemux');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PORT_FILE = path.join(CONFIG_DIR, 'port');
const LAUNCH_AGENT_LABEL = 'com.subicura.purplemux.server';
const LAUNCH_AGENT_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const LAUNCH_AGENT_FILE = path.join(LAUNCH_AGENT_DIR, `${LAUNCH_AGENT_LABEL}.plist`);
const LAUNCH_AGENT_LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'purplemux');

const readAppConfig = (): IAppConfig => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
};

const writeAppConfig = (config: IAppConfig) => {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (err) {
    console.error('[electron] Failed to save config.json:', err);
  }
};

const readServerConfig = (): IServerConfig => {
  const cfg = readAppConfig();
  if (cfg.server?.mode === 'remote' && cfg.server?.remoteUrl) {
    return { mode: 'remote', remoteUrl: cfg.server.remoteUrl };
  }
  return { mode: 'local' };
};

const writeServerConfig = (server: IServerConfig) => {
  const cfg = readAppConfig();
  cfg.server = server;
  writeAppConfig(cfg);
};

interface IServerLaunchAgentStatus {
  supported: boolean;
  enabled: boolean;
  loaded: boolean;
  stale: boolean;
  path: string;
  reason?: string;
}

const launchctlTarget = () => `gui/${process.getuid?.() ?? os.userInfo().uid}`;

const launchctlService = () => `${launchctlTarget()}/${LAUNCH_AGENT_LABEL}`;

const escapePlistValue = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const isServerLaunchAgentSupported = (): { supported: boolean; reason?: string } => {
  if (process.platform !== 'darwin') return { supported: false, reason: 'macOS only' };
  if (!app.isPackaged) return { supported: false, reason: 'Available in packaged app only' };
  if (process.execPath.startsWith('/Volumes/') || process.execPath.includes('/AppTranslocation/')) {
    return { supported: false, reason: 'Move purplemux to Applications before enabling startup.' };
  }
  return { supported: true };
};

const buildServerLaunchAgentPlist = (): string => {
  const appPath = app.getAppPath();
  const appPathUnpacked = appPath.replace('app.asar', 'app.asar.unpacked');
  const standaloneMods = path.join(appPath, '.next', 'standalone', 'node_modules');
  const launcherPath = path.join(appPath, 'dist-electron', 'server-launcher.js');
  const nodeHelperPath = path.resolve(path.dirname(process.execPath), '..', 'Resources', 'purplemux-node');
  const pathEntries = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapePlistValue(LAUNCH_AGENT_LABEL)}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${escapePlistValue(nodeHelperPath)}</string>
      <string>${escapePlistValue(launcherPath)}</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
      <key>ELECTRON_RUN_AS_NODE</key>
      <string>1</string>
      <key>NODE_ENV</key>
      <string>production</string>
      <key>__PMUX_APP_DIR</key>
      <string>${escapePlistValue(appPath)}</string>
      <key>__PMUX_APP_DIR_UNPACKED</key>
      <string>${escapePlistValue(appPathUnpacked)}</string>
      <key>NODE_PATH</key>
      <string>${escapePlistValue(standaloneMods)}</string>
      <key>PATH</key>
      <string>${escapePlistValue(pathEntries.join(':'))}</string>
      <key>LANG</key>
      <string>en_US.UTF-8</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>

    <key>StandardOutPath</key>
    <string>${escapePlistValue(path.join(LAUNCH_AGENT_LOG_DIR, 'server.stdout.log'))}</string>

    <key>StandardErrorPath</key>
    <string>${escapePlistValue(path.join(LAUNCH_AGENT_LOG_DIR, 'server.stderr.log'))}</string>
  </dict>
</plist>
`;
};

const isServerLaunchAgentLoaded = (): boolean => {
  try {
    execFileSync('/bin/launchctl', ['print', launchctlService()], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const isServerLaunchAgentCurrent = (): boolean => {
  try {
    return fs.readFileSync(LAUNCH_AGENT_FILE, 'utf-8') === buildServerLaunchAgentPlist();
  } catch {
    return false;
  }
};

const getServerLaunchAgentStatus = (): IServerLaunchAgentStatus => {
  const support = isServerLaunchAgentSupported();
  const exists = fs.existsSync(LAUNCH_AGENT_FILE);
  const current = support.supported && isServerLaunchAgentCurrent();
  return {
    supported: support.supported,
    reason: support.reason,
    enabled: current,
    loaded: exists && isServerLaunchAgentLoaded(),
    stale: exists && !current,
    path: LAUNCH_AGENT_FILE,
  };
};

const setServerLaunchAgentEnabled = async (enabled: boolean): Promise<IServerLaunchAgentStatus> => {
  const support = isServerLaunchAgentSupported();
  if (enabled && !support.supported) {
    throw new Error(support.reason || 'Server launch agent is not supported.');
  }

  if (process.platform !== 'darwin') {
    throw new Error('Server launch agent is macOS only.');
  }

  const shouldTakeOverLocalServer = !enabled && !!localPort && !serverShutdown && serverConfig.mode === 'local';
  const takeoverWindows = shouldTakeOverLocalServer
    ? BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
    : [];
  const previousPort = localPort;

  const reloadTakeoverWindows = (port: number | null) => {
    if (!port) return;
    for (const win of takeoverWindows) {
      if (win.isDestroyed()) continue;
      win.loadURL(`http://localhost:${port}`);
      clearSplashHistory(win);
    }
  };

  for (const win of takeoverWindows) {
    loadSplash(win);
  }

  try {
    if (isServerLaunchAgentLoaded()) {
      execFileSync('/bin/launchctl', ['bootout', launchctlService()], { stdio: 'ignore' });
    }

    if (!enabled) {
      fs.rmSync(LAUNCH_AGENT_FILE, { force: true });
      if (takeoverWindows.length > 0) {
        const stopped = await waitForExistingLocalServerToStop(30_000);
        reloadTakeoverWindows(stopped ? await startLocalServer() : previousPort);
      }
      return getServerLaunchAgentStatus();
    }

    fs.mkdirSync(LAUNCH_AGENT_DIR, { recursive: true });
    fs.mkdirSync(LAUNCH_AGENT_LOG_DIR, { recursive: true });
    fs.writeFileSync(LAUNCH_AGENT_FILE, buildServerLaunchAgentPlist(), { mode: 0o644 });
    execFileSync('/bin/launchctl', ['bootstrap', launchctlTarget(), LAUNCH_AGENT_FILE], { stdio: 'ignore' });
    execFileSync('/bin/launchctl', ['enable', launchctlService()], { stdio: 'ignore' });
    execFileSync('/bin/launchctl', ['kickstart', '-k', launchctlService()], { stdio: 'ignore' });
    return getServerLaunchAgentStatus();
  } catch (err) {
    // takeover 도중 실패하면 창이 splash에 갇히므로 마지막으로 알려진 서버로 복귀
    reloadTakeoverWindows(localPort ?? previousPort);
    throw err;
  }
};

const readRecentRemoteUrls = (): string[] => {
  const cfg = readAppConfig();
  return Array.isArray(cfg.recentRemoteUrls) ? cfg.recentRemoteUrls.filter((u) => typeof u === 'string') : [];
};

const addRecentRemoteUrl = (url: string) => {
  const cfg = readAppConfig();
  const existing = Array.isArray(cfg.recentRemoteUrls) ? cfg.recentRemoteUrls.filter((u) => typeof u === 'string') : [];
  cfg.recentRemoteUrls = [url, ...existing.filter((u) => u !== url)].slice(0, MAX_RECENT_REMOTE_URLS);
  writeAppConfig(cfg);
};

const removeRecentRemoteUrl = (url: string) => {
  const cfg = readAppConfig();
  if (!Array.isArray(cfg.recentRemoteUrls)) return;
  cfg.recentRemoteUrls = cfg.recentRemoteUrls.filter((u) => u !== url);
  writeAppConfig(cfg);
};

// --- Window State ---

const DEFAULT_WINDOW_STATE: IWindowState = { width: 1280, height: 800 };

const readWindowState = (): IWindowState => {
  const cfg = readAppConfig();
  return cfg.windowState || DEFAULT_WINDOW_STATE;
};

const writeWindowState = (state: IWindowState) => {
  const cfg = readAppConfig();
  cfg.windowState = state;
  writeAppConfig(cfg);
};

const isVisibleOnAnyDisplay = (bounds: { x: number; y: number; width: number; height: number }): boolean => {
  const displays = screen.getAllDisplays();
  const MIN_OVERLAP = 50;
  return displays.some((display) => {
    const { x, y, width, height } = display.workArea;
    const overlapX = Math.max(0, Math.min(bounds.x + bounds.width, x + width) - Math.max(bounds.x, x));
    const overlapY = Math.max(0, Math.min(bounds.y + bounds.height, y + height) - Math.max(bounds.y, y));
    return overlapX >= MIN_OVERLAP && overlapY >= MIN_OVERLAP;
  });
};

// --- Prompt Window ---

const showServerPrompt = (
  parent: BrowserWindow,
  currentUrl: string | undefined,
  recent: string[],
  onDelete: (url: string) => void,
): Promise<string | null> =>
  new Promise((resolve) => {
    const visibleRows = Math.min(recent.length, 5);
    const recentHeight = recent.length ? 28 + visibleRows * 38 : 0;
    const prompt = new BrowserWindow({
      width: 420,
      height: 168 + recentHeight,
      useContentSize: true,
      parent,
      modal: true,
      resizable: false,
      show: false,
      minimizable: false,
      maximizable: false,
      backgroundColor: '#09090b',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    const escaped = (currentUrl || 'https://').replace(/"/g, '&quot;');
    const m = mt();
    const recentJson = JSON.stringify(recent).replace(/</g, '\\u003c');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${m.serverConnection}</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#09090b;color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px}
label{display:block;margin-bottom:8px;font-size:13px;color:#a1a1aa}
input{width:100%;padding:8px 12px;border:1px solid #27272a;border-radius:6px;background:#18181b;color:#fafafa;font-size:14px;outline:none}
input:focus{border-color:#7c3aed}
.buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
button{padding:6px 16px;border-radius:6px;border:1px solid #27272a;font-size:13px;cursor:pointer}
.cancel{background:#27272a;color:#fafafa}.cancel:hover{background:#3f3f46}
.connect{background:#7c3aed;color:#fff;border-color:#7c3aed}.connect:hover{background:#6d28d9}
#recentSection{margin-top:20px;display:none}
#recentSection label{margin-bottom:6px}
#recentList{max-height:190px;overflow-y:auto}
.recent-row{display:flex;align-items:center;gap:6px;margin-top:4px}
.recent-url{flex:1;text-align:left;padding:6px 10px;background:#18181b;color:#fafafa;border:1px solid #27272a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.recent-url:hover{border-color:#7c3aed;background:#1f1f23}
.recent-del{padding:6px 10px;background:#27272a;color:#a1a1aa;line-height:1}
.recent-del:hover{background:#3f3f46;color:#fafafa}
</style></head><body>
<label>${m.serverAddress}</label>
<input id="url" value="${escaped}" placeholder="https://192.168.1.100:8022"/>
<div class="buttons">
<button class="cancel" id="cancelBtn">${m.cancel}</button>
<button class="connect" id="connectBtn">${m.connect}</button>
</div>
<div id="recentSection">
<label>${m.recentConnections}</label>
<div id="recentList"></div>
</div>
<script>
var input=document.getElementById('url');
input.focus();input.select();
document.getElementById('cancelBtn').onclick=function(){window.close()};
document.getElementById('connectBtn').onclick=function(){
  var v=input.value.trim();
  if(v){document.title='CONNECT:'+v;window.close()}
};
input.onkeydown=function(e){
  if(e.key==='Enter')document.getElementById('connectBtn').click();
  if(e.key==='Escape')window.close();
};
var recent=${recentJson};
var seq=0;
var listEl=document.getElementById('recentList');
var sectionEl=document.getElementById('recentSection');
function render(){
  listEl.innerHTML='';
  recent.forEach(function(url){
    var row=document.createElement('div');row.className='recent-row';
    var pick=document.createElement('button');pick.className='recent-url';pick.textContent=url;pick.title=url;
    pick.onclick=function(){input.value=url;input.focus()};
    var del=document.createElement('button');del.className='recent-del';del.textContent='×';del.title=${JSON.stringify(m.remove)};
    del.onclick=function(e){
      e.stopPropagation();
      document.title='DELETE:'+(seq++)+':'+url;
      recent=recent.filter(function(u){return u!==url});
      render();
    };
    row.appendChild(pick);row.appendChild(del);listEl.appendChild(row);
  });
  sectionEl.style.display=recent.length?'block':'none';
}
render();
</script></body></html>`;

    let result: string | null = null;

    prompt.webContents.on('page-title-updated', (_e, title) => {
      if (title.startsWith('CONNECT:')) {
        result = title.slice('CONNECT:'.length);
      } else if (title.startsWith('DELETE:')) {
        const rest = title.slice('DELETE:'.length);
        const url = rest.slice(rest.indexOf(':') + 1);
        if (url) onDelete(url);
      }
    });

    prompt.on('closed', () => resolve(result));
    prompt.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    prompt.webContents.once('did-finish-load', async () => {
      try {
        const h = await prompt.webContents.executeJavaScript('document.body.offsetHeight');
        if (typeof h === 'number' && h > 0) prompt.setContentSize(420, Math.round(h));
      } catch {
        // keep the estimated size
      }
      prompt.show();
    });
  });

// --- i18n ---

interface IMenuMessages {
  server: string;
  useLocalServer: string;
  connectRemoteServer: string;
  serverConnection: string;
  serverAddress: string;
  recentConnections: string;
  remove: string;
  cancel: string;
  connect: string;
  checkForUpdates: string;
  updateAvailableMessage: string;
  updateAvailableDetail: string;
  download: string;
  later: string;
  updateReadyMessage: string;
  updateReadyDetail: string;
  restartNow: string;
  upToDateMessage: string;
  upToDateDetail: string;
  updateErrorMessage: string;
}

const menuMessages: Record<string, IMenuMessages> = {
  en: { server: 'Server', useLocalServer: 'Use Local Server', connectRemoteServer: 'Connect to Remote Server…', serverConnection: 'Server Connection', serverAddress: 'Server Address', recentConnections: 'Recent Connections', remove: 'Remove', cancel: 'Cancel', connect: 'Connect', checkForUpdates: 'Check for Updates…', updateAvailableMessage: 'A new version ({version}) is available', updateAvailableDetail: 'Would you like to download it now?', download: 'Download', later: 'Later', updateReadyMessage: 'Version {version} is ready to install', updateReadyDetail: 'Restart purplemux to apply the update.', restartNow: 'Restart Now', upToDateMessage: "You're up to date", upToDateDetail: 'purplemux {version} is the latest version.', updateErrorMessage: 'Failed to check for updates' },
  ko: { server: '서버', useLocalServer: '로컬 서버 사용', connectRemoteServer: '원격 서버 연결…', serverConnection: '서버 연결', serverAddress: '서버 주소', recentConnections: '최근 연결', remove: '삭제', cancel: '취소', connect: '연결', checkForUpdates: '업데이트 확인…', updateAvailableMessage: '새 버전({version})이 있습니다', updateAvailableDetail: '지금 다운로드할까요?', download: '다운로드', later: '나중에', updateReadyMessage: '{version} 버전 설치 준비 완료', updateReadyDetail: 'purplemux를 재시작하면 업데이트가 적용됩니다.', restartNow: '지금 재시작', upToDateMessage: '최신 버전입니다', upToDateDetail: 'purplemux {version}을 사용 중입니다.', updateErrorMessage: '업데이트 확인에 실패했습니다' },
  ja: { server: 'サーバー', useLocalServer: 'ローカルサーバーを使用', connectRemoteServer: 'リモートサーバーに接続…', serverConnection: 'サーバー接続', serverAddress: 'サーバーアドレス', recentConnections: '最近の接続', remove: '削除', cancel: 'キャンセル', connect: '接続', checkForUpdates: 'アップデートを確認…', updateAvailableMessage: '新しいバージョン ({version}) が利用可能です', updateAvailableDetail: '今すぐダウンロードしますか?', download: 'ダウンロード', later: '後で', updateReadyMessage: 'バージョン {version} のインストール準備が完了しました', updateReadyDetail: 'purplemux を再起動してアップデートを適用します。', restartNow: '今すぐ再起動', upToDateMessage: '最新バージョンです', upToDateDetail: 'purplemux {version} を使用しています。', updateErrorMessage: 'アップデートの確認に失敗しました' },
  'zh-CN': { server: '服务器', useLocalServer: '使用本地服务器', connectRemoteServer: '连接远程服务器…', serverConnection: '服务器连接', serverAddress: '服务器地址', recentConnections: '最近的连接', remove: '删除', cancel: '取消', connect: '连接', checkForUpdates: '检查更新…', updateAvailableMessage: '发现新版本 ({version})', updateAvailableDetail: '是否立即下载?', download: '下载', later: '稍后', updateReadyMessage: '版本 {version} 已准备好安装', updateReadyDetail: '重启 purplemux 以应用更新。', restartNow: '立即重启', upToDateMessage: '已是最新版本', upToDateDetail: '当前正在使用 purplemux {version}。', updateErrorMessage: '检查更新失败' },
  'zh-TW': { server: '伺服器', useLocalServer: '使用本機伺服器', connectRemoteServer: '連線遠端伺服器…', serverConnection: '伺服器連線', serverAddress: '伺服器位址', recentConnections: '最近的連線', remove: '刪除', cancel: '取消', connect: '連線', checkForUpdates: '檢查更新…', updateAvailableMessage: '發現新版本 ({version})', updateAvailableDetail: '是否立即下載?', download: '下載', later: '稍後', updateReadyMessage: '版本 {version} 已準備好安裝', updateReadyDetail: '重新啟動 purplemux 以套用更新。', restartNow: '立即重新啟動', upToDateMessage: '已是最新版本', upToDateDetail: '目前正在使用 purplemux {version}。', updateErrorMessage: '檢查更新失敗' },
  es: { server: 'Servidor', useLocalServer: 'Usar servidor local', connectRemoteServer: 'Conectar a servidor remoto…', serverConnection: 'Conexión al servidor', serverAddress: 'Dirección del servidor', recentConnections: 'Conexiones recientes', remove: 'Eliminar', cancel: 'Cancelar', connect: 'Conectar', checkForUpdates: 'Buscar actualizaciones…', updateAvailableMessage: 'Nueva versión ({version}) disponible', updateAvailableDetail: '¿Deseas descargarla ahora?', download: 'Descargar', later: 'Más tarde', updateReadyMessage: 'La versión {version} está lista para instalar', updateReadyDetail: 'Reinicia purplemux para aplicar la actualización.', restartNow: 'Reiniciar ahora', upToDateMessage: 'Estás al día', upToDateDetail: 'purplemux {version} es la última versión.', updateErrorMessage: 'Error al buscar actualizaciones' },
  de: { server: 'Server', useLocalServer: 'Lokalen Server verwenden', connectRemoteServer: 'Mit Remote-Server verbinden…', serverConnection: 'Serververbindung', serverAddress: 'Serveradresse', recentConnections: 'Letzte Verbindungen', remove: 'Entfernen', cancel: 'Abbrechen', connect: 'Verbinden', checkForUpdates: 'Nach Updates suchen…', updateAvailableMessage: 'Neue Version ({version}) verfügbar', updateAvailableDetail: 'Möchten Sie sie jetzt herunterladen?', download: 'Herunterladen', later: 'Später', updateReadyMessage: 'Version {version} kann installiert werden', updateReadyDetail: 'Starten Sie purplemux neu, um das Update anzuwenden.', restartNow: 'Jetzt neu starten', upToDateMessage: 'Sie verwenden die neueste Version', upToDateDetail: 'purplemux {version} ist die aktuellste Version.', updateErrorMessage: 'Fehler beim Prüfen auf Updates' },
  fr: { server: 'Serveur', useLocalServer: 'Utiliser le serveur local', connectRemoteServer: 'Se connecter à un serveur distant…', serverConnection: 'Connexion au serveur', serverAddress: 'Adresse du serveur', recentConnections: 'Connexions récentes', remove: 'Supprimer', cancel: 'Annuler', connect: 'Connecter', checkForUpdates: 'Rechercher les mises à jour…', updateAvailableMessage: 'Nouvelle version ({version}) disponible', updateAvailableDetail: 'Voulez-vous la télécharger maintenant ?', download: 'Télécharger', later: 'Plus tard', updateReadyMessage: 'La version {version} est prête à être installée', updateReadyDetail: 'Redémarrez purplemux pour appliquer la mise à jour.', restartNow: 'Redémarrer maintenant', upToDateMessage: 'Vous êtes à jour', upToDateDetail: 'purplemux {version} est la dernière version.', updateErrorMessage: 'Échec de la recherche de mises à jour' },
  'pt-BR': { server: 'Servidor', useLocalServer: 'Usar servidor local', connectRemoteServer: 'Conectar a servidor remoto…', serverConnection: 'Conexão com servidor', serverAddress: 'Endereço do servidor', recentConnections: 'Conexões recentes', remove: 'Remover', cancel: 'Cancelar', connect: 'Conectar', checkForUpdates: 'Buscar atualizações…', updateAvailableMessage: 'Nova versão ({version}) disponível', updateAvailableDetail: 'Deseja baixá-la agora?', download: 'Baixar', later: 'Depois', updateReadyMessage: 'A versão {version} está pronta para instalar', updateReadyDetail: 'Reinicie o purplemux para aplicar a atualização.', restartNow: 'Reiniciar agora', upToDateMessage: 'Você está atualizado', upToDateDetail: 'purplemux {version} é a versão mais recente.', updateErrorMessage: 'Falha ao verificar atualizações' },
  ru: { server: 'Сервер', useLocalServer: 'Использовать локальный сервер', connectRemoteServer: 'Подключиться к удалённому серверу…', serverConnection: 'Подключение к серверу', serverAddress: 'Адрес сервера', recentConnections: 'Недавние подключения', remove: 'Удалить', cancel: 'Отмена', connect: 'Подключить', checkForUpdates: 'Проверить обновления…', updateAvailableMessage: 'Доступна новая версия ({version})', updateAvailableDetail: 'Загрузить её сейчас?', download: 'Загрузить', later: 'Позже', updateReadyMessage: 'Версия {version} готова к установке', updateReadyDetail: 'Перезапустите purplemux, чтобы применить обновление.', restartNow: 'Перезапустить', upToDateMessage: 'У вас последняя версия', upToDateDetail: 'purplemux {version} — это актуальная версия.', updateErrorMessage: 'Не удалось проверить обновления' },
  tr: { server: 'Sunucu', useLocalServer: 'Yerel sunucuyu kullan', connectRemoteServer: 'Uzak sunucuya bağlan…', serverConnection: 'Sunucu bağlantısı', serverAddress: 'Sunucu adresi', recentConnections: 'Son bağlantılar', remove: 'Kaldır', cancel: 'İptal', connect: 'Bağlan', checkForUpdates: 'Güncellemeleri denetle…', updateAvailableMessage: 'Yeni sürüm ({version}) kullanılabilir', updateAvailableDetail: 'Şimdi indirmek ister misiniz?', download: 'İndir', later: 'Sonra', updateReadyMessage: '{version} sürümü yüklemeye hazır', updateReadyDetail: 'Güncellemeyi uygulamak için purplemux’u yeniden başlatın.', restartNow: 'Şimdi Yeniden Başlat', upToDateMessage: 'Güncelsiniz', upToDateDetail: 'purplemux {version} en son sürümdür.', updateErrorMessage: 'Güncelleme kontrolü başarısız' },
};

let currentLocale = 'en';

const mt = (): IMenuMessages => menuMessages[currentLocale] || menuMessages.en;

const readLocaleFromConfig = (): string => {
  const cfg = readAppConfig();
  return (cfg as Record<string, unknown>).locale as string || 'en';
};

// --- State ---

const windows = new Set<BrowserWindow>();
let lastFocusedWindow: BrowserWindow | null = null;
let serverShutdown: (() => Promise<void>) | null = null;
let isQuitting = false;
let serverConfig: IServerConfig = { mode: 'local' };
let localPort: number | null = null;
let cachedStart: ((opts: { port: number }) => Promise<{ port: number; shutdown: () => Promise<void> }>) | null = null;

const getPrimaryWindow = (): BrowserWindow | null => {
  if (lastFocusedWindow && !lastFocusedWindow.isDestroyed() && windows.has(lastFocusedWindow)) {
    return lastFocusedWindow;
  }
  for (const w of windows) {
    if (!w.isDestroyed()) return w;
  }
  return null;
};

const resolveCurrentUrl = (): string | null => {
  const primary = getPrimaryWindow();
  const url = primary?.webContents.getURL();
  if (url && url !== 'about:blank' && !url.startsWith('data:')) return url;
  if (serverConfig.mode === 'remote' && serverConfig.remoteUrl) return serverConfig.remoteUrl;
  if (localPort) return `http://localhost:${localPort}`;
  return null;
};

// --- Auto Updater ---

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 3000;

let updaterInitialized = false;
let updateCheckTimer: ReturnType<typeof setInterval> | null = null;
let pendingUpdateVersion: string | null = null;
let isUpdateDialogOpen = false;

const formatMsg = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');

const canRunUpdater = (): boolean => !isDev && !devUrl && app.isPackaged;

const showUpdateDialog = (options: Electron.MessageBoxOptions) => {
  const primary = getPrimaryWindow();
  return primary
    ? dialog.showMessageBox(primary, options)
    : dialog.showMessageBox(options);
};

const runExclusiveDialog = async (fn: () => Promise<void>) => {
  if (isUpdateDialogOpen) return;
  isUpdateDialogOpen = true;
  try {
    await fn();
  } catch (err) {
    console.error('[updater] dialog error:', err);
  } finally {
    isUpdateDialogOpen = false;
  }
};

const setupAutoUpdater = () => {
  if (updaterInitialized || !canRunUpdater()) return;
  updaterInitialized = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    if (pendingUpdateVersion === info.version) return;
    pendingUpdateVersion = info.version;
    runExclusiveDialog(async () => {
      const m = mt();
      const result = await showUpdateDialog({
        type: 'info',
        buttons: [m.download, m.later],
        defaultId: 0,
        cancelId: 1,
        message: formatMsg(m.updateAvailableMessage, { version: info.version }),
        detail: m.updateAvailableDetail,
      });
      if (result.response === 0) {
        getPrimaryWindow()?.setProgressBar(0.05);
        autoUpdater.downloadUpdate().catch((err) => {
          console.error('[updater] downloadUpdate failed:', err);
        });
      }
    });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    getPrimaryWindow()?.setProgressBar(progress.percent / 100);
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    getPrimaryWindow()?.setProgressBar(-1);
    runExclusiveDialog(async () => {
      const m = mt();
      const result = await showUpdateDialog({
        type: 'info',
        buttons: [m.restartNow, m.later],
        defaultId: 0,
        cancelId: 1,
        message: formatMsg(m.updateReadyMessage, { version: info.version }),
        detail: m.updateReadyDetail,
      });
      if (result.response === 0) {
        isQuitting = true;
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (err: Error) => {
    console.error('[updater]', err);
    pendingUpdateVersion = null;
    getPrimaryWindow()?.setProgressBar(-1);
  });
};

const checkForUpdatesAuto = () => {
  if (!canRunUpdater()) return;
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[updater] auto check failed:', err);
  });
};

const checkForUpdatesManual = async () => {
  if (!canRunUpdater()) return;
  // manual check는 유저가 명시적으로 눌렀으므로 dedup을 건너뛰어 항상 다이얼로그를 띄움
  pendingUpdateVersion = null;
  let updateFound = false;
  const markFound = () => { updateFound = true; };
  autoUpdater.once('update-available', markFound);
  try {
    await autoUpdater.checkForUpdates();
    if (updateFound) return;
    const m = mt();
    await showUpdateDialog({
      type: 'info',
      buttons: ['OK'],
      message: m.upToDateMessage,
      detail: formatMsg(m.upToDateDetail, { version: app.getVersion() }),
    });
  } catch (err) {
    console.error('[updater] manual check failed:', err);
    const m = mt();
    await showUpdateDialog({
      type: 'error',
      buttons: ['OK'],
      message: m.updateErrorMessage,
      detail: (err as Error).message,
    });
  } finally {
    autoUpdater.off('update-available', markFound);
  }
};

const startUpdateCheckTimer = () => {
  if (!canRunUpdater() || updateCheckTimer) return;
  updateCheckTimer = setInterval(checkForUpdatesAuto, UPDATE_CHECK_INTERVAL_MS);
};

const stopUpdateCheckTimer = () => {
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
};

// --- Local Server ---

const DEFAULT_PORT = 8022;

interface IServerHealth {
  app?: string;
  version?: string;
}

const getServerHealth = (port: number): Promise<IServerHealth | null> =>
  new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      res.on('end', () => {
        try {
          const data = JSON.parse(body) as IServerHealth;
          resolve(data.app === 'purplemux' ? data : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });

const getExistingLocalServerPort = async (): Promise<number | null> => {
  try {
    const raw = fs.readFileSync(PORT_FILE, 'utf-8').trim();
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0) return null;
    return (await getServerHealth(port)) ? port : null;
  } catch {
    return null;
  }
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitForExistingLocalServerToStop = async (timeoutMs?: number): Promise<boolean> => {
  const deadline = timeoutMs ? Date.now() + timeoutMs : null;
  while (await getExistingLocalServerPort()) {
    if (deadline && Date.now() >= deadline) return false;
    await delay(2000);
  }
  return true;
};

const AGENT_RESTART_TIMEOUT_MS = 30_000;

const getManagedServerPort = async (): Promise<number | null> => {
  if (!isServerLaunchAgentSupported().supported) return null;
  if (!getServerLaunchAgentStatus().loaded) return null;
  const port = await getExistingLocalServerPort();
  if (!port) return null;
  const health = await getServerHealth(port);
  if (health?.version === app.getVersion()) return port;

  // 버전 불일치(주로 자동 업데이트 직후) → 에이전트를 재시작해 새 버전 서버로 교체
  try {
    execFileSync('/bin/launchctl', ['kickstart', '-k', launchctlService()], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const deadline = Date.now() + AGENT_RESTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(1000);
    const restartedPort = await getExistingLocalServerPort();
    if (!restartedPort) continue;
    if ((await getServerHealth(restartedPort))?.version === app.getVersion()) return restartedPort;
  }
  return null;
};

const startLocalServer = async (): Promise<number> => {
  if (!cachedStart) {
    const appDir = process.env.__PMUX_APP_DIR!;
    const standaloneMods = path.join(appDir, '.next', 'standalone', 'node_modules');
    process.env.NODE_PATH = [standaloneMods, process.env.NODE_PATH].filter(Boolean).join(':');
    require('module').Module._initPaths(); // eslint-disable-line @typescript-eslint/no-require-imports
    const mod = await import(path.join(appDir, 'dist', 'server.js'));
    cachedStart = mod.start;
  }
  let result;
  try {
    result = await cachedStart!({ port: DEFAULT_PORT });
  } catch {
    result = await cachedStart!({ port: 0 });
  }
  serverShutdown = result.shutdown;
  localPort = result.port;
  process.title = 'purplemux';
  return result.port;
};

const stopLocalServer = async () => {
  if (serverShutdown) {
    await serverShutdown();
    serverShutdown = null;
    localPort = null;
  }
};

// --- Menu ---

const getServerLabel = (): string => {
  if (serverConfig.mode === 'remote') return serverConfig.remoteUrl || '';
  return localPort ? `localhost:${localPort}` : 'localhost';
};

const updateMenu = () => {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: mt().checkForUpdates, click: checkForUpdatesManual, enabled: canRunUpdater() },
        { type: 'separator' },
        { label: `${mt().server}: ${getServerLabel()}`, enabled: false },
        { label: mt().useLocalServer, type: 'radio', checked: serverConfig.mode === 'local', click: handleSwitchToLocal },
        { label: mt().connectRemoteServer, type: 'radio', checked: serverConfig.mode === 'remote', click: handleSwitchToRemote },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CommandOrControl+Shift+N',
          registerAccelerator: false,
          click: openNewWindow,
        },
        { type: 'separator' },
        { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'close' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

// --- Server Switching ---

const handleSwitchToLocal = async () => {
  if (serverConfig.mode === 'local') return;

  serverConfig = { mode: 'local' };
  writeServerConfig(serverConfig);

  try {
    const port = await startLocalServer();
    const url = `http://localhost:${port}`;
    for (const w of windows) w.loadURL(url);
  } catch (err) {
    console.error('[electron] Failed to start local server:', err);
  }
  updateMenu();
};

const handleSwitchToRemote = async () => {
  const parent = getPrimaryWindow();
  if (!parent) return;

  const url = await showServerPrompt(parent, serverConfig.remoteUrl, readRecentRemoteUrls(), removeRecentRemoteUrl);
  if (!url) {
    updateMenu();
    return;
  }

  await stopLocalServer();
  serverConfig = { mode: 'remote', remoteUrl: url };
  writeServerConfig(serverConfig);
  addRecentRemoteUrl(url);
  for (const w of windows) w.loadURL(url);
  updateMenu();
};

// --- Window ---

const getRestorePosition = (saved: IWindowState): { x?: number; y?: number } => {
  const hasPosition = saved.x != null && saved.y != null;
  if (hasPosition && isVisibleOnAnyDisplay({ x: saved.x!, y: saved.y!, width: saved.width, height: saved.height })) {
    return { x: saved.x, y: saved.y };
  }

  if (saved.displayId != null) {
    const target = screen.getAllDisplays().find((d) => d.id === saved.displayId);
    if (target) {
      const { x, y, width, height } = target.workArea;
      return {
        x: x + Math.floor((width - saved.width) / 2),
        y: y + Math.floor((height - saved.height) / 2),
      };
    }
  }

  return {};
};

const NEW_WINDOW_OFFSET = 32;

const createWindow = (url: string): BrowserWindow => {
  const saved = readWindowState();
  const pos = getRestorePosition(saved);
  const isFirstWindow = windows.size === 0;
  const offset = isFirstWindow ? 0 : (windows.size * NEW_WINDOW_OFFSET) % 200;

  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: pos.x != null ? pos.x + offset : undefined,
    y: pos.y != null ? pos.y + offset : undefined,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: resolveIsDark() ? '#09090b' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
  });

  windows.add(win);
  lastFocusedWindow = win;

  if (isFirstWindow) {
    if (saved.isMaximized) win.maximize();
    if (saved.isFullScreen) win.setFullScreen(true);
  }

  win.loadURL(url);

  win.on('focus', () => {
    lastFocusedWindow = win;
  });

  win.webContents.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });

  win.webContents.setWindowOpenHandler(({ url: linkUrl }) => {
    shell.openExternal(linkUrl);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, navigationUrl) => {
    const currentOrigin = new URL(win.webContents.getURL() || '').origin;
    const targetOrigin = new URL(navigationUrl).origin;
    if (currentOrigin !== targetOrigin) {
      event.preventDefault();
      shell.openExternal(navigationUrl);
    }
  });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const saveWindowState = () => {
    if (win.isDestroyed()) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const bounds = win.getNormalBounds();
      const currentDisplay = screen.getDisplayMatching(win.getBounds());
      writeWindowState({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: win.isMaximized(),
        isFullScreen: win.isFullScreen(),
        displayId: currentDisplay.id,
      });
    }, 500);
  };

  win.on('resize', saveWindowState);
  win.on('move', saveWindowState);
  win.on('maximize', saveWindowState);
  win.on('unmaximize', saveWindowState);
  win.on('enter-full-screen', saveWindowState);
  win.on('leave-full-screen', saveWindowState);

  win.on('close', (e) => {
    if (saveTimer) clearTimeout(saveTimer);
    const bounds = win.getNormalBounds();
    const currentDisplay = screen.getDisplayMatching(win.getBounds());
    writeWindowState({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: win.isMaximized(),
      isFullScreen: win.isFullScreen(),
      displayId: currentDisplay.id,
    });

    // darwin: hide only when this is the last remaining window
    if (process.platform === 'darwin' && !isQuitting && windows.size === 1 && windows.has(win)) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    windows.delete(win);
    if (lastFocusedWindow === win) lastFocusedWindow = null;
  });

  return win;
};

const openNewWindow = () => {
  const url = resolveCurrentUrl();
  if (!url) return;
  createWindow(url);
};

// --- Splash (Loading) Screen ---

const resolveIsDark = (): boolean => {
  const cfg = readAppConfig();
  const theme = cfg.appTheme || 'dark';
  if (theme === 'system') return nativeTheme.shouldUseDarkColors;
  return theme !== 'light';
};

const buildSplashHTML = (isDark: boolean): string => {
  const bg = isDark ? '#09090b' : '#ffffff';
  const spinner = isDark ? '#a09dc0' : '#807da8';
  const text = isDark ? '#52525b' : '#a1a1aa';
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const tags = pickTaglines(8).map(escape);
  const tagsJson = "['" + tags.join("','") + "']";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:${bg};display:flex;align-items:center;justify-content:center;height:100vh;-webkit-app-region:drag;font-family:'SF Mono','Fira Code','JetBrains Mono',monospace}
.container{text-align:center;user-select:none}
.spinner{font-size:20px;color:${spinner};height:28px;line-height:28px}
.word{font-size:12px;color:${text};margin-top:14px;height:20px}
</style></head><body><div class="container">
<div class="spinner" id="s"></div>
<div class="word" id="w"></div>
</div><script>
var sc=['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
var ws=${tagsJson};
var si=0,wi=0,ch=[],tg=[],rs=false,st=0;
var sEl=document.getElementById('s'),wEl=document.getElementById('w');
var pool='abcdefghijklmnopqrstuvwxyz.!?@#$%&*';
function go(){tg=ws[wi].split('');ch=tg.map(function(c){return c===' '?' ':pool[Math.floor(Math.random()*pool.length)]});rs=true;st=0;wi=(wi+1)%ws.length}
go();
setInterval(function(){sEl.textContent=sc[si];si=(si+1)%sc.length},80);
setInterval(function(){if(rs){if(st<tg.length){for(var i=0;i<ch.length;i++){if(i<=st){ch[i]=tg[i]}else if(tg[i]!==' '){ch[i]=pool[Math.floor(Math.random()*pool.length)]}}st+=2}else{for(var i=0;i<tg.length;i++){ch[i]=tg[i]}rs=false;setTimeout(go,1500)}}wEl.textContent=ch.join('')},40);
</script></body></html>`;
};

const loadSplash = (win: BrowserWindow) => {
  const html = buildSplashHTML(resolveIsDark());
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
};

// splash/about:blank 엔트리가 히스토리에 남으면 마우스 뒤로가기 버튼으로 복귀 불가 상태에 빠짐
const clearSplashHistory = (win: BrowserWindow) => {
  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) win.webContents.navigationHistory.clear();
  });
};

const prepareLocalServerEnv = () => {
  process.env.NODE_ENV = 'production';
  process.env.__PMUX_ELECTRON = '1';
  const appPath = app.getAppPath();
  process.env.__PMUX_APP_DIR = isDev ? process.cwd() : appPath;
  process.env.__PMUX_APP_DIR_UNPACKED = isDev ? process.cwd() : appPath.replace('app.asar', 'app.asar.unpacked');
};

// --- Bootstrap ---

const bootstrap = async () => {
  // Finder/Dock 런치 시 launchd env가 빈약해 child shell이 초기화에 실패함.
  // shell resolve는 100~500ms 걸리므로 splash 렌더와 오버랩시키고,
  // 로컬 서버 spawn 직전에만 완료를 대기한다.
  fixEnv();
  initBrowserBridge();
  const shellEnvReady = applyResolvedShellEnv().then(capturePristineEnv);

  if (devUrl) {
    await shellEnvReady;
    createWindow(devUrl);
    return;
  }

  prepareLocalServerEnv();

  serverConfig = readServerConfig();
  currentLocale = readLocaleFromConfig();

  // macOS: nativeTheme을 앱 테마와 동기화해야 비활성 트래픽 라이트가 올바른 대비로 렌더링됨
  const appTheme = readAppConfig().appTheme || 'dark';
  nativeTheme.themeSource = appTheme as 'dark' | 'light' | 'system';

  if (serverConfig.mode === 'remote' && serverConfig.remoteUrl) {
    const win = createWindow('about:blank');
    loadSplash(win);
    await shellEnvReady;
    win.loadURL(serverConfig.remoteUrl);
    clearSplashHistory(win);
  } else {
    serverConfig = { mode: 'local' };
    // 윈도우를 먼저 띄우고 로딩 화면을 보여준 뒤, 서버가 준비되면 전환
    const win = createWindow('about:blank');
    loadSplash(win);
    await shellEnvReady;
    const existingPort = await getManagedServerPort();
    const port = existingPort ?? await startLocalServer();
    if (existingPort) localPort = existingPort;
    win.loadURL(`http://localhost:${port}`);
    clearSplashHistory(win);
  }

  updateMenu();

  setupAutoUpdater();
  // 메인 윈도우 로딩이 끝나기 전에 다이얼로그가 뜨지 않도록 첫 체크를 지연
  setTimeout(checkForUpdatesAuto, FIRST_CHECK_DELAY_MS);
  startUpdateCheckTimer();
};

const VALID_URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const BLOCKED_SCHEME = /^(javascript|data|vbscript|blob|file|about|view-source):/i;

ipcMain.handle('open-external', (_event, url: string) => {
  if (typeof url !== 'string') return;
  if (!VALID_URI_SCHEME.test(url) || BLOCKED_SCHEME.test(url)) return;
  shell.openExternal(url);
});

ipcMain.handle('set-native-theme', (_event, theme: string) => {
  if (theme === 'dark' || theme === 'light' || theme === 'system') {
    nativeTheme.themeSource = theme;
  }
});

ipcMain.handle('set-locale', (_event, locale: string) => {
  if (typeof locale === 'string' && locale !== currentLocale) {
    currentLocale = locale;
    updateMenu();
  }
});

// --- Native Notifications ---

ipcMain.handle('show-notification', (event, title: string, body: string) => {
  const anyFocused = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
  if (anyFocused) return false;
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const notification = new Notification({ title, body });
  notification.on('click', () => {
    const target = senderWin && !senderWin.isDestroyed() ? senderWin : getPrimaryWindow();
    target?.show();
    target?.focus();
    target?.webContents.send('notification-click');
  });
  notification.show();
  return true;
});

ipcMain.handle('open-new-window', () => {
  openNewWindow();
});

ipcMain.handle('set-dock-badge', (_event, count: number) => {
  if (process.platform !== 'darwin') return;
  app.dock.setBadge(count > 0 ? String(count) : '');
});

ipcMain.handle('server-launch-agent:get-status', (event) => {
  assertLocalRenderer(event);
  return getServerLaunchAgentStatus();
});

ipcMain.handle('server-launch-agent:set-enabled', (event, enabled: boolean) => {
  assertLocalRenderer(event);
  if (typeof enabled !== 'boolean') {
    throw new Error('enabled must be a boolean');
  }
  return setServerLaunchAgentEnabled(enabled);
});

// --- System Resources ---

ipcMain.handle('get-system-resources', () => {
  const metrics = app.getAppMetrics();
  let cpuTotal = 0;
  let memTotal = 0;
  for (const m of metrics) {
    cpuTotal += m.cpu.percentCPUUsage;
    memTotal += m.memory.workingSetSize * 1024; // KB → bytes
  }

  return {
    cpu: cpuTotal,
    memory: { used: memTotal },
  };
});

app.on('ready', bootstrap);

app.on('activate', () => {
  const primary = getPrimaryWindow();
  if (primary) {
    primary.show();
    primary.focus();
  } else if (!devUrl) {
    bootstrap();
  }
});

app.on('window-all-closed', async () => {
  if (process.platform === 'darwin') return;

  // 안전장치: 전체 종료가 3초 이내에 완료되지 않으면 강제 종료
  const forceExit = setTimeout(() => app.exit(1), 3000);

  stopUpdateCheckTimer();

  // 1) PTY onExit 콜백이 완료될 때까지 대기 → native ThreadSafeFunction drain
  if (serverShutdown) {
    await serverShutdown();
    serverShutdown = null;
  }

  // 2) 스토리지 flush (localStorage + 쿠키)
  await session.defaultSession?.flushStorageData()?.catch(() => {});
  await session.defaultSession?.cookies?.flushStore()?.catch(() => {});

  // 3) 모든 cleanup 완료 후 종료.
  //    app.exit()는 FreeEnvironment를 건너뛰어
  //    node-pty ThreadSafeFunction release 시 abort() 방지.
  clearTimeout(forceExit);
  app.exit(0);
});

// Cmd+Q 등으로 will-quit이 먼저 도달하는 경우,
// window-all-closed와 동일한 graceful shutdown 수행.
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', async (event) => {
  event.preventDefault();
  const forceExit = setTimeout(() => app.exit(1), 3000);

  stopUpdateCheckTimer();

  if (serverShutdown) {
    await serverShutdown();
    serverShutdown = null;
  }

  await session.defaultSession?.flushStorageData()?.catch(() => {});
  await session.defaultSession?.cookies?.flushStore()?.catch(() => {});
  clearTimeout(forceExit);
  app.exit(0);
});

app.requestSingleInstanceLock();
app.on('second-instance', () => {
  const primary = getPrimaryWindow();
  if (primary) {
    if (primary.isMinimized()) primary.restore();
    primary.show();
    primary.focus();
  }
});
