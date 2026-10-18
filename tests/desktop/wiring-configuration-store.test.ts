import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WiringConfiguration } from "../../src/shared/model";
import { BUILT_IN_WIRING_CONFIGURATIONS } from "../../src/shared/wiring-configurations";
import {
  MAX_WIRING_CONFIGURATION_BYTES,
  MAX_WIRING_CONFIGURATIONS,
  MAX_WIRING_LIBRARY_BYTES,
  WiringConfigurationStore,
} from "../../src/main/wiring-configuration-store";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("cpc-wiring-test-")
    )
      throw new Error(
        "Refusing to remove a path outside the wiring test temporary folder",
      );
    await rm(resolved, { recursive: true, force: true });
  }
});

function configuration(id = "user-bench"): WiringConfiguration {
  return {
    version: 1,
    id,
    name: "My bench wiring",
    board: "uno",
    outputs: [
      {
        id: "relay",
        name: "Relay",
        pin: 7,
        activeLow: false,
        idleActive: false,
        color: "#ef4444",
      },
    ],
    triggers: [
      {
        id: "beam",
        name: "Beam",
        kind: "button",
        pin: 10,
        echoPin: null,
        activeLow: true,
        pullup: true,
        debounceMs: 50,
        thresholdCm: 100,
        hysteresisCm: 5,
      },
    ],
    players: [{ id: "player", kind: "dfplayer", txPin: 3, rxPin: 8 }],
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpc-wiring-test-"));
  temporary.push(root);
  const filename = path.join(root, "settings", "wiring-configurations.json");
  return {
    root,
    filename,
    store: new WiringConfigurationStore(filename),
    create: () => new WiringConfigurationStore(filename),
  };
}

describe("wiring configuration library", () => {
  it("starts empty without creating a file and persists save, replace, and delete across instances", async () => {
    const test = await fixture();
    expect(await test.store.list()).toEqual([]);
    await expect(stat(test.filename)).rejects.toMatchObject({ code: "ENOENT" });
    const original = configuration();
    expect(await test.store.save(original)).toEqual(original);
    expect(await test.create().list()).toEqual([original]);
    const renamed = { ...original, name: "Renamed bench" };
    await test.create().save(renamed);
    expect(await test.store.list()).toEqual([renamed]);
    await test.store.delete(original.id);
    expect(await test.create().list()).toEqual([]);
    expect(await readdir(path.dirname(test.filename))).toEqual([
      path.basename(test.filename),
    ]);
  });

  it("serializes saves and deletes across instances without losing changes", async () => {
    const test = await fixture();
    const a = test.store.save(configuration("user-a"));
    const b = test.create().save(configuration("user-b"));
    const remove = test.store.delete("user-a");
    const c = test.create().save(configuration("user-c"));
    const listed = test.store.list();
    await Promise.all([a, b, remove, c]);
    expect((await listed).map((item) => item.id)).toEqual(["user-b", "user-c"]);
  });

  it("snapshots inputs and returns independent library objects", async () => {
    const test = await fixture();
    const original = configuration();
    const pending = test.store.save(original);
    original.outputs[0].pin = 6;
    const saved = await pending;
    expect(saved.outputs[0].pin).toBe(7);
    saved.name = "Changed outside store";
    const listed = await test.store.list();
    listed[0].outputs[0].pin = 6;
    expect((await test.store.list())[0]).toEqual(configuration());
  });

  it("does not allow built-in configurations to be overwritten or deleted", async () => {
    const test = await fixture();
    const builtin = BUILT_IN_WIRING_CONFIGURATIONS[0];
    await expect(test.store.save(builtin)).rejects.toThrow("Built-in");
    await expect(test.store.delete(builtin.id)).rejects.toThrow("Built-in");
    expect(await test.store.list()).toEqual([]);
  });

  it.each(["", "../other", "C:\\other", "some/name", " ", "a".repeat(129)])(
    "rejects unsafe or empty IDs (%s)",
    async (id) => {
      const test = await fixture();
      await expect(
        test.store.save({ ...configuration(), id }),
      ).rejects.toThrow();
      await expect(test.store.delete(id)).rejects.toThrow();
      expect(await readdir(test.root)).toEqual([]);
    },
  );

  it.each(["", "   ", "a".repeat(201)])(
    "rejects invalid names without creating the library (%s)",
    async (name) => {
      const test = await fixture();
      await expect(
        test.store.save({ ...configuration(), name }),
      ).rejects.toThrow();
      expect(await test.store.list()).toEqual([]);
    },
  );

  it("enforces the library count while still allowing replacement", async () => {
    const test = await fixture();
    const configurations = Array.from(
      { length: MAX_WIRING_CONFIGURATIONS },
      (_, i) => configuration(`user-${i}`),
    );
    await mkdir(path.dirname(test.filename));
    await writeFile(
      test.filename,
      JSON.stringify({ version: 1, configurations }),
    );
    await expect(
      test.store.save(configuration("user-over-limit")),
    ).rejects.toThrow("limited to");
    await test.store.save({ ...configurations[0], name: "Replaced at limit" });
    const listed = await test.store.list();
    expect(listed).toHaveLength(MAX_WIRING_CONFIGURATIONS);
    expect(listed[0].name).toBe("Replaced at limit");
  });

  it.each([
    "{broken json",
    JSON.stringify({ version: 2, configurations: [] }),
    JSON.stringify({
      version: 1,
      configurations: [configuration(), configuration()],
    }),
    JSON.stringify({
      version: 1,
      configurations: [{ ...configuration(), board: "unsupported" }],
    }),
  ])(
    "surfaces a corrupt or unsupported library and preserves it",
    async (text) => {
      const test = await fixture();
      await mkdir(path.dirname(test.filename));
      await writeFile(test.filename, text);
      await expect(test.store.list()).rejects.toThrow();
      await expect(test.store.save(configuration("another"))).rejects.toThrow();
      await expect(test.store.delete("user-bench")).rejects.toThrow();
      expect(await readFile(test.filename, "utf8")).toBe(text);
      expect(await readdir(path.dirname(test.filename))).toEqual([
        path.basename(test.filename),
      ]);
    },
  );

  it("bounds library reads and recovers the queue after a failure", async () => {
    const test = await fixture();
    await mkdir(path.dirname(test.filename));
    await writeFile(test.filename, " ".repeat(MAX_WIRING_LIBRARY_BYTES + 1));
    await expect(test.store.list()).rejects.toThrow("too large");
    await writeFile(
      test.filename,
      JSON.stringify({ version: 1, configurations: [] }),
    );
    await test.store.save(configuration());
    expect(await test.store.list()).toHaveLength(1);
  });

  it("reports IO errors instead of treating an unreadable location as an empty library", async () => {
    const test = await fixture();
    await mkdir(test.filename, { recursive: true });
    await expect(test.store.list()).rejects.toThrow("regular file");
    await expect(test.store.save(configuration())).rejects.toThrow(
      "regular file",
    );
    expect((await stat(test.filename)).isDirectory()).toBe(true);
    expect(await readdir(test.filename)).toEqual([]);
  });
});

describe("standalone wiring configuration import and export", () => {
  it("exports a reusable JSON file and imports it without changing scene files", async () => {
    const test = await fixture();
    const filename = path.join(test.root, "My bench.cpc-wiring.json");
    expect(await test.store.exportFile(configuration(), filename)).toBe(
      filename,
    );
    expect(JSON.parse(await readFile(filename, "utf8"))).toEqual(
      configuration(),
    );
    expect(await test.store.list()).toEqual([]);
    const imported = await test.store.importFile(filename);
    expect(imported).toEqual(configuration());
    expect(await test.create().list()).toEqual([imported]);
  });

  it("assigns a new user ID on collision and preserves the original item", async () => {
    const test = await fixture();
    await test.store.save(configuration());
    const filename = path.join(test.root, "replacement.cpc-wiring.json");
    const incoming = { ...configuration(), name: "Imported replacement" };
    await test.store.exportFile(incoming, filename);
    const imported = await test.store.importFile(filename);
    expect(imported.id).not.toBe(incoming.id);
    expect(imported.name).toBe(incoming.name);
    const listed = await test.store.list();
    expect(listed).toEqual([configuration(), imported]);
  });

  it("imports an exported built-in as a user copy", async () => {
    const test = await fixture();
    const builtin = BUILT_IN_WIRING_CONFIGURATIONS[0];
    const filename = path.join(test.root, "standard.cpc-wiring.json");
    await test.store.exportFile(builtin, filename);
    const imported = await test.store.importFile(filename);
    expect(imported.id).not.toBe(builtin.id);
    expect({ ...imported, id: builtin.id }).toEqual(builtin);
    await test.store.delete(imported.id);
    expect(await test.store.list()).toEqual([]);
  });

  it.each([
    "{broken",
    JSON.stringify({ ...configuration(), version: 99 }),
    JSON.stringify({
      ...configuration(),
      outputs: [{ ...configuration().outputs[0], pin: 200 }],
    }),
    JSON.stringify({
      ...configuration(),
      triggers: [{ ...configuration().triggers[0], pin: 7 }],
    }),
    " ".repeat(MAX_WIRING_CONFIGURATION_BYTES + 1),
  ])(
    "rejects malformed, unsupported, conflicting, or oversized imports",
    async (text) => {
      const test = await fixture();
      await test.store.save(configuration());
      const before = await readFile(test.filename, "utf8");
      const filename = path.join(test.root, "invalid.cpc-wiring.json");
      await writeFile(filename, text);
      await expect(test.store.importFile(filename)).rejects.toThrow();
      expect(await readFile(test.filename, "utf8")).toBe(before);
      expect(await readFile(filename, "utf8")).toBe(text);
    },
  );

  it("rejects non-JSON and excessive IPC input", async () => {
    const test = await fixture();
    const cyclic: any = configuration();
    cyclic.cycle = cyclic;
    await expect(test.store.save(cyclic)).rejects.toThrow("JSON object");
    await expect(
      test.store.save({
        ...configuration(),
        padding: "x".repeat(MAX_WIRING_CONFIGURATION_BYTES),
      }),
    ).rejects.toThrow("64 KB");
    expect(await test.store.list()).toEqual([]);
  });

  it("cannot export over the library and cleans temporary files after a failed replacement", async () => {
    const test = await fixture();
    await test.store.save(configuration());
    const before = await readFile(test.filename, "utf8");
    await expect(
      test.store.exportFile(configuration(), test.filename),
    ).rejects.toThrow("separate export file");
    expect(await readFile(test.filename, "utf8")).toBe(before);
    const destination = path.join(test.root, "existing-directory");
    await mkdir(destination);
    await expect(
      test.store.exportFile(configuration(), destination),
    ).rejects.toThrow();
    expect((await readdir(test.root)).sort()).toEqual([
      "existing-directory",
      "settings",
    ]);
  });
});
