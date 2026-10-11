import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI } from "../desktop-api";
const api: DesktopAPI = {
  listPorts: () => ipcRenderer.invoke("device:list"),
  connect: (port) => ipcRenderer.invoke("device:connect", port),
  disconnect: () => ipcRenderer.invoke("device:disconnect"),
  getDeviceStatus: () => ipcRenderer.invoke("device:get-status"),
  deviceCommand: (command) => ipcRenderer.invoke("device:command", command),
  learnIr: () => ipcRenderer.invoke("device:ir-learn"),
  testIr: (command) => ipcRenderer.invoke("device:ir-test", command),
  cancelIr: () => ipcRenderer.invoke("device:ir-cancel"),
  uploadScene: (bytes) => ipcRenderer.invoke("device:upload", bytes),
  flashFirmware: (board, port, variant) =>
    ipcRenderer.invoke("device:flash", board, port, variant),
  openProject: () => ipcRenderer.invoke("project:open"),
  saveProject: (project, saveAs) =>
    ipcRenderer.invoke("project:save", project, saveAs),
  importAudio: (number) => ipcRenderer.invoke("media:import", number),
  readAudio: (path) => ipcRenderer.invoke("media:read", path),
  saveTrimmedAudio: (track) => ipcRenderer.invoke("media:save-trimmed", track),
  exportMedia: (project) => ipcRenderer.invoke("media:export", project),
  onDeviceLog: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, line: string) =>
      callback(line);
    ipcRenderer.on("device:log", listener);
    return () => ipcRenderer.removeListener("device:log", listener);
  },
  onDeviceStatus: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: Parameters<Parameters<DesktopAPI["onDeviceStatus"]>[0]>[0],
    ) => callback(status);
    ipcRenderer.on("device:status", listener);
    return () => ipcRenderer.removeListener("device:status", listener);
  },
};
contextBridge.exposeInMainWorld("cpc", api);
