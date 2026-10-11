# Cheap Prop Controller

A desktop scene editor and autonomous Arduino controller for relay-driven props, trigger sensors, and inexpensive MP3 modules. The MVP uses named states with their own output timelines and trigger transitions. It runs locally without an account or network service.

## Run the application

On this Windows machine, double-click **Start Controller.cmd**. It launches the packaged application when available, or the built Electron app otherwise. Windows builds are in `release/`, including the portable app and **Cheap Prop Controller Setup 0.7.0.exe** in `release/0.7.0/`. The installer defaults to your user account, lets you select an installation folder, and creates Desktop and Start Menu shortcuts.

The starter project has eight outputs, three button triggers, and Idle → Approach → Scare → Idle transitions. It contains no audio files and uses 172 bytes of scene storage. Opening the serial connection resets an Uno, which starts its saved initial state again.

1. Open **Hardware** and choose the board, wiring preset, triggers, and outputs. The displayed pins are the wiring map for that configuration.
2. Open **Media**, add MP3s, and choose ambient playback and fade settings. Assign foreground tracks in each state's settings. Player count and pin assignments update automatically.
3. Select a state. Drag across an output lane to create an event. Select it to edit start/end times or delete it. Events snap to 50 ms and cannot overlap on the same output.
4. Use **Play preview**, then the Approach, Scare, and Reset preview buttons. These controls affect the computer simulation only.
5. Save the project in its own folder. Its JSON and adjacent `sounds` folder belong together when moving it to another computer. Saving copies full original MP3s and renders applied trims into `sounds`; filenames avoid collisions. **Save As** copies the scene's originals and regenerates its applied clips at the new location. Older `.assets` projects migrate by copying on their next save; their old audio is retained.
6. Select the physical serial port and **Connect**. For a board without this firmware, use **Firmware** first, then connect.
7. **Upload scene** writes all states and settings to EEPROM and starts the initial state. The controller can then run without the computer. **STOP** disarms execution and forces outputs inactive; **Arm / reset** restarts the initial state.

The device console exposes physical trigger injection and status. A physical trigger is an input to the currently uploaded project; preview and edited-but-not-uploaded settings do not change the controller.

**Open** starts in the current scene's folder, or the last successfully opened/saved project folder after restarting. Importing or exporting audio does not change this location. New scene saves use the same folder policy. On first use, **Start Controller.cmd** and development builds use `projects/` under this repository; the standalone portable EXE uses `projects/` beside itself. Other packaged builds, or a read-only portable location, use `Documents/Cheap Prop Controller/Projects`. The app creates the dedicated folder when needed. An old remembered Documents-root default switches to the new location; opening an existing scene there still works. Existing files are not moved; use **Save As** to relocate a scene and its sounds.

Installed copies keep projects in `Documents/Cheap Prop Controller/Projects` by default, outside the installation folder that is replaced or removed during upgrades/uninstall. Uninstall keeps the app's preferences and external scene folders. Avoid saving projects in the installed program directory. For custom launchers, set the absolute `CPC_PROJECTS_DIRECTORY` environment variable to choose a default project library. A remembered project folder still takes precedence.

Six editable projects are in `examples/`: the eight-output starter, an Uno scene with single-player fade transitions, a Mega scene with PIR, HC-SR04, reset button, and three audio players, an Uno scene with four ultrasonic distance zones, an IR learning starter with an empty command library, and a two-player Uno example with the new scene controls. The audio examples have numbered track slots without included MP3s; use each track's **Replace / link file** action in Media to attach your files while preserving state assignments.

## Scene controls and live recording

These controls use the existing Hardware and Scene pages. Ambient audio still loops; no external memory or long recordings are needed.

- **Test outputs** in the physical controller panel offers **Hold**, **Latch**, **All off**, and **Exit output test**. Upload the current scene first: the controller checks its image length and checksum against the editor before entering test mode. Testing stops normal scene execution and audio. Outputs use their configured active-low/high polarity. Leaving the page, switching windows, STOP, or disconnect ends the test and leaves the controller stopped. A 1.5-second firmware watchdog switches outputs off if the app stops renewing the test. Choose **Arm / reset** afterward to resume the scene.
- **Record performance** on Scene captures one pass of the selected state. Arm the desired lanes, choose ON or OFF, and hold their buttons or displayed keyboard keys in time with the preview audio. Finish early or let the state duration end. Review with **Overdub** to replace only overlapping intervals, or **Replace all armed channels** to clear those lanes before applying the take. Apply is one undo step; Discard leaves the timeline unchanged. Recording does not command physical outputs. It uses 50 ms intervals and merges adjacent intervals of the same value to conserve EEPROM.
- **ON/OFF intervals** let a normally-on output switch off for part of a scene. Choose the drawing value above the timeline or change a selected event's value. Outside an interval, the output returns to its Hardware idle setting. Overlaps on a lane remain invalid.
- **Timer** is a trigger type in Hardware. It needs no GPIO. Set its period and optionally reset its countdown on physical activation, a confirmed distance-zone entry, or an injected trigger. Timers start on Arm/reset, continue across normal state changes, and stop on STOP. Missed periods do not produce a burst of events.
- State transitions can respond to **activation or release**. Release is available for buttons, PIR, and single-threshold ultrasonic inputs; distance zones retain their separate exit actions. An input held at startup must first become inactive and then activate before its release can fire. No echo preserves the previous ultrasonic threshold state.
- **Cycle through scene variants** adds alternate destinations to a transition. They play in the displayed order, returning to the first after the last. Each state/trigger/edge has its own position, which Arm/reset clears. It is round robin, not random selection.

The new controls require firmware **0.6.0**. Projects that use them compile as CPC2; upload checks `sceneControls:true` before writing. Projects without them retain their earlier bytes. Each alternate destination adds two bytes, each interval six bytes, and each timer eight bytes. ON/OFF, release, audio-end, and BUSY settings use existing record fields. The displayed capacity includes the whole scene.

## Optional MP3 playback feedback

Under **Hardware → Audio device wiring**, enable **Use BUSY pin** for each player that exposes a compatible BUSY output. The app allocates and displays an additional input; connect that module's BUSY signal and select its polarity. Classic Nano and Pro Mini prefer analog-only A6/A7 for this input when those pads are exposed on the board; they remain unavailable for relay outputs. Uno and Mega use ordinary GPIO. This is optional per player and does not reduce the three-player software limit, though it consumes available inputs.

The device console reports each player's playback feedback. After sending PLAY, firmware expects a stable active BUSY signal, then a stable inactive signal to report completion. Both changes are debounced by 100 ms. If BUSY never activates within five seconds, status becomes **failed** and no completion transition fires. A reply or BUSY signal does not identify the track or confirm audible sound.

For a state with a nonlooping foreground track, **When foreground audio finishes** can enter another state, including Idle to restore normal ambient volume. Enable feedback on every configured player first, since foreground assignment can change during fades. Only the current foreground player can end that state; ambient and retiring tracks cannot. Without this option, track completion keeps the current state. Preview uses the linked clip duration or its explicit finish control; it cannot verify real BUSY wiring. Module-specific BUSY availability, polarity, latency, and stale-signal behavior still need bench testing. UART response decoding remains deferred.

## Ultrasonic distance zones

In **Hardware**, select **HC-SR04** for a trigger and choose **Distance zones**. Add named ranges and their **On enter / On exit** actions. Each range includes both endpoints (for example, 2–40 cm and 41–100 cm); ranges on one sensor cannot overlap, and gaps are allowed. All zones share that sensor's TRIG/ECHO pins. The app supports up to 32 active zones and 64 actions across the scene, subject to its displayed EEPROM capacity.

A zone action can **Change state**, **Set audio volume** for ambient or foreground playback, or **Send IR command** from the learned library. Actions execute in the listed order, with old-zone exit actions before new-zone entry actions. Place a state change before a volume adjustment or IR command when the action should apply to the destination state. Volume actions preserve the current track's position, including at volume zero, and have their own fade duration. They do not start absent audio. The next state entry restores the scene's configured audio levels. Continuous distance-to-volume mapping is not part of this release.

The current zone remains active through its configured release margin on both ends, preventing chatter at boundaries. A different range must remain stable for the sensor's debounce interval. The first valid reading after startup/reset establishes a zone without firing actions; later crossings fire once. Invalid/no-echo readings hold the last zone and cancel a pending change. Skipping over a zone does not fire its actions. Normal state changes do not rearm the sensor; STOP cancels pending actions. Multiple ultrasonic sensors are sampled sequentially, so distance response is slower than the 50 ms output timeline tick.

On **Scene**, start preview and use each ultrasonic sensor's distance input/slider or **No echo** button. The preview displays the current zone and audio levels. Older projects keep single-threshold behavior. Switching between threshold and zone mode preserves the saved configuration; legacy per-state mappings for a zoned sensor are inactive until threshold mode is restored.

Distance zones require firmware **0.4.0** with the `distanceZones` capability. Upload checks support before modifying controller storage. The four-zone Uno example uses 268 bytes; zones add 8 bytes per extended image, 10 per zone, and 6 per action. Scenes without active zones retain their existing binary representation.

## Learn and replay IR remote buttons

The **Hardware → IR remote commands** library gives captured buttons names such as “Candles on,” “Dim one step,” and “Candles off.” Names and captured signals are saved in the project. A name refers to the same command when used in timeline cues and distance-zone actions; renaming preserves those references.

1. Enable IR remote control, check the updated pin assignments, and upload the scene. An empty library is valid; `examples/ir-learning-starter.cpc.json` provides that starting point. Install firmware **0.5.0** first. Learning/testing requires an uploaded IR-enabled scene so it cannot silently repurpose a pin assigned to another device.
2. Connect the receiver/transmitter and choose **Learn IR command**. Learning stops the physical scene and waits up to ten seconds for one complete button press. Point the original remote at the receiver, then press and release the button. Cancel or STOP leaves the controller stopped.
3. Give the capture a name. Use **Test captured command**, observe the target device, then save it to the library. A serial acknowledgement means the test was accepted; the controller cannot confirm whether the candle responded. Save the project to retain the library.
4. Add a named IR cue at a time on a state's IR lane, or select **Send IR command** in a distance zone's entry/exit actions. Upload the scene again to use the saved commands autonomously. Desktop preview logs requested commands without transmitting them or simulating the physical send queue; queueing and state changes can delay or cancel transmission.

The [Adafruit 5990 transceiver](https://learn.adafruit.com/adafruit-infrared-ir-remote-transceiver/pinouts) has separate receiver **IRin** and transmitter **IRout** signals. For the supported 5 V boards, connect VIN to a suitable 5 V supply and GND to common ground. Its emitter can draw about 400 mA while pulsing. The receiver targets 38 kHz remote signals; it does not measure the carrier frequency. Our pin assignments are:

| Board | Module IRin → Arduino receiver | Module IRout → Arduino transmitter |
|---|---|---|
| Uno, classic Nano, 5 V/16 MHz Pro Mini | D2 | D9 |
| Mega 2560 | D2 | D11 |

Both pins are reserved before allocating audio, triggers, and prop outputs. IR uses Timer1; its PWM/servo functions are unavailable while IR is enabled. The firmware retains Timer2 for the Uno-family MP3 UART and Timer0 for timekeeping. It sends IR with a hardware carrier and nonblocking envelope scheduling, rather than calling a blocking library sender. Actual optical range and coexistence with connected sensors/audio still require bench verification.

The app recognizes NEC-style 32-bit frames and stores them compactly. Other supported captures retain a raw pattern of 5–127 alternating pulses, quantized to 50 μs, at most 200 ms per frame. Raw playback assumes 38 kHz and must be tested with the target. Long, unusual, different-carrier, rolling-code, or toggle-bit protocols are not guaranteed. Learning a “Dim” button reproduces that button; it does not discover absolute brightness percentages.

Each command can send 1–10 complete presses with a 50–2,000 ms gap. This gap also separates successive queued commands; it is not a protocol-specific held-button repeat. IR cues are points, not relay on/off intervals. Cues at time zero run on state entry; looping timelines repeat them. Commands transmit in order, with room for eight waiting commands plus the active command. Closely spaced cues may run late; the editor warns about scheduled overlap, and firmware reports queue overflow. A state change discards obsolete queued cues; an active frame may finish. STOP aborts transmission and clears the queue.

The app supports up to 32 named commands and 128 timed IR cues, subject to the board's displayed scene capacity. IR adds a 16-byte extension footer/descriptor, 12 bytes per command, four bytes per timed cue, and one byte per raw pulse; zones share the extension. An empty IR starter uses 188 bytes on Uno. Names remain on the computer. Disabled, unused libraries do not consume EEPROM. Scenes without IR retain their earlier binary format. Upload preflight requires `irReplay:true` before writing an IR scene, and learning requires `irLearning:true`.

## Boards and storage

| Board profile | Scene storage | Audio transport |
|---|---:|---|
| Uno R3 / ATmega328P | 1,024 bytes | Timer2 software UART |
| Classic Nano / ATmega328P | 1,024 bytes | Timer2 software UART |
| Pro Mini / ATmega328P, 5 V, 16 MHz | 1,024 bytes | Timer2 software UART |
| Mega 2560 | 4,096 bytes | Three hardware UARTs |

This MVP supports up to 32 outputs, eight triggers, eight states, and three players, subject to the board's actual pins and storage. These are software limits, not claims about the total GPIO on a Mega. Audio module combinations still require physical qualification. Uno R4, Nano Every, Pro Micro, ATmega168, and 3.3 V/8 MHz Pro Mini are not these profiles.

D0/D1 are reserved for the host. The OctoBanger shield preset reserves D7, D6, D5, D4 for its first four outputs; check that a particular shield matches. Audio players reserve two pins each, plus an input when BUSY feedback is enabled. Digital triggers use one pin; an HC-SR04 uses two; timers use none. Nano/Pro Mini A6/A7 can sample BUSY but are not interchangeable digital GPIO. Timer2 is reserved on Uno-family boards, so Timer2 PWM/tone are unavailable; D3/D11 still work as ordinary digital outputs.

Scene size includes all states, events, transitions, and settings. It does not grow with empty time between events. The capacity indicator blocks uploads that will not fit. Uploads use one storage bank: an interrupted upload leaves an invalid, stopped scene and requires uploading again. It does not preserve the previous scene as a backup.

## Audio behavior

- In **Media → Track library**, choose **Trim audio** beside a track. Drag the IN/OUT handles or enter the beginning offset and end in seconds, audition with **Preview selection**, then choose **Apply trim**. Scene playback and its waveform use that section; looping repeats only that section. **Full track** restores the whole file. Save the project to retain the selection.
- **Save trimmed MP3…** writes the current editor selection as a separate MP3 and keeps a copy in the project's `sounds` folder, including when you choose another export location. A new scene first asks where to save its project. The source file stays unchanged. **Export files for MP3 cards** also renders each applied trim into its numbered MP3; re-export and copy `/01` to every player's card after changing a trim. No firmware update is needed for trimming. Trimmed exports are re-encoded at 192 kbps stereo/44.1 kHz; untrimmed card exports keep their original bytes. MP3 hardware can introduce small decoder padding/delays.
- Crossfade duration is under **Media → Ambient & transitions → Audio transition: Crossfade → Crossfade (ms)**. It is independent of the track's trim range.
- One player supports hard cuts or **Fade out / fade in** transitions. In Media, choose the transition and set separate fade-out and fade-in times (250 ms defaults, 50 ms steps, 0–12,750 ms each). The old track fades to silence before the new track starts and fades in. Module loading and command pacing add a short gap; this is not an overlapping crossfade.
- Two players support ordinary crossfades, or uninterrupted ambient position plus one foreground track at a time.
- Three players support uninterrupted ambient position while crossfading between different foreground tracks.
- Under **Media → Ambient & transitions → Ambient during foreground**, choose **Stop ambient**, **Keep running silently**, or **Mix with foreground**. Mixed playback has a separate **Ambient mixed volume (1–30)**; **Ambient volume (0–30)** remains the normal level in Idle and other states without a foreground track. Both continuous modes preserve the ambient playhead. Existing projects retain their previous behavior.
- Mixed ambient stays audible while foreground tracks change, including during **Fade out / fade in**. Returning to a state with no foreground track restores normal ambient volume. A foreground MP3 finishing changes state only when an audio-finished target and BUSY feedback are configured. Two players handle ambient plus one foreground at a time; three handle ambient plus crossfades between different foreground tracks. Mixing adds no scene-storage bytes.
- Fade out / fade in with persistent ambient needs two players: one retains ambient position, and the other switches foreground tracks sequentially. A rapid new trigger replaces the pending audio destination; STOP cancels pending playback. Prop events start immediately on the state transition, so audio may begin later than the first event.
- Audible ambient mixing requires firmware **0.3.0** or newer with the `audioAmbientMix` capability. The desktop checks support before starting an upload, preserving the existing controller scene when an update is needed. Connect player line outputs through a suitable audio mixer for simultaneous physical playback; the desktop preview mixes them in software.
- Export writes `/01/001.mp3` through `/01/255.mp3`. Put the same library on every player's card. Runtime commands address folder 1 and the track number. MP3 files stay on the audio modules; scene data stays on the Arduino.

DFPlayer Mini and YX5300/Catalex have separate packet encoders. This version sends commands without decoding UART playback acknowledgments; optional BUSY wiring provides activity feedback separately. A healthy USB connection does not establish that a player/card is present or playing. Actual module folder handling, repeat mode, startup latency, and audible fade quality must be checked against the particular boards. Crossfades use paced 0–30 volume commands and are not sample-accurate.

Existing projects keep their original audio transitions. Fade out / fade in requires firmware 0.2.0 or newer; use **Firmware → Install firmware** before uploading it. The app checks support before changing the controller's saved scene.

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
npm run package:installer
```

On macOS/Linux use `.tools/pio/bin/python` and `.tools/pio/bin/platformio`. Build the application and prepare resources on the target operating system so the uploader and native serial module match it. Packaging targets for macOS/Linux are configured; their installers and physical USB behavior have not been tested on this Windows machine.

The desktop build also copies the platform's FFmpeg executable from the pinned `ffmpeg-static` dependency into `resources/ffmpeg`. The packaged app uses that encoder offline to save trimmed MP3s. The distributor's license and build/source information are copied alongside it; see [ffmpeg-static's binary sources](https://github.com/eugeneware/ffmpeg-static#sources-of-the-binaries). Reinstall dependencies on each target OS/architecture before packaging.

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
