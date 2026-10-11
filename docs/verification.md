# MVP verification

The original MVP was verified on Windows on October 9, 2026. The desktop application and firmware are implemented; physical audio, sensors, relays, and props still require the connected bench hardware. Verification of the October 10 fade-transition update appears below; the original COM6 measurements apply to firmware 0.1.0.

## Automated checks

| Check | Result |
|---|---|
| TypeScript checks and production application build | Passed |
| Shared model, allocator, compiler, simulator, project persistence, serial cancellation | 35 tests passed |
| Browser editing and preview workflows | 4 end-to-end tests passed |
| Native firmware scene engine and binary validation | Passed, including both desktop-generated golden images |
| Native audio scheduling and packet tests | Passed, including same-track ambient/foreground role regressions |
| Native Timer2 UART tests | Passed, including all 256 byte values and start/data/stop framing |
| Firmware compilation | Uno, classic Nano, Mega 2560, Pro Mini 5 V/16 MHz passed |
| Windows packaging | Portable executable and unpacked application built |

The browser tests exercise Idle → Approach → Scare → Idle, visible active outputs, drag-created events, exact timing edits, deletion and undo, save/reopen, board and HC-SR04 pin budgets, malformed import handling, and repair of invalid timing.

Desktop media tests used a local MP3 from the existing OctoBanger sample. They verified decoding, waveform display, relative project assets, byte-preserving save, numbered SD export, reopen/reload, and muted preview playback. Replacing a track preserved its number and state assignments; invalid replacement audio preserved the previous file.

## Actual Uno on COM6

The board was confirmed USB-only before testing. The old flash and EEPROM were backed up under ignored `artifacts/` before replacement.

The packaged Windows application installed its bundled firmware through AVRDUDE, connected through the native serial module, compiled and uploaded its scene, injected an Approach trigger, and stopped execution. There were no renderer errors. STOP during an actual EEPROM upload cancelled the upload in approximately 28 ms in the measured run, and the incomplete scene stayed invalid and disarmed. A valid starter scene was restored afterward.

The serial bench suite passed 18 checks covering handshake, scene acceptance, state changes, logical outputs, reset, oversize rejection, out-of-order/incomplete uploads, CRC corruption, reserved-pin rejection despite a valid CRC, and persistence across reset. It also exercised three-player UART traffic without audio modules attached: 45 status requests completed, with a maximum measured response time of approximately 18 ms. STOP acknowledgement in the ordinary scene test was approximately 8 ms. These observations are not worst-case timing guarantees.

The final Uno firmware uses 13,520 bytes of flash and 532 bytes of static SRAM. Mega uses 14,990 bytes of flash and 997 bytes of static SRAM. Stack usage is additional. The starter scene uses 172 bytes of EEPROM.

At handoff, COM6 is closed and the controller is STOPped with the starter scene saved. Opening the serial port or cycling power resets the Uno and starts the saved initial state. The starter's initial state has no active output events.

Detailed local evidence is under `artifacts/`: `uno-bench-results.json`, `desktop-smoke-results.json`, `desktop-project-results.json`, screenshots, and native test executables. These generated files and hardware backups are intentionally excluded from Git.

## Remaining physical verification

- Measure actual output voltage/polarity and relay behavior; the bare-board tests verify reported logical state, not a loaded output.
- Wire PIR, buttons/footpads, and HC-SR04 and verify debounce, release behavior, and distance accuracy under audio traffic.
- Connect DFPlayer and YX5300 boards and confirm card indexing, repeat behavior, startup latency, and audible fades. The MVP sends commands without module feedback.
- Repeat with Mega, Nano, and the exact Mini board. Only Uno was physically attached; all four profiles were compiled.
- Build and test macOS/Linux installers and USB connections on those operating systems. Their targets are configured, but Windows is the verified release platform.

## Dependency status

The production dependency audit reported no known vulnerabilities at verification time. The packaging toolchain reported eight moderate transitive advisories associated with `sprintf-js` through electron-builder's download/logging dependencies. No forced downgrade or untested dependency override was applied. This affects the development packaging dependency tree, not the shipped application's runtime dependency tree.

## Fade out / fade in update — October 10, 2026

Application and firmware version 0.2.0 add sequential audio transitions with separate outgoing and incoming durations. The default is 250 ms each; values range from 0 to 12,750 ms in 50 ms steps. Normal sequential playback requires one player; persistent ambient plus sequential foreground playback requires two. The binary header remains 32 bytes, and the new Uno example uses 176 bytes of scene storage.

- All 59 application tests and all five browser workflows passed, including legacy settings, single-player allocation, independent durations, save/reopen, latest-trigger behavior, and STOP cancellation.
- All three native firmware suites passed. They check packet order and timing, independent/zero durations, interruption during fades and decoder startup, persistent ambient, unsent PLAY cancellation, and completion of packets already partly transmitted. Three desktop-generated binary fixtures pass firmware validation, including the new single-player image.
- TypeScript checking, formatting, and the production desktop build passed.
- The packaged Windows app reported version 0.2.0, opened the single-player example, displayed its separate 150/350 ms durations and one-player allocation, and produced no renderer errors. Each bundled board HEX matched the corresponding fresh compiler output. Evidence: `artifacts/fade-through-desktop-results.json` and `artifacts/fade-through-desktop.png`.
- Firmware builds passed for Uno, classic Nano, Mega 2560, and Pro Mini 5 V/16 MHz. Uno uses 14,366 bytes of flash and 534 bytes of static SRAM; Mega uses 15,860 bytes of flash and 999 bytes of static SRAM. Stack usage is additional.
- A mocked serial integration test confirms that missing `audioFadeThrough` capability rejects upload before `BEGIN`, preserving the controller's existing stored scene. Supported firmware accepts the new image.

No physical controller was accessed for this update. Firmware 0.2.0 must be installed before uploading a scene that uses the new transition. Actual decoder startup delay, command pacing, and audible fade quality still need measurement with connected audio modules. Output timelines begin at the trigger; they do not wait for the audio transition.

## Audio trim editor — October 10, 2026

Application 0.3.0 adds per-track start/end selection, waveform handles, numeric editing, selection audition, a separate **Save trimmed MP3** action, and physical trimming during numbered SD-card export. Original project assets remain full length, allowing edits to be reversed. Trim metadata does not alter the compiled scene image or consume additional controller storage; the bundled firmware remains 0.2.0.

- All 82 application tests pass. Coverage includes older projects, range validation, unchanged compiled scene bytes, trimmed nonlooping/looping preview, cancelling pending audition, project persistence, real MP3 encoding, selected tone content, and actual decoded duration. Invalid ranges, corrupt audio, and missing source files preserve existing exports; saving over a source file is rejected.
- All six browser workflows pass. The trim workflow imports generated audio, drags handles, edits millisecond values, previews, rejects invalid ranges, saves/reopens metadata, and restores the full track. Evidence: `artifacts/media-trim-editor.png`.
- TypeScript, formatting, and production build checks pass. FFmpeg is bundled with its distributor's license and build/source information. Untrimmed card exports retain original bytes; trimmed clips use 192 kbps stereo/44.1 kHz MP3 encoding. Encoding is staged before any existing card files are replaced; a filesystem error during final installation can still leave a partial set.
- The Electron desktop smoke test generates an eight-second MP3, auditions 2.000–4.500 seconds, saves a separately decodable 2.500-second MP3, preserves the original asset, exports the same range to `/01/001.mp3`, and restores bounds after reopening the project. It uses the real IPC bridge and audio encoder with muted computer playback. Script: `scripts/desktop-trim-smoke.mjs`; evidence: `artifacts/desktop-trim-results.json`.
- The final packaged Windows application reports 0.3.0 and passes that same smoke test, including a second clip save from the reopened relative asset path. Both exports decode to exactly 2.500 seconds; there are no renderer errors. Screenshot inspected: `artifacts/desktop-trim-smoke.png`. The packaged encoder matches the prepared executable byte for byte.

No controller, relay, sensor, audio module, or SD card was accessed during this update. Actual MP3-module encoder padding, startup delay, and audible behavior remain part of the hardware bench tests. macOS/Linux packaging has not been run on this Windows machine.

## Project sounds folder — October 10, 2026

Application 0.3.1 stores source audio and rendered applied trims in `sounds/` beside the scene JSON. `path` remains the full original; optional `trimmedPath` identifies the generated clip. Both are relative. Save As copies originals and renders the applied selections into the destination's sounds folder. Existing `.assets` projects copy their media on save while retaining the old files. Repeated saves retain stable filenames.

**Save trimmed MP3** saves a new scene first, defaults to its sounds folder, and retains a local copy even when another destination is selected. Cancelling the initial scene-save dialog stops the clip export. Draft selections survive the source-path change when saving; importing replacement audio still resets the editor.

- All 85 application tests and six browser workflows pass, with TypeScript, formatting, and production build checks passing.
- Storage tests cover empty sounds folders, legacy migration, original byte preservation, real decoded trim duration, repeat saves, Save As, staging failures, and protection of previously saved sounds against overwrite.
- Updated real Electron smoke tests verify cancellation, draft preservation during the first save, original and playable trimmed copies in sounds, separate export retention, SD export, and reopening relative paths. Evidence remains under ignored `artifacts/`.
- The final packaged 0.3.1 Windows build passes the same checks without renderer errors. The standalone saved clip, project copy, and card export each decode to exactly 2.500 seconds; the eight-second original is unchanged. Screenshot inspected: `artifacts/desktop-trim-smoke.png`.

The new Windows build is staged under `release/0.3.1/` so the existing running application can remain open. `Start Controller.cmd` selects the build matching `package.json`. No physical controller was accessed.

## Project Open location — October 10, 2026

Application 0.3.2 opens the project picker in the current scene JSON's folder, or the last successfully opened/saved project folder after restarting. The first launch falls back to Documents. Audio dialogs do not change the project preference; missing folders or damaged preferences fall back safely.

- TypeScript, formatting, and the production build pass.
- The real Electron project workflow passes in development and the packaged Windows app. It verifies Open's folder after MP3 import and SD export, persistence in a fresh app process, and preservation after cancelled or invalid project opens. Test preferences are isolated from the user's settings.
- The Windows build is under `release/0.3.2/`; `Start Controller.cmd` selects it. Evidence: `artifacts/desktop-project-results.json`. No physical controller was accessed.

## Audible ambient mixing — October 10, 2026

Application 0.4.0 and firmware 0.3.0 add **Mix with foreground** alongside **Stop ambient** and **Keep running silently**. The mixed level is independent of normal ambient volume. Ambient retains its playhead across foreground changes and restores its normal level in any state without a foreground track. During sequential fades, mixed ambient keeps playing and follows its own volume envelope while the foreground player switches tracks.

The optional `ambientMixVolume` defaults to zero for old projects. It occupies five previously reserved header bits, so it adds no EEPROM bytes or players beyond existing persistent-ambient allocation. Upload preflight requires the firmware's `audioAmbientMix` capability before BEGIN; unsupported firmware keeps its current stored scene intact.

- All 116 application tests and seven browser workflows pass. They cover legacy projects, independent saved volumes, mode changes, player allocation, packed images, malformed settings, unsupported firmware, preview transitions, and preservation of ambient position and fade deadlines.
- All three native firmware suites pass, including four desktop-generated binary fixtures. DFPlayer and YX5300 packet tests cover mixed-volume targets, cut/crossfade/sequential transitions, zero normal volume, startup, rapid triggers, queued/in-flight command cancellation, reset, and STOP.
- TypeScript, formatting, and the production desktop build pass. Uno, classic Nano, Mega 2560, and Pro Mini 5 V/16 MHz firmware builds pass. Uno uses 14,966 bytes of flash and 534 bytes of static SRAM; Mega uses 16,492 bytes and 999 bytes respectively. Stack usage is additional.
- The Windows build is staged in `release/0.4.0/`. All four bundled firmware HEX files match the fresh compiler output byte for byte.
- The packaged Electron app passes real MP3 decode and Web Audio checks with muted computer playback. Save/reopen preserves normal volume 20 and mixed volume 8; the same ambient source remains audible across foreground changes and reset. Crossfade overlaps three sources; sequential fades allocate two players, with a 30 ms preview disposal tail. Evidence: `artifacts/desktop-ambient-mix-results.json`.

No physical controller was accessed or flashed during this update. Hardware use requires installing the bundled firmware and combining the MP3 players' line outputs through the bench mixer. Actual module fade quality and electrical audio mixing remain hardware checks. A foreground MP3 ending naturally does not restore ambient volume; that happens when the scene enters a state without foreground audio.

## Dedicated project folders and Windows installer — October 10, 2026

Application 0.4.1 uses a dedicated project library for both first Open and first Save. The repository launcher/development app use repository `projects/`; the portable bootstrap's `PORTABLE_EXECUTABLE_DIR` selects adjacent `projects/`; other packaged apps use `Documents/Cheap Prop Controller/Projects`. Unwritable preferred locations fall back to the dedicated Documents folder. Remembered custom locations and actively opened scenes retain their existing paths; a remembered Documents-root default is ignored. Existing scenes are never moved automatically.

- All 132 application tests pass, including 16 folder-policy/persistence tests covering lazy creation, failed writes, fallback, remembered/current precedence, invalid preferences, and Documents-root handling. TypeScript, formatting, and the production build pass.
- The real Electron project workflow passes in development and the packaged 0.4.1 application. It verifies first Open and Save, audio import/export independence, saved relative sounds paths, and remembered folders after restarting. The packaged run supplies the portable bootstrap's directory environment and confirms the adjacent-projects policy. Evidence: `artifacts/desktop-project-results.json`.
- Windows installer and portable EXE builds pass. The installer permits an installation-directory choice, defaults to per-user installation, creates Desktop/Start Menu shortcuts, retains preferences on uninstall, and does not launch the app automatically. Both artifacts are under `release/0.4.1/`.
- The installer's embedded archive integrity check passes and its SHA-512 matches the release manifest. Archive inspection confirms the app, native serial module, avrdude/configuration, FFmpeg/license, and all four firmware images are included. All 12 bundled tool/resource files match the prepared originals byte for byte.

Installation, upgrade, and uninstall were not executed on this machine: NSIS can close a running application. The portable bootstrap starts Electron, but its inspector output is not relayed to Playwright; the automated workflow therefore launches the packaged application directly with an isolated portable-directory environment. No physical controller was accessed, and no firmware changed in this update. macOS/Linux packaging remains untested.

## Ultrasonic distance zones — October 10, 2026

Application 0.5.0 and firmware 0.4.0 add named distance zones under each HC-SR04 sensor. Zones share the physical sensor's two pins and support ordered state changes and ambient/foreground volume actions on entry and exit. Release margins and fresh-sample dwell suppress boundary chatter; no echo holds the last zone and cancels pending dwell. Startup/reset establishes a silent baseline, and jumping over a zone does not fire it. Normal state entry does not rearm the sensor.

Volume actions have independent fade times and preserve playback position, including while muted at zero. State entry restores configured levels. Actions run in order, with exit actions before entry actions. Legacy per-state mappings remain saved but inactive while that sensor uses zones. IR commands and continuous distance mapping remain deferred.

The binary extension adds an eight-byte footer, ten bytes per zone, and six bytes per action. The four-zone Uno example uses 268 of 1,024 EEPROM bytes, including seven zone actions. Up to 32 zones and 64 actions are allowed across the scene, subject to board capacity. Inactive presets add no bytes, and scenes without active zones retain their previous binary representation. The desktop checks `distanceZones:true` before BEGIN; unsupported firmware keeps its existing saved scene untouched.

- All 183 application tests pass, including zone validation, exact compiler capacity, binary compatibility, upload capability preflight, and interrupted audio fades. TypeScript, formatting, and the production desktop build pass.
- All nine browser workflows pass. Zone coverage includes editing, action ordering, save/reopen, mode preservation, unchanged pin budgets, deleting referenced states, live distance controls, hysteresis/dwell, no echo, and volume changes that preserve playback position.
- Four native firmware suites pass, including all five desktop-generated binary fixtures. Coverage includes malformed extension boundaries/references, fresh-reading dwell, timer wrap, ordered actions, pending fades, muted playback, and STOP. The controller suite executes the actual `main.cpp` with serial logging advancing the clock, verifying that multiple state/volume actions share one timestamp and cannot complete a fade through unsigned time underflow.
- Firmware builds pass for all four boards. Uno uses 17,994 bytes of flash and 603 bytes of static SRAM; Nano 17,984/603; Pro Mini 17,988/603; Mega 19,514/1,068. Stack usage is additional. No physical timing or stack high-water measurement was performed.
- The packaged Windows 0.5.0 application passes real MP3 decode, project IPC, save/reopen, and Web Audio checks with computer playback muted. The four-zone example follows Far → Approaching → Close → Very close → Far. Native source/gain observations confirm that volume-only 12 → 24 → 12 and 12 → 0 → 12 changes retain the same foreground source and advancing playback clock; ambient stays alive. No echo holds the zone beyond its dwell interval. There are no renderer errors. Script: `scripts/desktop-zones-smoke.mjs`; evidence: `artifacts/desktop-zones-results.json`; screenshots inspected under `artifacts/zone-smoke-iZ6Iup/`. The test closes only its isolated app instance.
- Installer and portable builds are in `release/0.5.0/`. The installer's embedded archive integrity and release-manifest SHA-512 checks pass. All 12 bundled resource files match prepared originals, and all four bundled firmware images match the final board builds. The installer itself was not run.

No physical controller was accessed or flashed during this update. Real HC-SR04 distance accuracy, response under MP3 command traffic, and audible fades still require bench testing. The firmware included with this release must be installed before uploading a zoned scene. Windows installer execution and macOS/Linux builds remain untested.
