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
