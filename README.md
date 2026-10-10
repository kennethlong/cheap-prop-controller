# Cheap Prop Controller

A desktop scene editor and autonomous Arduino controller for relay-driven props, trigger sensors, and inexpensive MP3 modules. The MVP uses named states with their own output timelines and trigger transitions. It runs locally without an account or network service.

## Run the application

On this Windows machine, double-click **Start Controller.cmd**. It launches the packaged application when available, or the built Electron app otherwise. The portable build is in `release/`.

The starter project has eight outputs, three button triggers, and Idle → Approach → Scare → Idle transitions. It contains no audio files and uses 172 bytes of scene storage. The Uno on COM6 has the new firmware and this scene installed. Tests leave it stopped; opening the serial connection resets an Uno, which starts its saved initial state again.

1. Open **Hardware** and choose the board, wiring preset, triggers, and outputs. The displayed pins are the wiring map for that configuration.
2. Open **Media**, add MP3s, and choose ambient playback and fade settings. Assign foreground tracks in each state's settings. Player count and pin assignments update automatically.
3. Select a state. Drag across an output lane to create an event. Select it to edit start/end times or delete it. Events snap to 50 ms and cannot overlap on the same output.
4. Use **Play preview**, then the Approach, Scare, and Reset preview buttons. These controls affect the computer simulation only.
5. Save the project. Its JSON and adjacent `.assets` folder belong together when moving it to another computer.
6. Select the physical serial port and **Connect**. For a board without this firmware, use **Firmware** first, then connect.
7. **Upload scene** writes all states and settings to EEPROM and starts the initial state. The controller can then run without the computer. **STOP** disarms execution and forces outputs inactive; **Arm / reset** restarts the initial state.

The device console exposes physical trigger injection and status. A physical trigger is an input to the currently uploaded project; preview and edited-but-not-uploaded settings do not change the controller.

Two editable projects are in `examples/`: the eight-output starter and a Mega scene with PIR, HC-SR04, reset button, and three audio players. The audio example has numbered track slots without included MP3s; use each track's **Replace / link file** action in Media to attach your files while preserving state assignments.

## Boards and storage

| Board profile | Scene storage | Audio transport |
|---|---:|---|
| Uno R3 / ATmega328P | 1,024 bytes | Timer2 software UART |
| Classic Nano / ATmega328P | 1,024 bytes | Timer2 software UART |
| Pro Mini / ATmega328P, 5 V, 16 MHz | 1,024 bytes | Timer2 software UART |
| Mega 2560 | 4,096 bytes | Three hardware UARTs |

This MVP supports up to 32 outputs, eight triggers, eight states, and three players, subject to the board's actual pins and storage. These are software limits, not claims about the total GPIO on a Mega. Audio module combinations still require physical qualification. Uno R4, Nano Every, Pro Micro, ATmega168, and 3.3 V/8 MHz Pro Mini are not these profiles.

D0/D1 are reserved for the host. The OctoBanger shield preset reserves D7, D6, D5, D4 for its first four outputs; check that a particular shield matches. Audio players reserve two pins each. Digital triggers use one pin; an HC-SR04 uses two. Nano/Pro Mini A6/A7 are not interchangeable digital GPIO. Timer2 is reserved on Uno-family boards, so Timer2 PWM/tone are unavailable; D3/D11 still work as ordinary digital outputs.

Scene size includes all states, events, transitions, and settings. It does not grow with empty time between events. The capacity indicator blocks uploads that will not fit. Uploads use one storage bank: an interrupted upload leaves an invalid, stopped scene and requires uploading again. It does not preserve the previous scene as a backup.

## Audio behavior

- One player supports hard cuts.
- Two players support ordinary crossfades, or uninterrupted ambient position plus one foreground track at a time.
- Three players support uninterrupted ambient position while crossfading between different foreground tracks.
- **Keep ambient running silently** mutes ambient during foreground playback but preserves its position. Turning the option off lets ambient stop and restart when needed.
- Export writes `/01/001.mp3` through `/01/255.mp3`. Put the same library on every player's card. Runtime commands address folder 1 and the track number. MP3 files stay on the audio modules; scene data stays on the Arduino.

DFPlayer Mini and YX5300/Catalex have separate packet encoders. This version sends commands without receiving playback acknowledgments. A healthy USB connection does not establish that a player/card is present or playing. Actual module folder handling, repeat mode, startup latency, and audible fade quality must be checked against the particular boards. Crossfades use paced 0–30 volume commands and are not sample-accurate.

Multiple players need separate mixer inputs or a suitable summing circuit before amplification. Do not join amplified speaker outputs. The displayed MCU TX pin connects to a module's RX; observe the module's signal-level requirements. RX pins are reserved for future feedback but the MVP does not decode module responses.

## First physical bench session

Start with USB disconnected while changing wiring. Use the Hardware tab's current mapping, because adding players or sensors can reallocate pins.

1. Connect one unloaded relay or LED output and one button to ground with the button's internal pull-up enabled. Check inactive, active, STOP, reset, and power-up behavior, including active-low polarity if required.
2. Replace a trigger with PIR and verify activation/release. PIR needs its module-specific warm-up period.
3. Add one HC-SR04. Verify its enter distance and release margin, then repeat with audio traffic active. Several ultrasonic sensors are sampled in turn to reduce cross-talk.
4. Test one DFPlayer, then one YX5300, using known numbered MP3s. Add a second player and check start latency and fades through a mixer. Repeat with persistent ambient and a third player, particularly on Mega.
5. Record which board/module combinations work reliably before connecting actual prop loads.

Only the bare Uno's USB protocol and reported logical output state have been physically tested so far. Relay voltage, sensor readings, MP3 sound, and loaded props require the connected components.

## Development

Use Node.js 24 LTS, npm, Python with PlatformIO, and optionally VS Code. The application has no runtime Python or Arduino IDE dependency.

```powershell
npm ci
npm run dev
```

Build and run:

```powershell
npm run build
npm start
```

Firmware tooling can be isolated in the repository:

```powershell
python -m venv .tools\pio
.\.tools\pio\Scripts\python.exe -m pip install -r requirements-dev.txt
npm run firmware:build
.\.tools\pio\Scripts\platformio.exe pkg install --global --tool platformio/tool-avrdude@1.80100.0
npm run prepare:resources
npm run package:portable
```

On macOS/Linux use `.tools/pio/bin/python` and `.tools/pio/bin/platformio`. Build the application and prepare resources on the target operating system so the uploader and native serial module match it. Packaging targets for macOS/Linux are configured; their installers and physical USB behavior have not been tested on this Windows machine.

Verification:

```powershell
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
powershell -File tests/firmware/run-host-tests.ps1
```

The firmware host tests use Visual Studio C++ Build Tools on Windows. Their C++ sources can also be compiled with a host C++11 compiler. `npm run fixtures` produces bench images under ignored `artifacts/`. `scripts/bench-uno.py` intentionally overwrites scene storage and requires an explicit flag; use only with a bare disposable test board. `scripts/desktop-smoke.mjs COM6` exercises the actual Electron/USB workflow and also overwrites that board's scene.

## Code map

- `src/shared/`: project schema, board allocation, validation, compact compiler, deterministic simulator.
- `src/renderer/`: editor, waveform/timeline, media preview, hardware controls.
- `src/main/`: isolated desktop services, serial protocol, project/media files, AVRDUDE invocation.
- `firmware/`: EEPROM validator, state runtime, sensors, player commands, nonblocking UART.
- `docs/protocol-spec.json`: exact binary format and scene semantics.
- `docs/research/octobanger-research.md`: original application/source research.

ESP networking, external storage, visual state graphs, legacy OBC import, and video control are deferred. The current architecture separates the editor, device transport, and runtime so those additions do not require replacing the timeline model.
