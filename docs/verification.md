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
