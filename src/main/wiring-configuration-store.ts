import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { WiringConfiguration } from "../shared/model";
import {
  isBuiltinWiringConfigurationId,
  parseWiringConfiguration,
} from "../shared/wiring-configurations";

export const MAX_WIRING_CONFIGURATION_BYTES = 64 * 1024;
export const MAX_WIRING_LIBRARY_BYTES = 2 * 1024 * 1024;
export const MAX_WIRING_CONFIGURATIONS = 100;

// A single Electron main process owns the library. Share the queue across
// instances too, so callers cannot lose another save during read/modify/write.
const queues = new Map<string, Promise<void>>();

const isBuiltin = isBuiltinWiringConfigurationId;

function validateId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
  )
    throw new Error(
      "Wiring configuration ID must contain 1–128 letters, numbers, dots, underscores, colons, or hyphens",
    );
}

/** IPC input and imported files both cross the same validation boundary. */
export function checkedWiringConfiguration(
  value: unknown,
): WiringConfiguration {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error("Wiring configuration must be a JSON object");
  }
  if (!text || Buffer.byteLength(text, "utf8") > MAX_WIRING_CONFIGURATION_BYTES)
    throw new Error("Wiring configuration exceeds the 64 KB limit");
  const configuration = parseWiringConfiguration(JSON.parse(text));
  validateId(configuration.id);
  if (
    typeof configuration.name !== "string" ||
    !configuration.name.trim() ||
    configuration.name.length > 200
  )
    throw new Error("Wiring configuration name must contain 1–200 characters");
  return structuredClone(configuration);
}

export class WiringConfigurationStore {
  private readonly filename: string;
  private readonly queueKey: string;

  constructor(filename: string) {
    this.filename = path.resolve(filename);
    this.queueKey =
      process.platform === "win32"
        ? this.filename.toLowerCase()
        : this.filename;
  }

  list(): Promise<WiringConfiguration[]> {
    return this.serialized(() => this.readLibrary());
  }

  async save(value: unknown): Promise<WiringConfiguration> {
    const configuration = checkedWiringConfiguration(value);
    if (isBuiltin(configuration.id))
      return Promise.reject(
        new Error(
          "Built-in wiring configurations cannot be replaced; save a named copy instead",
        ),
      );
    return this.serialized(async () => {
      const configurations = await this.readLibrary();
      const index = configurations.findIndex(
        (item) => item.id === configuration.id,
      );
      if (index >= 0) configurations[index] = configuration;
      else configurations.push(configuration);
      await this.writeLibrary(configurations);
      return configuration;
    });
  }

  async delete(id: unknown): Promise<void> {
    validateId(id);
    if (isBuiltin(id))
      return Promise.reject(
        new Error("Built-in wiring configurations cannot be deleted"),
      );
    return this.serialized(async () => {
      const configurations = await this.readLibrary();
      const remaining = configurations.filter(
        (configuration) => configuration.id !== id,
      );
      if (remaining.length !== configurations.length)
        await this.writeLibrary(remaining);
    });
  }

  /** Import adds a reusable copy; it never silently replaces an existing item. */
  async importFile(filename: string): Promise<WiringConfiguration> {
    const configuration = checkedWiringConfiguration(
      await readJsonFile(
        filename,
        MAX_WIRING_CONFIGURATION_BYTES,
        "Wiring configuration",
      ),
    );
    return this.serialized(async () => {
      const configurations = await this.readLibrary();
      if (
        isBuiltin(configuration.id) ||
        configurations.some((item) => item.id === configuration.id)
      )
        configuration.id = `user-${randomUUID()}`;
      configurations.push(configuration);
      await this.writeLibrary(configurations);
      return configuration;
    });
  }

  async exportFile(value: unknown, filename: string): Promise<string> {
    const configuration = checkedWiringConfiguration(value);
    const resolved = path.resolve(filename);
    const comparison =
      process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (comparison === this.queueKey)
      throw new Error(
        "Choose a separate export file, not the wiring configuration library",
      );
    await atomicWrite(resolved, `${JSON.stringify(configuration, null, 2)}\n`);
    return resolved;
  }

  private async readLibrary(): Promise<WiringConfiguration[]> {
    let value: unknown;
    try {
      value = await readJsonFile(
        this.filename,
        MAX_WIRING_LIBRARY_BYTES,
        "Wiring configuration library",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(
        "Invalid wiring configuration library; the existing file was not changed",
      );
    const library = value as { version?: unknown; configurations?: unknown };
    if (
      library.version !== 1 ||
      !Array.isArray(library.configurations) ||
      library.configurations.length > MAX_WIRING_CONFIGURATIONS
    )
      throw new Error(
        "Unsupported or invalid wiring configuration library; the existing file was not changed",
      );
    const configurations = library.configurations.map(
      checkedWiringConfiguration,
    );
    const ids = new Set<string>();
    for (const configuration of configurations) {
      if (ids.has(configuration.id) || isBuiltin(configuration.id))
        throw new Error(
          "Wiring configuration library contains duplicate or reserved IDs; the existing file was not changed",
        );
      ids.add(configuration.id);
    }
    return configurations;
  }

  private async writeLibrary(configurations: WiringConfiguration[]) {
    if (configurations.length > MAX_WIRING_CONFIGURATIONS)
      throw new Error(
        `The wiring configuration library is limited to ${MAX_WIRING_CONFIGURATIONS} configurations`,
      );
    const text = `${JSON.stringify({ version: 1, configurations }, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_WIRING_LIBRARY_BYTES)
      throw new Error(
        "The wiring configuration library exceeds the 2 MB limit",
      );
    await atomicWrite(this.filename, text);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.queueKey) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(this.queueKey, settled);
    void settled.then(() => {
      if (queues.get(this.queueKey) === settled) queues.delete(this.queueKey);
    });
    return result;
  }
}

async function readJsonFile(
  filename: string,
  maxBytes: number,
  label: string,
): Promise<unknown> {
  const metadata = await stat(filename);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  if (metadata.size > maxBytes) throw new Error(`${label} file is too large`);
  const text = await readFile(filename, "utf8");
  if (Buffer.byteLength(text, "utf8") > maxBytes)
    throw new Error(`${label} file is too large`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${label} contains invalid JSON; the existing file was not changed`,
    );
  }
}

async function atomicWrite(filename: string, text: string) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
