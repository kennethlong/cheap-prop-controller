import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  AudioLines,
  Check,
  ChevronRight,
  Cpu,
  FilePlus2,
  FolderOpen,
  GitBranch,
  Info,
  Music2,
  Plus,
  Redo2,
  Save,
  Settings2,
  Trash2,
  Undo2,
  Workflow,
  Zap,
} from "lucide-react";
import {
  allocatePins,
  BOARD_PROFILES,
  compileProject,
  createDefaultProject,
  createSimulator,
  createState,
  getMediaClip,
  isZonedTrigger,
  LIMITS,
  parseProject,
  synchronizeAudioPlayers,
} from "../shared";
import type {
  MediaTrack,
  SceneProject,
  SceneSimulator,
  SimulatorSnapshot,
} from "../shared";
import { DevicePanel } from "./DevicePanel";
import { Hardware, Issues, Media, TrackSelect } from "./Hardware";
import { Timeline, time } from "./Timeline";
import { PreviewAudio } from "./audio";
import { useDevice } from "./DeviceContext";
import { PerformanceRecorder } from "./PerformanceRecorder";

const initial = createDefaultProject();
const errorText = (error: unknown) => String(error).replace(/^Error: /, "");

export function App() {
  const device = useDevice();
  const [project, setProject] = useState<SceneProject>(initial);
  const [projectEpoch, setProjectEpoch] = useState(0);
  const [selectedStateId, setSelectedStateId] = useState(
    initial.states[2]?.id ?? initial.initialStateId,
  );
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedIrEventId, setSelectedIrEventId] = useState<string | null>(
    null,
  );
  const [tab, setTab] = useState<"scene" | "hardware" | "media">("scene");
  const [dirty, setDirty] = useState(false);
  const [path, setPath] = useState("");
  const [history, setHistory] = useState<SceneProject[]>([]);
  const [future, setFuture] = useState<SceneProject[]>([]);
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    message: string;
    action: () => void;
  } | null>(null);
  const [snapshot, setSnapshot] = useState<SimulatorSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [position, setPosition] = useState(0);
  const [waveforms, setWaveforms] = useState<Record<number, number[]>>({});
  const [durations, setDurations] = useState<Record<number, number>>({});
  // Saving relocates the same audio. Only replacing its content/project should
  // remount a trim editor and discard its unapplied selection.
  const [audioEditKeys, setAudioEditKeys] = useState<Record<number, number>>(
    {},
  );
  const audioEditSequence = useRef(0);
  const [loaded, setLoaded] = useState(new Set<number>());
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const [mediaReload, setMediaReload] = useState(0);
  const projectRef = useRef(project);
  projectRef.current = project;
  const simulator = useRef<SceneSimulator | null>(null);
  const previewStateId = useRef<string | null>(null);
  const previewDistanceEpoch = useRef(0);
  const previewOperation = useRef(0);
  const audio = useRef(new PreviewAudio());
  useEffect(
    () => () => {
      previewOperation.current++;
      audio.current.dispose();
    },
    [],
  );
  const loadedPaths = useRef(new Map<number, string>());
  const loadGeneration = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const pendingAudioNumber = useRef<number | null>(null);
  const mediaOperation = useRef(0);
  const compiled = useMemo(() => compileProject(project), [project]);
  const allocation = useMemo(() => allocatePins(project), [project]);
  const errors = compiled.issues.filter((issue) => issue.severity === "error");
  const state =
    project.states.find((item) => item.id === selectedStateId) ??
    project.states[0];
  const event = state.events.find((item) => item.id === selectedEventId);
  const irEvent = state.irEvents?.find((item) => item.id === selectedIrEventId);
  useEffect(() => {
    setSelectedIrEventId(null);
  }, [selectedStateId]);
  const activeState = project.states.find(
    (item) => item.id === snapshot?.stateId,
  );
  const notify = (message: string, error = false) =>
    setToast({ message, error });
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(
      () => setToast(null),
      toast.error ? 10000 : 4500,
    );
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const stopPreview = () => {
    previewOperation.current++;
    setRunning(false);
    setStarted(false);
    simulator.current?.stop();
    simulator.current = null;
    previewStateId.current = null;
    previewDistanceEpoch.current++;
    setSnapshot(null);
    audio.current.stopAll();
    setPosition(0);
  };
  const change = (recipe: (next: SceneProject) => void) => {
    if (device.busy) {
      notify(
        `Wait for ${device.busy.toLowerCase()} to finish, or press STOP.`,
        true,
      );
      return;
    }
    const previous = projectRef.current;
    const next = structuredClone(previous);
    recipe(next);
    let allocated: SceneProject;
    try {
      allocated = synchronizeAudioPlayers(next);
    } catch (error) {
      notify(errorText(error), true);
      return;
    }
    setHistory((old) => [...old.slice(-79), previous]);
    setFuture([]);
    projectRef.current = allocated;
    setProject(allocated);
    setDirty(true);
    if (simulator.current) stopPreview();
    else audio.current.stopAll();
  };
  const undo = () => {
    if (device.busy) return;
    if (!history.length) return;
    stopPreview();
    const previous = history[history.length - 1];
    setFuture((old) => [projectRef.current, ...old]);
    setHistory((old) => old.slice(0, -1));
    projectRef.current = previous;
    setProject(previous);
    resetAudioEditors(previous);
    setDirty(true);
  };
  const redo = () => {
    if (device.busy) return;
    if (!future.length) return;
    stopPreview();
    const next = future[0];
    setHistory((old) => [...old, projectRef.current]);
    setFuture((old) => old.slice(1));
    projectRef.current = next;
    setProject(next);
    resetAudioEditors(next);
    setDirty(true);
  };
  const resetAudioEditors = (next: SceneProject) => {
    setAudioEditKeys(
      Object.fromEntries(
        next.audio.tracks.map((track) => [
          track.number,
          ++audioEditSequence.current,
        ]),
      ),
    );
  };
  const replaceProject = (next: SceneProject, nextPath = "") => {
    setProjectEpoch((value) => value + 1);
    stopPreview();
    audio.current.clear();
    loadGeneration.current++;
    mediaOperation.current++;
    pendingAudioNumber.current = null;
    projectRef.current = next;
    setProject(next);
    resetAudioEditors(next);
    setPath(nextPath);
    setDirty(false);
    setHistory([]);
    setFuture([]);
    setSelectedStateId(next.initialStateId);
    setSelectedEventId(null);
    setSelectedIrEventId(null);
    setWaveforms({});
    setDurations({});
    setLoaded(new Set());
    loadedPaths.current.clear();
  };
  const guarded = (message: string, action: () => void) => {
    if (device.busy || recording) {
      notify(
        "Finish the current operation or press STOP before opening another project.",
        true,
      );
      return;
    }
    if (dirty) setConfirmAction({ message, action });
    else action();
  };
  const save = async (saveAs = false) => {
    if (saving) return false;
    setSaving(true);
    try {
      if (window.cpc) {
        const savingProject = projectRef.current;
        const result = await window.cpc.saveProject(
          savingProject,
          saveAs || !path,
        );
        if (result) {
          setPath(result.path);
          if (projectRef.current === savingProject) {
            projectRef.current = result.project;
            setProject(result.project);
            setDirty(false);
            notify(
              "Project saved. Original audio and applied trims are in its sounds folder.",
            );
          } else {
            const current = structuredClone(projectRef.current);
            current.audio.tracks.forEach((track) => {
              const original = savingProject.audio.tracks.find(
                (item) => item.number === track.number,
              );
              const saved = result.project.audio.tracks.find(
                (item) => item.number === track.number,
              );
              if (original && saved && track.path === original.path) {
                track.path = saved.path;
                if (
                  track.trimStartMs === original.trimStartMs &&
                  track.trimEndMs === original.trimEndMs
                )
                  track.trimmedPath = saved.trimmedPath;
                else delete track.trimmedPath;
              }
            });
            projectRef.current = current;
            setProject(current);
            setDirty(true);
            notify(
              "Snapshot saved. Changes made during saving are still unsaved.",
            );
          }
        }
        return result !== null;
      } else {
        const blob = new Blob([JSON.stringify(projectRef.current, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${project.name.replace(/[^a-z0-9-_ ]/gi, "") || "scene"}.cpc.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setDirty(false);
        setPath(link.download);
        notify(
          "Project JSON downloaded. Browser audio files must be linked again when reopening.",
        );
        return true;
      }
    } catch (error) {
      notify(`Could not save: ${errorText(error)}`, true);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const open = () =>
    guarded("Discard unsaved changes and open another project?", () => {
      if (!window.cpc) {
        fileInput.current?.click();
        return;
      }
      void window.cpc
        .openProject()
        .then((result) => {
          if (result) {
            replaceProject(parseProject(result.project), result.path);
            notify("Project opened.");
          }
        })
        .catch((error) => notify(`Could not open: ${errorText(error)}`, true));
    });
  const newProject = () =>
    guarded("Discard unsaved changes and create a new scene?", () => {
      const next = createDefaultProject();
      next.name = "Untitled scene";
      next.states.forEach((item) => {
        item.events = [];
      });
      replaceProject(next);
      setDirty(true);
      setTab("scene");
    });
  const applySnapshot = (next: SimulatorSnapshot) => {
    if (previewStateId.current !== next.stateId) {
      setSelectedStateId(next.stateId);
      setSelectedEventId(null);
    }
    previewStateId.current = next.stateId;
    setSnapshot(next);
    setPosition(next.elapsedMs);
    audio.current.sync(next.audio, projectRef.current.audio.tracks);
  };
  const play = async () => {
    const operation = ++previewOperation.current;
    try {
      audio.current.stopAudition();
      if (running) {
        setRunning(false);
        await audio.current.pause();
        return;
      }
      if (!simulator.current)
        simulator.current = createSimulator(projectRef.current);
      await audio.current.resume();
      if (operation !== previewOperation.current) return;
      const next = simulator.current.snapshot();
      applySnapshot(next);
      setSelectedStateId(next.stateId);
      setSelectedEventId(null);
      setStarted(true);
      setRunning(true);
    } catch (error) {
      notify(errorText(error), true);
    }
  };
  const resetPreview = () => {
    previewOperation.current++;
    previewDistanceEpoch.current++;
    try {
      audio.current.stopAll();
      simulator.current = createSimulator(projectRef.current);
      const next = simulator.current.snapshot();
      previewStateId.current = next.stateId;
      setSnapshot(next);
      setPosition(0);
      setSelectedStateId(next.stateId);
      setSelectedEventId(null);
      setStarted(true);
      if (running)
        audio.current.sync(next.audio, projectRef.current.audio.tracks);
    } catch (error) {
      notify(errorText(error), true);
    }
  };
  const triggerPreview = (id: string) => {
    if (!simulator.current) return;
    if (simulator.current.trigger(id)) {
      const next = simulator.current.snapshot();
      if (running) applySnapshot(next);
      else {
        previewStateId.current = next.stateId;
        setSnapshot(next);
        setPosition(next.elapsedMs);
      }
      setSelectedStateId(next.stateId);
      setSelectedEventId(null);
    }
  };
  const distancePreview = (id: string, distanceCm: number | null) => {
    if (!simulator.current) return;
    simulator.current.setDistance(id, distanceCm);
    const next = simulator.current.snapshot();
    if (running) applySnapshot(next);
    else setSnapshot(next);
  };
  useEffect(() => {
    if (!running) return;
    let frame = 0;
    let previous = performance.now();
    let lastRender = previous;
    const tick = (now: number) => {
      const delta = Math.max(0, now - previous);
      previous = now;
      const next = simulator.current?.advance(delta);
      if (next && now - lastRender >= 35) {
        applySnapshot(next);
        lastRender = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running]);
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (recording || e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      const editing =
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
        target.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save(e.shiftKey);
        return;
      }
      if (editing || confirmAction) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (e.code === "Space" && tab === "scene") {
        e.preventDefault();
        void play();
      } else if (
        (e.key === "Delete" || e.key === "Backspace") &&
        irEvent &&
        tab === "scene"
      ) {
        e.preventDefault();
        change((next) => {
          const target = next.states.find((item) => item.id === state.id)!;
          target.irEvents = target.irEvents?.filter(
            (item) => item.id !== irEvent.id,
          );
        });
        setSelectedIrEventId(null);
      } else if (
        (e.key === "Delete" || e.key === "Backspace") &&
        event &&
        tab === "scene"
      ) {
        e.preventDefault();
        change((next) => {
          const s = next.states.find((item) => item.id === state.id)!;
          s.events = s.events.filter((item) => item.id !== event.id);
        });
        setSelectedEventId(null);
      } else if (e.key === "Escape") {
        setSelectedEventId(null);
        setSelectedIrEventId(null);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  const trackPathsKey = project.audio.tracks
    .map((track) => `${track.number}:${track.path ?? ""}:${track.name}`)
    .join("|");
  useEffect(() => {
    if (!window.cpc) {
      // Browser files cannot be reopened from disk after undo changes a link.
      // Discard mismatched audio rather than playing a different file under
      // the restored track name; the Link file action can restore it.
      const stale = project.audio.tracks.filter(
        (track) =>
          loadedPaths.current.has(track.number) &&
          loadedPaths.current.get(track.number) !== `browser:${track.name}`,
      );
      if (stale.length) {
        const numbers = new Set(stale.map((track) => track.number));
        for (const number of numbers) {
          audio.current.remove(String(number));
          loadedPaths.current.delete(number);
        }
        setLoaded(
          (old) => new Set([...old].filter((number) => !numbers.has(number))),
        );
        setWaveforms((old) =>
          Object.fromEntries(
            Object.entries(old).filter(
              ([number]) => !numbers.has(Number(number)),
            ),
          ),
        );
        setDurations((old) =>
          Object.fromEntries(
            Object.entries(old).filter(
              ([number]) => !numbers.has(Number(number)),
            ),
          ),
        );
      }
      return;
    }
    let disposed = false;
    const generation = ++loadGeneration.current;
    const isCurrent = () => !disposed && generation === loadGeneration.current;
    const loadTracks = async () => {
      for (const track of project.audio.tracks) {
        if (!track.path || loadedPaths.current.get(track.number) === track.path)
          continue;
        audio.current.remove(String(track.number));
        setLoaded(
          (old) =>
            new Set([...old].filter((number) => number !== track.number)),
        );
        setWaveforms((old) => {
          const next = { ...old };
          delete next[track.number];
          return next;
        });
        setDurations((old) => {
          const next = { ...old };
          delete next[track.number];
          return next;
        });
        try {
          const result = await window.cpc!.readAudio(track.path);
          if (!isCurrent()) return;
          const bytes = await (await fetch(result.dataUrl)).arrayBuffer();
          if (!isCurrent()) return;
          const peaks = await audio.current.load(
            String(track.number),
            bytes,
            isCurrent,
          );
          if (!isCurrent()) return;
          loadedPaths.current.set(track.number, track.path);
          setWaveforms((old) => ({ ...old, [track.number]: peaks }));
          const durationMs = Math.round(
            audio.current.duration(String(track.number)),
          );
          setDurations((old) => ({ ...old, [track.number]: durationMs }));
          const currentTrack = projectRef.current.audio.tracks.find(
            (item) => item.number === track.number,
          );
          if (
            currentTrack?.path === track.path &&
            currentTrack.durationMs !== durationMs
          ) {
            // Decoded metadata is a cache: opening a file should not mark it edited.
            const next = structuredClone(projectRef.current);
            next.audio.tracks.find(
              (item) => item.number === track.number,
            )!.durationMs = durationMs;
            projectRef.current = next;
            setProject(next);
          }
          setLoaded((old) => new Set([...old, track.number]));
        } catch (error) {
          if (isCurrent())
            notify(
              `Audio unavailable: ${track.name}. ${errorText(error)}`,
              true,
            );
        }
      }
    };
    void loadTracks();
    return () => {
      disposed = true;
    };
  }, [trackPathsKey, path, mediaReload]);

  const nextTrackNumber = () =>
    Array.from({ length: 255 }, (_, i) => i + 1).find(
      (value) =>
        !projectRef.current.audio.tracks.some(
          (track) => track.number === value,
        ),
    );
  const commitAudioFile = async (
    track: MediaTrack,
    bytes: ArrayBuffer,
    isCurrent: () => boolean,
  ) => {
    // Decode before replacing either the project reference or the cached audio.
    // A cancelled picker or invalid file leaves the previous track intact.
    // Retire any background load for the old file before the decoder commits.
    loadGeneration.current++;
    let peaks: number[];
    try {
      peaks = await audio.current.load(String(track.number), bytes, isCurrent);
    } catch (error) {
      setMediaReload((old) => old + 1);
      throw error;
    }
    if (!isCurrent()) return;
    const original = projectRef.current.audio.tracks.find(
      (item) => item.number === track.number,
    );
    const durationMs = Math.round(audio.current.duration(String(track.number)));
    const linked = { ...track, durationMs, trimStartMs: 0, trimEndMs: null };
    const editKey = ++audioEditSequence.current;
    setAudioEditKeys((old) => ({ ...old, [track.number]: editKey }));
    loadedPaths.current.set(
      track.number,
      track.path ?? `browser:${track.name}`,
    );
    change((next) => {
      const index = next.audio.tracks.findIndex(
        (item) => item.number === track.number,
      );
      if (index >= 0) next.audio.tracks[index] = linked;
      else next.audio.tracks.push(linked);
    });
    setWaveforms((old) => ({ ...old, [track.number]: peaks }));
    setDurations((old) => ({ ...old, [track.number]: durationMs }));
    setLoaded((old) => new Set([...old, track.number]));
    setMediaReload((old) => old + 1);
    notify(
      `Track ${String(track.number).padStart(3, "0")} linked. State and ambient assignments are unchanged.${original && ((original.trimStartMs ?? 0) > 0 || original.trimEndMs != null) ? " Trim reset to the full replacement file." : ""}`,
    );
  };
  const importAudio = async (existingNumber?: number) => {
    const number = existingNumber ?? nextTrackNumber();
    if (!number) {
      notify("The track library is full (255 tracks).", true);
      return;
    }
    if (!window.cpc) {
      pendingAudioNumber.current = number;
      audioInput.current?.click();
      return;
    }
    const operation = ++mediaOperation.current;
    const original = projectRef.current.audio.tracks.find(
      (track) => track.number === number,
    );
    const isCurrent = () => {
      const current = projectRef.current.audio.tracks.find(
        (track) => track.number === number,
      );
      return (
        operation === mediaOperation.current &&
        current?.path === original?.path &&
        current?.name === original?.name
      );
    };
    try {
      const result = await window.cpc.importAudio(number);
      if (!result?.path || !isCurrent()) return;
      const encoded = await window.cpc.readAudio(result.path);
      if (!isCurrent()) return;
      const bytes = await (await fetch(encoded.dataUrl)).arrayBuffer();
      if (isCurrent())
        await commitAudioFile({ ...result, number }, bytes, isCurrent);
    } catch (error) {
      if (isCurrent())
        notify(
          `Could not load audio; the previous file was kept. ${errorText(error)}`,
          true,
        );
    }
  };
  const removeTrack = (number: number) => {
    loadGeneration.current++;
    mediaOperation.current++;
    audio.current.remove(String(number));
    change((next) => {
      next.audio.tracks = next.audio.tracks.filter(
        (track) => track.number !== number,
      );
      if (next.audio.ambientTrack === number) next.audio.ambientTrack = null;
      next.states.forEach((item) => {
        if (item.foregroundTrack === number) item.foregroundTrack = null;
      });
    });
    loadedPaths.current.delete(number);
    setLoaded((old) => new Set([...old].filter((item) => item !== number)));
    setWaveforms((old) => {
      const next = { ...old };
      delete next[number];
      return next;
    });
    setDurations((old) => {
      const next = { ...old };
      delete next[number];
      return next;
    });
  };
  const selectedTrack =
    state.foregroundTrack ??
    (state.id === project.initialStateId ? project.audio.ambientTrack : null);
  const selectedMedia = project.audio.tracks.find(
    (track) => track.number === selectedTrack,
  );
  const selectedWaveform = useMemo(
    () =>
      selectedMedia && loaded.has(selectedMedia.number)
        ? audio.current.waveform(selectedMedia)
        : undefined,
    [selectedMedia, loaded, waveforms],
  );
  const selectedClip =
    selectedMedia && loaded.has(selectedMedia.number)
      ? getMediaClip(selectedMedia, durations[selectedMedia.number])
      : undefined;
  const previewTrim = async (
    number: number,
    startMs: number,
    endMs: number,
  ) => {
    stopPreview();
    try {
      await audio.current.audition(String(number), startMs, endMs);
    } catch (error) {
      notify(`Could not preview trim: ${errorText(error)}`, true);
    }
  };
  const saveTrimmedAudio = async (
    number: number,
    startMs: number,
    endMs: number,
  ) => {
    if (!window.cpc) return;
    const operation = mediaOperation.current;
    if (!path && !(await save())) return;
    if (operation !== mediaOperation.current) return;
    const track = projectRef.current.audio.tracks.find(
      (item) => item.number === number,
    );
    if (!track) return;
    audio.current.stopAudition();
    try {
      const result = await window.cpc.saveTrimmedAudio({
        ...track,
        trimStartMs: startMs,
        trimEndMs: endMs,
      });
      if (result)
        notify(
          `Trimmed MP3 saved to ${result.path}.${result.projectCopyPath ? " A copy is in the project's sounds folder." : " The original file was preserved."}`,
        );
    } catch (error) {
      notify(`Could not save trimmed MP3: ${errorText(error)}`, true);
    }
  };
  const updateState = (
    recipe: (next: SceneProject["states"][number]) => void,
  ) =>
    change((next) => recipe(next.states.find((item) => item.id === state.id)!));

  return (
    <div className="app">
      <header className="app-header" inert={recording}>
        <div className="brand-icon">
          <Zap size={23} fill="currentColor" />
        </div>
        <div>
          <div className="brand-name">Cheap Prop Controller</div>
          <div className="brand-subtitle">Scene workshop</div>
        </div>
        <div className="project-title">
          <input
            aria-label="Project name"
            value={project.name}
            onChange={(e) =>
              change((next) => {
                next.name = e.target.value;
              })
            }
          />
          <div className="project-status">
            {dirty
              ? "Unsaved changes"
              : path
                ? "Saved project"
                : "Starter scene"}{" "}
            · {project.board.toUpperCase()}
          </div>
        </div>
        <div className="header-actions">
          <button
            className="ghost"
            onClick={newProject}
            disabled={!!device.busy}
          >
            <FilePlus2 size={16} />
            <span className="button-label">New</span>
          </button>
          <button className="ghost" onClick={open} disabled={!!device.busy}>
            <FolderOpen size={16} />
            <span className="button-label">Open</span>
          </button>
          <button
            className="primary"
            disabled={saving}
            onClick={() => void save()}
          >
            <Save size={15} />
            <span className="button-label">
              {saving ? "Saving…" : "Save project"}
            </span>
          </button>
        </div>
      </header>
      <nav className="workspace-tabs" aria-label="Workspace" inert={recording}>
        <button
          className={tab === "scene" ? "active" : ""}
          onClick={() => setTab("scene")}
        >
          <Workflow size={15} />
          Scene
        </button>
        <button
          className={tab === "hardware" ? "active" : ""}
          onClick={() => setTab("hardware")}
        >
          <Cpu size={15} />
          Hardware
        </button>
        <button
          className={tab === "media" ? "active" : ""}
          onClick={() => setTab("media")}
        >
          <Music2 size={15} />
          Media
        </button>
        <div className="tab-context">
          <span>{project.outputs.length} outputs</span>
          <span>·</span>
          <span>{project.triggers.length} triggers</span>
          <span className={`badge ${errors.length ? "amber" : "green"}`}>
            {errors.length ? `${errors.length} to resolve` : "Ready to preview"}
          </span>
        </div>
      </nav>
      <main className="workspace" inert={recording}>
        {tab === "scene" && (
          <>
            <aside className="scene-sidebar">
              <div className="row between sidebar-heading">
                <span className="section-label">Scene states</span>
                <span className="muted small">
                  {project.states.length} / {LIMITS.states}
                </span>
              </div>
              <div className="state-list">
                {project.states.map((item, index) => (
                  <button
                    className={`state-button ${state.id === item.id ? "active" : ""}`}
                    key={item.id}
                    onClick={() => {
                      setSelectedStateId(item.id);
                      setSelectedEventId(null);
                      if (!running) setPosition(0);
                    }}
                  >
                    <div className="state-title">
                      <span className="state-index">{index + 1}</span>
                      <span className="filename grow">{item.name}</span>
                      {snapshot?.stateId === item.id && started && (
                        <i className="state-dot" />
                      )}
                    </div>
                    <div className="state-meta">
                      <span>
                        {item.id === project.initialStateId
                          ? "INITIAL"
                          : `${item.events.length + (item.irEvents?.length ?? 0)} events`}
                      </span>
                      <span>
                        {item.durationMs / 1000}s
                        {item.loopTimeline ? " · loop" : ""}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              <button
                className="ghost"
                disabled={project.states.length >= LIMITS.states}
                onClick={() => {
                  const id = crypto.randomUUID();
                  change((next) => {
                    next.states.push(
                      createState(id, `State ${next.states.length + 1}`),
                    );
                  });
                  setSelectedStateId(id);
                  setSelectedEventId(null);
                }}
              >
                <Plus size={14} />
                Add state
              </button>
              <div className="divider" />
              <div className="sidebar-heading">
                <div className="section-label" style={{ marginBottom: 10 }}>
                  How it flows
                </div>
                <p className="state-trigger-note">
                  Each state has its own timeline. A trigger moves the scene to
                  another state and starts that timeline.
                </p>
              </div>
              <div className="sidebar-footer">
                <div className="row between">
                  <span className="section-label">Onboard storage</span>
                  <span className="small mono">
                    {Math.round(
                      (compiled.usedBytes / compiled.capacityBytes) * 100,
                    )}
                    %
                  </span>
                </div>
                <div
                  className={`capacity-bar ${compiled.usedBytes > compiled.capacityBytes ? "over" : ""}`}
                >
                  <div
                    style={{
                      width: `${Math.min(100, (compiled.usedBytes / compiled.capacityBytes) * 100)}%`,
                    }}
                  />
                </div>
                <div
                  className="row between small muted"
                  style={{ marginTop: 8 }}
                >
                  <span>
                    {compiled.usedBytes} / {compiled.capacityBytes} B
                  </span>
                  <button
                    className="icon ghost"
                    aria-label="View hardware capacity"
                    onClick={() => setTab("hardware")}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            </aside>
            <section className="timeline-workspace">
              <div className="editor-heading">
                <div className="grow">
                  <div className="row">
                    <h2>{state.name}</h2>
                    {state.id === project.initialStateId && (
                      <span className="badge green">Initial state</span>
                    )}
                  </div>
                  <p>
                    {state.events.length + (state.irEvents?.length ?? 0)} events
                    · {project.outputs.length} channels ·{" "}
                    {state.loopTimeline
                      ? "Repeating timeline"
                      : "Holds idle outputs after timeline"}
                  </p>
                </div>
                <button
                  disabled={
                    !!device.busy || !!errors.length || !project.outputs.length
                  }
                  onClick={() => {
                    stopPreview();
                    setRecording(true);
                  }}
                >
                  Record performance
                </button>
                <button
                  className="icon ghost"
                  disabled={!history.length}
                  aria-label="Undo"
                  title="Undo (Ctrl+Z)"
                  onClick={undo}
                >
                  <Undo2 size={16} />
                </button>
                <button
                  className="icon ghost"
                  disabled={!future.length}
                  aria-label="Redo"
                  title="Redo (Ctrl+Shift+Z)"
                  onClick={redo}
                >
                  <Redo2 size={16} />
                </button>
              </div>
              <Timeline
                project={project}
                state={state}
                selectedEvent={selectedEventId}
                onSelect={(id) => {
                  setSelectedEventId(id);
                  setSelectedIrEventId(null);
                }}
                selectedIrEvent={selectedIrEventId}
                onSelectIr={(id) => {
                  setSelectedIrEventId(id);
                  setSelectedEventId(null);
                }}
                onAddIr={(atMs) => {
                  const command = project.ir?.commands[0];
                  if (!command) return;
                  const id = crypto.randomUUID();
                  updateState((next) => {
                    next.irEvents ??= [];
                    next.irEvents.push({ id, atMs, commandId: command.id });
                  });
                  setSelectedEventId(null);
                  setSelectedIrEventId(id);
                }}
                onEvents={(events) =>
                  updateState((next) => {
                    next.events = events;
                  })
                }
                position={
                  snapshot?.stateId === state.id || !started ? position : 0
                }
                onSeek={(ms) => {
                  if (!running) setPosition(ms);
                }}
                running={running}
                canPreview={!errors.length}
                started={started}
                onPlay={() => void play()}
                onStop={stopPreview}
                onReset={resetPreview}
                activeOutputs={snapshot?.outputs ?? {}}
                waveform={selectedWaveform}
                waveformDuration={selectedClip?.durationMs}
                waveformLoop={
                  state.id === project.initialStateId || state.loopAudio
                }
                previewState={snapshot?.stateName ?? "Idle"}
                onTrigger={triggerPreview}
                canFinishAudio={!!activeState?.audioEndStateId}
                onRelease={(id) => {
                  if (simulator.current?.release(id)) {
                    const next = simulator.current.snapshot();
                    if (running) applySnapshot(next);
                    else {
                      setSnapshot(next);
                      setSelectedStateId(next.stateId);
                      setPosition(next.elapsedMs);
                    }
                  }
                }}
                onAudioFinished={() => {
                  if (simulator.current?.audioFinished()) {
                    const next = simulator.current.snapshot();
                    if (running) applySnapshot(next);
                    else {
                      setSnapshot(next);
                      setSelectedStateId(next.stateId);
                      setPosition(next.elapsedMs);
                    }
                  }
                }}
                onDistance={distancePreview}
                distances={snapshot?.distances ?? {}}
                distanceResetKey={previewDistanceEpoch.current}
                previewAudio={snapshot?.audio ?? []}
                irActivity={snapshot?.irActivity ?? []}
                enabledTriggers={
                  activeState?.transitions.map((t) => t.triggerId) ?? []
                }
              />
            </section>
            <aside className="inspector">
              {irEvent ? (
                <>
                  <div className="row between">
                    <span className="section-label">Selected IR command</span>
                    <button
                      className="ghost small"
                      onClick={() => setSelectedIrEventId(null)}
                    >
                      Done
                    </button>
                  </div>
                  <label>
                    IR command
                    <select
                      aria-label="IR event command"
                      value={irEvent.commandId}
                      onChange={(event) =>
                        updateState((next) => {
                          next.irEvents!.find(
                            (item) => item.id === irEvent.id,
                          )!.commandId = event.target.value;
                        })
                      }
                    >
                      {(project.ir?.commands ?? []).map((command) => (
                        <option key={command.id} value={command.id}>
                          {command.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Time (seconds)
                    <input
                      aria-label="IR event time seconds"
                      type="number"
                      min="0"
                      max={(state.durationMs - 50) / 1000}
                      step="0.05"
                      value={irEvent.atMs / 1000}
                      onChange={(event) =>
                        updateState((next) => {
                          next.irEvents!.find(
                            (item) => item.id === irEvent.id,
                          )!.atMs =
                            Math.round(Number(event.target.value) * 20) * 50;
                        })
                      }
                    />
                  </label>
                  <p className="hint">
                    Sends this named command once at the selected point. Its
                    complete-press count and gap come from the IR library in
                    Hardware.
                  </p>
                  <button
                    className="danger"
                    onClick={() => {
                      updateState((next) => {
                        next.irEvents = next.irEvents!.filter(
                          (item) => item.id !== irEvent.id,
                        );
                      });
                      setSelectedIrEventId(null);
                    }}
                  >
                    <Trash2 size={14} />
                    Delete IR event
                  </button>
                  <div className="divider" />
                </>
              ) : event ? (
                <>
                  <div className="row between">
                    <span className="section-label">Selected event</span>
                    <button
                      className="ghost small"
                      onClick={() => setSelectedEventId(null)}
                    >
                      Done
                    </button>
                  </div>
                  <h3>
                    {
                      project.outputs.find(
                        (output) => output.id === event.outputId,
                      )?.name
                    }
                  </h3>
                  <label>
                    Output channel
                    <select
                      value={event.outputId}
                      onChange={(e) =>
                        updateState((next) => {
                          next.events.find(
                            (item) => item.id === event.id,
                          )!.outputId = e.target.value;
                        })
                      }
                    >
                      {project.outputs.map((output) => (
                        <option key={output.id} value={output.id}>
                          {output.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="field-grid">
                    <label>
                      Start (seconds)
                      <input
                        aria-label="Event start seconds"
                        type="number"
                        min="0"
                        max={state.durationMs / 1000}
                        step="0.05"
                        value={event.startMs / 1000}
                        onChange={(e) =>
                          updateState((next) => {
                            next.events.find(
                              (item) => item.id === event.id,
                            )!.startMs =
                              Math.round(Number(e.target.value) * 20) * 50;
                          })
                        }
                      />
                    </label>
                    <label>
                      End (seconds)
                      <input
                        aria-label="Event end seconds"
                        type="number"
                        min="0.05"
                        max={state.durationMs / 1000}
                        step="0.05"
                        value={event.endMs / 1000}
                        onChange={(e) =>
                          updateState((next) => {
                            next.events.find(
                              (item) => item.id === event.id,
                            )!.endMs =
                              Math.round(Number(e.target.value) * 20) * 50;
                          })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    During this interval
                    <select
                      aria-label="Event output value"
                      value={event.active === false ? "off" : "on"}
                      onChange={(e) =>
                        updateState((next) => {
                          next.events.find(
                            (item) => item.id === event.id,
                          )!.active = e.target.value === "on";
                        })
                      }
                    >
                      <option value="on">ON</option>
                      <option value="off">OFF</option>
                    </select>
                  </label>
                  <div className="event-summary">
                    <span className="muted">Duration</span>
                    <br />
                    <strong className="mono">
                      {((event.endMs - event.startMs) / 1000).toFixed(2)}{" "}
                      seconds
                    </strong>
                    <p className="hint">
                      The output is {event.active === false ? "OFF" : "ON"}{" "}
                      during this interval, then returns to its idle value.
                      Events on the same output must not overlap.
                    </p>
                  </div>
                  <button
                    className="danger"
                    onClick={() => {
                      updateState((next) => {
                        next.events = next.events.filter(
                          (item) => item.id !== event.id,
                        );
                      });
                      setSelectedEventId(null);
                    }}
                  >
                    <Trash2 size={14} />
                    Delete event
                  </button>
                  <div className="divider" />
                </>
              ) : (
                <div className="row between">
                  <span className="section-label">State settings</span>
                  <Settings2 size={15} className="muted" />
                </div>
              )}
              <div className="inspector-section">
                <label>
                  State name
                  <input
                    aria-label="State name"
                    value={state.name}
                    onChange={(e) =>
                      updateState((next) => {
                        next.name = e.target.value;
                      })
                    }
                  />
                </label>
                <div className="field-grid">
                  <label>
                    Duration (seconds)
                    <input
                      aria-label="State duration seconds"
                      type="number"
                      min="0.05"
                      max="3276.75"
                      step="0.05"
                      value={state.durationMs / 1000}
                      onChange={(e) =>
                        updateState((next) => {
                          next.durationMs = Math.max(
                            50,
                            Math.round(Number(e.target.value) * 20) * 50,
                          );
                        })
                      }
                    />
                  </label>
                  <label
                    style={{ justifyContent: "flex-end" }}
                    className="check"
                  >
                    <input
                      type="checkbox"
                      checked={state.loopTimeline}
                      onChange={(e) =>
                        updateState((next) => {
                          next.loopTimeline = e.target.checked;
                        })
                      }
                    />
                    Loop timeline
                  </label>
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={state.id === project.initialStateId}
                    disabled={state.id === project.initialStateId}
                    onChange={() =>
                      change((next) => {
                        next.initialStateId = state.id;
                        next.states.find(
                          (item) => item.id === state.id,
                        )!.foregroundTrack = null;
                        next.states.find(
                          (item) => item.id === state.id,
                        )!.audioEndStateId = null;
                      })
                    }
                  />
                  Initial / reset state
                </label>
              </div>
              <div className="divider" />
              <div className="inspector-section">
                <div className="row">
                  <AudioLines size={14} className="muted" />
                  <span className="section-label">State audio</span>
                </div>
                {state.id === project.initialStateId ? (
                  <p className="hint">
                    This state plays the ambient track. Configure it in{" "}
                    <button
                      className="ghost small"
                      style={{
                        minHeight: 20,
                        padding: "0 3px",
                        color: "var(--accent)",
                      }}
                      onClick={() => setTab("media")}
                    >
                      Media
                    </button>
                    .
                  </p>
                ) : (
                  <>
                    <TrackSelect
                      project={project}
                      value={state.foregroundTrack}
                      label="Foreground track"
                      onChange={(value) =>
                        updateState((next) => {
                          next.foregroundTrack = value;
                        })
                      }
                    />
                    <div className="field-grid">
                      <label>
                        Volume (0–30)
                        <input
                          type="number"
                          min="0"
                          max="30"
                          value={state.volume}
                          onChange={(e) =>
                            updateState((next) => {
                              next.volume = Number(e.target.value);
                            })
                          }
                        />
                      </label>
                      <label
                        className="check"
                        style={{ justifyContent: "flex-end" }}
                      >
                        <input
                          type="checkbox"
                          checked={state.loopAudio}
                          onChange={(e) =>
                            updateState((next) => {
                              next.loopAudio = e.target.checked;
                            })
                          }
                        />
                        Loop audio
                      </label>
                    </div>
                  </>
                )}
              </div>
              {state.id !== project.initialStateId && (
                <label>
                  When foreground audio finishes
                  <select
                    aria-label="Audio finished target"
                    value={state.audioEndStateId ?? ""}
                    onChange={(event) =>
                      updateState((next) => {
                        next.audioEndStateId = event.target.value || null;
                      })
                    }
                  >
                    <option value="">Keep this state</option>
                    {project.states.map((target) => (
                      <option value={target.id} key={target.id}>
                        {target.name}
                      </option>
                    ))}
                  </select>
                  <span className="hint">
                    Requires BUSY feedback on every player and a non-looping
                    foreground track. Preview uses the linked track length or
                    the Finish audio button.
                  </span>
                </label>
              )}
              <div className="divider" />
              <div className="inspector-section">
                <div className="row between">
                  <span className="section-label">Trigger transitions</span>
                  <GitBranch size={14} className="muted" />
                </div>
                {state.transitions.map((transition, index) => (
                  <div className="transition-row" key={`${state.id}-${index}`}>
                    <div className="row">
                      <label className="grow">
                        Input
                        <select
                          aria-label={`Transition ${index + 1} trigger`}
                          value={transition.triggerId}
                          onChange={(e) =>
                            updateState((next) => {
                              next.transitions[index].triggerId =
                                e.target.value;
                              const trigger = project.triggers.find(
                                (item) => item.id === e.target.value,
                              );
                              if (
                                trigger?.kind === "timer" ||
                                (trigger && isZonedTrigger(trigger))
                              )
                                next.transitions[index].edge = "activate";
                            })
                          }
                        >
                          {project.triggers
                            .filter(
                              (trigger) =>
                                !isZonedTrigger(trigger) ||
                                trigger.id === transition.triggerId,
                            )
                            .map((trigger) => (
                              <option key={trigger.id} value={trigger.id}>
                                {trigger.name}
                                {isZonedTrigger(trigger)
                                  ? " (inactive: distance zones)"
                                  : ""}
                              </option>
                            ))}
                        </select>
                      </label>
                      <button
                        className="icon ghost"
                        aria-label={`Delete transition ${index + 1}`}
                        onClick={() =>
                          updateState((next) => {
                            next.transitions.splice(index, 1);
                          })
                        }
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <label>
                      Respond on
                      <select
                        aria-label={`Transition ${index + 1} edge`}
                        value={transition.edge ?? "activate"}
                        onChange={(event) =>
                          updateState((next) => {
                            next.transitions[index].edge = event.target
                              .value as "activate" | "release";
                          })
                        }
                      >
                        <option value="activate">Activation</option>
                        <option
                          value="release"
                          disabled={project.triggers.some(
                            (trigger) =>
                              trigger.id === transition.triggerId &&
                              (trigger.kind === "timer" ||
                                isZonedTrigger(trigger)),
                          )}
                        >
                          Release
                        </option>
                      </select>
                    </label>
                    <div className="row">
                      <ArrowRight size={14} className="muted" />
                      <select
                        aria-label={`Transition ${index + 1} target state`}
                        value={transition.targetStateId}
                        onChange={(e) =>
                          updateState((next) => {
                            next.transitions[index].targetStateId =
                              e.target.value;
                            next.transitions[index].alternateStateIds =
                              next.transitions[index].alternateStateIds?.filter(
                                (id) => id !== e.target.value,
                              );
                          })
                        }
                      >
                        {project.states.map((target) => (
                          <option key={target.id} value={target.id}>
                            {target.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <label className="check">
                      <input
                        type="checkbox"
                        aria-label={`Transition ${index + 1} cycle variants`}
                        checked={!!transition.alternateStateIds}
                        onChange={(event) =>
                          updateState((next) => {
                            if (event.target.checked)
                              next.transitions[index].alternateStateIds = [];
                            else
                              delete next.transitions[index].alternateStateIds;
                          })
                        }
                      />
                      Cycle through scene variants
                    </label>
                    {transition.alternateStateIds && (
                      <div className="transition-targets">
                        <span className="hint">
                          Starts with the target above, then these states in the
                          order selected. Arm / reset starts over.
                        </span>
                        {project.states
                          .filter(
                            (target) => target.id !== transition.targetStateId,
                          )
                          .map((target) => (
                            <label className="check" key={target.id}>
                              <input
                                aria-label={`Transition ${index + 1} variant ${target.name}`}
                                type="checkbox"
                                checked={transition.alternateStateIds!.includes(
                                  target.id,
                                )}
                                onChange={(event) =>
                                  updateState((next) => {
                                    const t = next.transitions[index];
                                    t.alternateStateIds = event.target.checked
                                      ? [
                                          ...(t.alternateStateIds ?? []),
                                          target.id,
                                        ]
                                      : t.alternateStateIds?.filter(
                                          (id) => id !== target.id,
                                        );
                                  })
                                }
                              />
                              {target.name}
                            </label>
                          ))}
                        <span className="hint">
                          Order:{" "}
                          {[
                            transition.targetStateId,
                            ...transition.alternateStateIds,
                          ]
                            .map(
                              (id) =>
                                project.states.find(
                                  (target) => target.id === id,
                                )?.name,
                            )
                            .join(" → ")}
                        </span>
                      </div>
                    )}
                    {project.triggers.some(
                      (trigger) =>
                        trigger.id === transition.triggerId &&
                        isZonedTrigger(trigger),
                    ) && (
                      <p className="hint">
                        Inactive while this sensor uses distance zones. Edit its
                        actions in Hardware; switching back to a single
                        threshold restores this transition.
                      </p>
                    )}
                  </div>
                ))}
                <button
                  className="ghost"
                  disabled={
                    !project.triggers.some(
                      (trigger) =>
                        !isZonedTrigger(trigger) &&
                        (!state.transitions.some(
                          (t) =>
                            t.triggerId === trigger.id &&
                            (t.edge ?? "activate") === "activate",
                        ) ||
                          (trigger.kind !== "timer" &&
                            !state.transitions.some(
                              (t) =>
                                t.triggerId === trigger.id &&
                                t.edge === "release",
                            ))),
                    )
                  }
                  onClick={() =>
                    updateState((next) => {
                      const available = project.triggers.find(
                        (trigger) =>
                          !isZonedTrigger(trigger) &&
                          (!next.transitions.some(
                            (t) =>
                              t.triggerId === trigger.id &&
                              (t.edge ?? "activate") === "activate",
                          ) ||
                            (trigger.kind !== "timer" &&
                              !next.transitions.some(
                                (t) =>
                                  t.triggerId === trigger.id &&
                                  t.edge === "release",
                              ))),
                      );
                      if (available)
                        next.transitions.push({
                          triggerId: available.id,
                          targetStateId: project.initialStateId,
                          edge: next.transitions.some(
                            (t) =>
                              t.triggerId === available.id &&
                              (t.edge ?? "activate") === "activate",
                          )
                            ? "release"
                            : "activate",
                        });
                    })
                  }
                >
                  <Plus size={13} />
                  Add transition
                </button>
                <p className="hint">
                  Unlisted triggers are ignored in this state. Transitions
                  replace the current timeline. Distance zone actions run in
                  every state and are configured in Hardware.
                </p>
              </div>
              <Issues
                issues={compiled.issues.filter(
                  (issue) => issue.severity === "error",
                )}
              />
              {state.id !== project.initialStateId && (
                <button
                  className="ghost danger-text"
                  onClick={() =>
                    setConfirmAction({
                      message: `Delete “${state.name}”, its events, and any transitions or distance zone actions that lead to it?`,
                      action: () => {
                        change((next) => {
                          next.states = next.states.filter(
                            (item) => item.id !== state.id,
                          );
                          next.states.forEach((item) => {
                            item.transitions = item.transitions.flatMap(
                              (transition) => {
                                const ids = [
                                  transition.targetStateId,
                                  ...(transition.alternateStateIds ?? []),
                                ].filter((id) => id !== state.id);
                                return ids.length
                                  ? [
                                      {
                                        ...transition,
                                        targetStateId: ids[0],
                                        alternateStateIds:
                                          transition.alternateStateIds
                                            ? ids.slice(1)
                                            : undefined,
                                      },
                                    ]
                                  : [];
                              },
                            );
                            if (item.audioEndStateId === state.id)
                              item.audioEndStateId = null;
                          });
                          next.triggers.forEach((trigger) =>
                            trigger.zones?.forEach((zone) => {
                              zone.onEnter = zone.onEnter.filter(
                                (action) =>
                                  action.kind !== "state" ||
                                  action.stateId !== state.id,
                              );
                              zone.onExit = zone.onExit.filter(
                                (action) =>
                                  action.kind !== "state" ||
                                  action.stateId !== state.id,
                              );
                            }),
                          );
                        });
                        setSelectedStateId(project.initialStateId);
                        setSelectedEventId(null);
                      },
                    })
                  }
                >
                  <Trash2 size={13} />
                  Delete state
                </button>
              )}
            </aside>
          </>
        )}
        {tab === "hardware" && (
          <Hardware
            key={projectEpoch}
            project={project}
            change={change}
            issues={compiled.issues}
            usedBytes={compiled.usedBytes}
            capacityBytes={compiled.capacityBytes}
            notify={notify}
            confirm={(message, action) => setConfirmAction({ message, action })}
          />
        )}
        {tab === "media" && (
          <Media
            project={project}
            change={change}
            onImport={() => void importAudio()}
            onReplace={(number) => void importAudio(number)}
            onRemove={removeTrack}
            loaded={loaded}
            waveforms={waveforms}
            durations={durations}
            audioEditKeys={audioEditKeys}
            onPreviewTrim={(number, startMs, endMs) =>
              void previewTrim(number, startMs, endMs)
            }
            onStopTrim={() => audio.current.stopAudition()}
            onSaveTrim={
              window.cpc
                ? (number, startMs, endMs) =>
                    saveTrimmedAudio(number, startMs, endMs)
                : undefined
            }
            onRetry={() => setMediaReload((old) => old + 1)}
            onExport={() => {
              void window.cpc
                ?.exportMedia(project)
                .then((result) => {
                  if (result)
                    notify(
                      `Exported ${result.files} files to ${result.directory}`,
                    );
                })
                .catch((error) => notify(errorText(error), true));
            }}
          />
        )}
      </main>
      <DevicePanel
        project={project}
        workspaceKey={`${projectEpoch}:${tab}`}
        bytes={Array.from(compiled.bytes)}
        valid={!errors.length && compiled.bytes.length > 0}
        notify={notify}
      />
      <footer className="statusbar">
        <span className="row">
          <span className="connection-dot" />
          {BOARD_PROFILES[project.board].name} ·{" "}
          {project.wiring === "relay-shield"
            ? "Four-relay shield"
            : "Custom wiring"}
        </span>
        <span>
          {allocation.availableOutputPins.length} free pins ·{" "}
          {project.states.reduce(
            (sum, item) =>
              sum + item.events.length + (item.irEvents?.length ?? 0),
            0,
          )}{" "}
          events · 50 ms resolution
        </span>
        <span>MVP · local projects</span>
      </footer>
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
          onClick={() => setToast(null)}
        >
          {toast.message}
        </div>
      )}
      {confirmAction && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <h2 id="confirm-title">Confirm change</h2>
            <p>{confirmAction.message}</p>
            <div className="row">
              <button onClick={() => setConfirmAction(null)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  const action = confirmAction.action;
                  setConfirmAction(null);
                  action();
                }}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
      {recording && (
        <PerformanceRecorder
          project={project}
          state={state}
          audio={audio.current}
          onClose={() => setRecording(false)}
          onApply={(events) => {
            updateState((next) => {
              next.events = events;
            });
            setRecording(false);
            setSelectedEventId(null);
            notify("Recording applied. Undo restores the previous timeline.");
          }}
        />
      )}
      <input
        hidden
        ref={fileInput}
        type="file"
        accept=".json,.cpc"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          void file
            .text()
            .then((text) => {
              const parsed = parseProject(JSON.parse(text));
              replaceProject(parsed, file.name);
              notify("Project opened.");
            })
            .catch((error) =>
              notify(`Could not open project: ${errorText(error)}`, true),
            );
        }}
      />
      <input
        hidden
        ref={audioInput}
        type="file"
        accept="audio/mpeg,.mp3"
        data-testid="audio-file-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          const requestedNumber = pendingAudioNumber.current;
          pendingAudioNumber.current = null;
          if (!file) return;
          const number = requestedNumber ?? nextTrackNumber();
          if (!number) return;
          const operation = ++mediaOperation.current;
          const original = projectRef.current.audio.tracks.find(
            (track) => track.number === number,
          );
          const isCurrent = () => {
            const current = projectRef.current.audio.tracks.find(
              (track) => track.number === number,
            );
            return (
              operation === mediaOperation.current &&
              current?.path === original?.path &&
              current?.name === original?.name
            );
          };
          void file
            .arrayBuffer()
            .then((bytes) =>
              isCurrent()
                ? commitAudioFile({ number, name: file.name }, bytes, isCurrent)
                : undefined,
            )
            .catch((error) => {
              if (isCurrent())
                notify(
                  `Could not decode MP3; the previous file was kept. ${errorText(error)}`,
                  true,
                );
            });
        }}
      />
    </div>
  );
}
