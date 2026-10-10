import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SerialService } from "./serial-service";
import { ProjectStore } from "./project-store";
import { flashFirmware } from "./firmware";
import type { BoardId, MediaTrack } from "../shared/model";

const serial = new SerialService();
const toolsRoot = app.isPackaged
  ? path.join(process.resourcesPath, "tools")
  : path.join(app.getAppPath(), "resources");
const projects = new ProjectStore({
  ffmpegPath: path.join(
    toolsRoot,
    "ffmpeg",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  ),
});
let window: BrowserWindow | undefined;
let flashing = false;
const devURL = !app.isPackaged ? process.env.CPC_DEV_URL : undefined;
const indexPath = path.join(app.getAppPath(), "dist", "index.html");
function guard(event: IpcMainInvokeEvent) {
  const url = event.senderFrame?.url;
  if (
    !window ||
    event.sender !== window.webContents ||
    (url !== pathToFileURL(indexPath).href &&
      !(devURL && url?.startsWith(`${devURL}/`)))
  )
    throw new Error("Untrusted application frame");
}
function handle(name: string, callback: (...args: any[]) => unknown) {
  ipcMain.handle(name, (event, ...args) => {
    guard(event);
    return callback(...args);
  });
}
function available() {
  if (flashing) throw new Error("Wait for firmware installation to finish");
}
function emit(channel: string, payload: unknown) {
  if (window && !window.isDestroyed())
    window.webContents.send(channel, payload);
}
serial.on("log", (line) => emit("device:log", line));
serial.on("status", (status) => emit("device:status", status));

handle("device:list", () => serial.list());
handle("device:connect", (port: string) => {
  available();
  return serial.connect(port);
});
handle("device:disconnect", () => serial.disconnect());
handle("device:command", (command: string) => {
  available();
  return serial.command(command);
});
handle("device:upload", (bytes: number[]) => {
  available();
  return serial.upload(bytes);
});
handle(
  "device:flash",
  async (board: BoardId, port: string, variant?: string) => {
    available();
    flashing = true;
    try {
      await serial.disconnect();
      const root = app.isPackaged
        ? path.join(process.resourcesPath, "tools")
        : path.join(app.getAppPath(), "resources");
      return await flashFirmware(root, board, port, variant, (line) =>
        emit("device:log", line),
      );
    } finally {
      flashing = false;
    }
  },
);
handle("project:open", async () => {
  const result = await dialog.showOpenDialog(window!, {
    title: "Open scene project",
    properties: ["openFile"],
    filters: [{ name: "Controller project", extensions: ["json"] }],
  });
  return result.canceled ? null : projects.open(result.filePaths[0]);
});
handle("project:save", async (project: unknown, saveAs = false) => {
  let filename = projects.currentPath;
  if (!filename || saveAs) {
    const result = await dialog.showSaveDialog(window!, {
      title: "Save scene project",
      defaultPath:
        filename ?? path.join(app.getPath("documents"), "My scene.cpc.json"),
      filters: [{ name: "Controller project", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return null;
    filename = result.filePath;
  }
  return projects.save(project, filename);
});
handle("media:import", async (number: number) => {
  if (!Number.isInteger(number) || number < 1 || number > 255)
    throw new Error("Track number must be 1–255");
  const result = await dialog.showOpenDialog(window!, {
    title: `Choose MP3 for track ${number}`,
    properties: ["openFile"],
    filters: [{ name: "MP3 audio", extensions: ["mp3"] }],
  });
  if (result.canceled) return null;
  const filename = result.filePaths[0];
  projects.grantAudio(filename);
  return { number, name: path.basename(filename), path: filename };
});
handle("media:read", (filename: string) => projects.readAudio(filename));
handle("media:save-trimmed", async (track: MediaTrack) => {
  if (!track || typeof track.path !== "string")
    throw new Error("Choose an audio file before saving a clip");
  const source = path.isAbsolute(track.path)
    ? track.path
    : path.resolve(
        projects.currentPath
          ? path.dirname(projects.currentPath)
          : app.getPath("documents"),
        track.path,
      );
  const sourceName = path.parse(source).name;
  const result = await dialog.showSaveDialog(window!, {
    title: "Save trimmed MP3",
    defaultPath: path.join(path.dirname(source), `${sourceName}-trimmed.mp3`),
    filters: [{ name: "MP3 audio", extensions: ["mp3"] }],
  });
  if (result.canceled || !result.filePath) return null;
  return projects.saveTrimmedAudio(track, result.filePath);
});
handle("media:export", async (project: unknown) => {
  const result = await dialog.showOpenDialog(window!, {
    title: "Choose MP3 card or export folder (writes numbered files in 01)",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled) return null;
  const confirm = await dialog.showMessageBox(window!, {
    type: "question",
    buttons: ["Export MP3s", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: "Export numbered audio files?",
    detail:
      "Files with the same numbers in the 01 folder will be replaced. Repeat this export for each audio module’s card.",
  });
  if (confirm.response !== 0) return null;
  return projects.exportMedia(project, result.filePaths[0]);
});

function createWindow() {
  window = new BrowserWindow({
    show: process.env.CPC_TEST_HIDDEN !== "1",
    width: 1500,
    height: 960,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: "#10141c",
    title: "Cheap Prop Controller",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(window!, {
      type: "question",
      buttons: ["Keep editing", "Discard changes and close"],
      defaultId: 0,
      cancelId: 0,
      message: "This project has unsaved changes.",
    });
    if (choice === 1) event.preventDefault();
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (
      url !== pathToFileURL(indexPath).href &&
      !(devURL && url.startsWith(`${devURL}/`))
    )
      event.preventDefault();
  });
  if (devURL) void window.loadURL(devURL);
  else void window.loadFile(indexPath);
  window.on("closed", () => {
    window = undefined;
    void serial.disconnect();
  });
}
app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (!BrowserWindow.getAllWindows().length) createWindow();
});
