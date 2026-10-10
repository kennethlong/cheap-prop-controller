import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProjectStore } from "../../src/main/project-store";
import { createDefaultProject } from "../../src/shared/index";
const temporary: string[] = [];
afterEach(async () => {
  for (const folder of temporary.splice(0)) {
    const resolved = path.resolve(folder);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("cpc-store-test-")
    )
      throw new Error(
        "Refusing to remove a path outside the test temporary folder",
      );
    await rm(resolved, { recursive: true, force: true });
  }
});
async function folder() {
  const value = await mkdtemp(path.join(os.tmpdir(), "cpc-store-test-"));
  temporary.push(value);
  return value;
}
describe("project file and media persistence", () => {
  it("saves portable audio assets, opens them, and exports numbered card files", async () => {
    const root = await folder();
    const source = path.join(root, "original.mp3");
    const content = Buffer.from("ID3fixture");
    await writeFile(source, content);
    const store = new ProjectStore();
    store.grantAudio(source);
    const project = createDefaultProject();
    project.audio.tracks = [{ number: 3, name: "Scare", path: source }];
    const saved = await store.save(project, path.join(root, "show.cpc.json"));
    expect(saved.project.audio.tracks[0].path).toMatch(
      /^show\.cpc\.assets\/003-[a-f0-9]{64}\.mp3$/,
    );
    expect(
      (
        await readFile(path.join(root, saved.project.audio.tracks[0].path!))
      ).equals(content),
    ).toBe(true);
    const reopened = new ProjectStore();
    await reopened.open(saved.path);
    expect(
      (await reopened.readAudio(saved.project.audio.tracks[0].path!)).dataUrl,
    ).toContain(content.toString("base64"));
    const card = path.join(root, "card");
    expect((await reopened.exportMedia(saved.project, card)).files).toBe(1);
    expect(
      (await readFile(path.join(card, "01", "003.mp3"))).equals(content),
    ).toBe(true);
    const next = path.join(root, "copy", "copy.cpc.json");
    const copied = await reopened.save(saved.project, next);
    expect(
      (
        await readFile(
          path.join(root, "copy", copied.project.audio.tracks[0].path!),
        )
      ).equals(content),
    ).toBe(true);
  });
  it("rejects arbitrary media reads and parent traversal in opened projects", async () => {
    const root = await folder();
    const nested = path.join(root, "project");
    await mkdir(nested);
    const source = path.join(root, "outside.mp3");
    await writeFile(source, "ID3fixture");
    const store = new ProjectStore();
    await expect(store.readAudio(source)).rejects.toThrow("not imported");
    const project = createDefaultProject();
    project.audio.tracks = [
      { number: 1, name: "Outside", path: "../outside.mp3" },
    ];
    const filename = path.join(nested, "bad.json");
    await writeFile(filename, JSON.stringify(project));
    await store.open(filename);
    await expect(store.readAudio("../outside.mp3")).rejects.toThrow(
      "inside the project",
    );
  });
  it("opens structurally valid scenes with repairable pin conflicts but rejects malformed documents", async () => {
    const root = await folder();
    const store = new ProjectStore();
    const project = createDefaultProject();
    project.outputs[1].pin = project.outputs[0].pin;
    const filename = path.join(root, "repair.json");
    await writeFile(filename, JSON.stringify(project));
    expect((await store.open(filename)).project.outputs).toHaveLength(8);
    await writeFile(filename, '{"version":99}');
    await expect(store.open(filename)).rejects.toThrow();
  });
  it("failed save preserves previously saved JSON and audio assets", async () => {
    const root = await folder();
    const source = path.join(root, "first.mp3");
    await writeFile(source, "original");
    const store = new ProjectStore();
    store.grantAudio(source);
    const project = createDefaultProject();
    project.audio.tracks = [{ number: 1, name: "First", path: source }];
    const filename = path.join(root, "scene.json");
    const saved = await store.save(project, filename);
    const priorJSON = await readFile(filename, "utf8");
    await writeFile(source, "replacement");
    project.audio.tracks.push({
      number: 2,
      name: "Missing",
      path: path.join(root, "missing.mp3"),
    });
    await expect(store.save(project, filename)).rejects.toThrow();
    expect(await readFile(filename, "utf8")).toBe(priorJSON);
    expect(
      await readFile(
        path.join(root, saved.project.audio.tracks[0].path!),
        "utf8",
      ),
    ).toBe("original");
  });
});
