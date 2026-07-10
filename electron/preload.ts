import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getSystemResources: () => ipcRenderer.invoke('get-system-resources'),
  showNotification: (title: string, body: string) => ipcRenderer.invoke('show-notification', title, body),
  openNewWindow: () => ipcRenderer.invoke('open-new-window'),
  setDockBadge: (count: number) => ipcRenderer.invoke('set-dock-badge', count),
  getServerLaunchAgentStatus: () => ipcRenderer.invoke('server-launch-agent:get-status'),
  setServerLaunchAgentEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('server-launch-agent:set-enabled', enabled),
  setLocale: (locale: string) => ipcRenderer.invoke('set-locale', locale),
  setNativeTheme: (theme: string) => ipcRenderer.invoke('set-native-theme', theme),
  registerBrowserTab: (tabId: string, webContentsId: number) =>
    ipcRenderer.invoke('browser:register', tabId, webContentsId),
  unregisterBrowserTab: (tabId: string) =>
    ipcRenderer.invoke('browser:unregister', tabId),
  setBrowserDeviceEmulation: (
    tabId: string,
    config: {
      width: number;
      height: number;
      deviceScaleFactor: number;
      mobile: boolean;
      userAgent?: string;
      orientation?: 'portrait' | 'landscape';
    } | null,
  ) => ipcRenderer.invoke('browser:set-device-emulation', tabId, config),
  onNotificationClick: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('notification-click', handler);
    return () => { ipcRenderer.removeListener('notification-click', handler); };
  },
});
