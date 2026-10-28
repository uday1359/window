/**
 * The only bridge between the dashboard and the desktop shell: desktop notifications.
 * No Node APIs, file system or shell access are exposed to the web page.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('winagentDesktop', {
  notify: (title: string, body: string): Promise<boolean> => ipcRenderer.invoke('winagent:notify', String(title), String(body)),
});
