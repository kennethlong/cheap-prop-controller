import type {
  BoardId,
  IrCommand,
  IrSignal,
  MediaTrack,
  SceneProject,
  WiringConfiguration,
} from "./shared/model";
export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
}
export interface DeviceReply {
  type: string;
  [key: string]: unknown;
}
export interface ProjectFile {
  project: SceneProject;
  path: string;
}
export interface DeviceStatus {
  connected: boolean;
  port?: string;
  hello?: DeviceReply;
}
export interface DesktopAPI {
  listPorts(): Promise<PortInfo[]>;
  connect(port: string): Promise<DeviceReply>;
  disconnect(): Promise<void>;
  getDeviceStatus(): Promise<DeviceStatus>;
  deviceCommand(command: string): Promise<DeviceReply>;
  learnIr(): Promise<IrSignal>;
  testIr(command: IrCommand): Promise<DeviceReply>;
  cancelIr(): Promise<DeviceReply>;
  beginOutputTest(expectedScene: number[]): Promise<DeviceReply>;
  setTestOutputs(mask: number): Promise<DeviceReply>;
  endOutputTest(): Promise<DeviceReply>;
  uploadScene(bytes: number[]): Promise<DeviceReply>;
  flashFirmware(
    board: BoardId,
    port: string,
    variant?: "default" | "old-bootloader",
  ): Promise<{ success: boolean; log: string }>;
  openProject(): Promise<ProjectFile | null>;
  saveProject(
    project: SceneProject,
    saveAs?: boolean,
  ): Promise<ProjectFile | null>;
  listWiringConfigurations?(): Promise<WiringConfiguration[]>;
  saveWiringConfiguration?(
    configuration: WiringConfiguration,
  ): Promise<WiringConfiguration>;
  deleteWiringConfiguration?(id: string): Promise<void>;
  importWiringConfiguration?(): Promise<WiringConfiguration | null>;
  exportWiringConfiguration?(
    configuration: WiringConfiguration,
  ): Promise<string | null>;
  importAudio(trackNumber: number): Promise<MediaTrack | null>;
  readAudio(path: string): Promise<{ dataUrl: string }>;
  saveTrimmedAudio(
    track: MediaTrack,
  ): Promise<{ path: string; projectCopyPath?: string } | null>;
  exportMedia(
    project: SceneProject,
  ): Promise<{ directory: string; files: number } | null>;
  onDeviceLog(callback: (line: string) => void): () => void;
  onDeviceStatus(callback: (status: DeviceStatus) => void): () => void;
}
declare global {
  interface Window {
    cpc?: DesktopAPI;
  }
}
