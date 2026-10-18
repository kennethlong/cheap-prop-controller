# Cheap Prop Controller

A desktop scene editor and autonomous Arduino controller for relay-driven props, trigger sensors, and inexpensive MP3 modules. The MVP uses named states with their own output timelines and trigger transitions. It runs locally without an account or network service.

## Run the application

On this Windows machine, double-click **Start Controller.cmd**. It launches the packaged application when available, or the built Electron app otherwise. Windows builds are in `release/`, including the portable app and **Cheap Prop Controller Setup 0.11.0.exe** in `release/0.11.0/`. The installer defaults to your user account, lets you select an installation folder, and creates Desktop and Start Menu shortcuts.

The starter project has eight outputs, three button triggers, and Idle → Approach → Scare → Idle transitions. It contains no audio files and uses 172 bytes of scene storage. Opening the serial connection resets an Uno, which starts its saved initial state again.

1. Open **Hardware** and choose the board, wiring preset, triggers, and outputs. The displayed pins are the wiring map for that configuration.
2. Open **Media**, add MP3s, and choose ambient playback and fade settings. Assign foreground tracks in each state's settings. Player count and pin assignments update automatically.
3. Select a state. Drag across an output lane to create an event. Select it to edit start/end times or delete it. **Duration (milliseconds)** offers 100–500 ms in 50 ms steps, keeping the start time fixed. Choices that overlap another event on the same output or extend past the timeline are disabled; use Start/End for other lengths. Events snap to 50 ms and cannot overlap on the same output.
4. Use **Play preview**, then the Approach, Scare, and Reset preview buttons. These controls affect the computer simulation only.
5. Save the project in its own folder. Its JSON and adjacent `sounds` folder belong together when moving it to another computer. Saving copies full original MP3s and renders applied trims into `sounds`; filenames avoid collisions. **Save As** copies the scene's originals and regenerates its applied clips at the new location. Older `.assets` projects migrate by copying on their next save; their old audio is retained.
6. Select the physical serial port and **Connect**. For a board without this firmware, use **Firmware** first, then connect.
7. **Upload scene** writes all states and settings to EEPROM and starts the initial state. The controller can then run without the computer. **STOP** disarms execution and forces outputs inactive; **Arm / reset** restarts the initial state.

**Reset & arm in 15 s** gives you time to leave the sensors' view. It stops the physical controller and its audio, waits for STOP acknowledgement, then counts down 15 seconds before resetting into the initial state and arming. Keep the app open and USB connected until the countdown finishes. **Cancel arming** or **STOP** cancels it; changing the project/workspace or losing the connection also cancels. The existing **Arm / reset** button is immediate. This feature uses existing firmware commands and does not require a firmware update. A sensor still active when the countdown ends must release before its next activation can trigger the scene.

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

## Parallel child sequences

Choose **Add child sequence** on Scene to create an independent output timeline. In a main state's trigger transitions, choose **Run child: ... (parallel)** as the destination. That trigger launches the child while the main timeline and audio continue. Add the mapping in each main state where the child should be available.

Children reserve the outputs used by their events across the project, so another timeline cannot control those channels. Reserved outputs must be off at idle. Each child runs once, then waits for its **Cooldown after finish (seconds)** before accepting another trigger. Triggers during execution or cooldown are ignored without extending either. Separate children can run together on different outputs. Main-state changes let them finish; **STOP**, **Arm / reset**, scene upload, and entering output-test mode cancel them.

Children are output-only in this version: no audio, IR commands, looping, or nested transitions. They share the eight timeline/state slots and onboard storage capacity with main states. A child uses the existing 16-byte state record plus 6 bytes per event; trigger mappings use 2 bytes each. The single-pulse duration selector adjusts both the event and child timeline so cooldown starts when the pulse ends. Preview and the device console show running/cooling children; polling can miss a very short physical pulse.

Parallel children require firmware **0.7.0** (`parallelChildren:true`). Uploads reject unsupported firmware before writing storage. Projects using children compile as CPC3; existing projects retain their CPC1/CPC2 representation.

For independent controls without another button or wire, add a trigger in Hardware and choose **App / manual · no pin**. Name it **Next audio state**, then map it between your main states. Map the beam input to the child in each main state where it should fire. On the physical controller, select **Next audio state** and click **Send trigger** to advance; select the beam to test the child. Desktop preview has separate buttons for the same triggers. Manual triggers have no release action or automatic activation, consume no pins, and use one of the eight trigger slots and eight scene bytes.

App/manual triggers require firmware **0.7.1** (`manualTriggers:true`); the app checks support before uploading. The parallel beam bench uses a manual Ambient → Approach → Scare → Ambient cycle and a separate beam child, preserving D8 beam, D9 SSR, D2/D3 DFPlayer and D7/D6/D5/D4 shield wiring.

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

Each command can send 1–10 complete presses with a 50–2,000 ms gap. This gap also separates successive queued commands; it is not a protocol-specific held-button repeat. IR cues are points, not relay on/off intervals. Cues at time zero run on state entry; looping timelines repeat them. Commands transmit in order, with room for eight waiting commands plus the active command. The editor rejects definite timeline queue overflow and a looping timeline whose commands take longer to send than its loop duration. It warns about scheduled overlap and transmissions extending past the timeline. Loop wraps retain the queue; shared audio/sensor traffic and distance-zone IR actions can add delays that preview does not model. Firmware reports queue overflow. A state change discards obsolete queued cues; an active frame may finish. STOP aborts transmission and clears the queue.

The app supports up to 32 named commands and 128 timed IR commands after expanding macros, subject to the board's displayed scene capacity. IR adds a 16-byte extension footer/descriptor, 12 bytes per command, four bytes per expanded timed command, and one byte per raw pulse; zones share the extension. An empty IR starter uses 188 bytes on Uno. Names remain on the computer. Disabled, unused libraries do not consume EEPROM. Scenes without IR retain their earlier binary format. Upload preflight requires `irReplay:true` before writing an IR scene, and learning requires `irLearning:true`.

### One timeline event with several remote buttons

After capturing and naming the buttons, use **Hardware → Reusable IR macros → Add IR macro**. Name the macro, then choose a saved command and an offset for each step. For example:

| Offset | Named command | Command settings |
|---|---|---|
| 0 seconds | Candles on | One complete press |
| 1 second | Slowly brighten | Eight complete presses, 400 ms gap |
| 8 seconds | Candles off | One complete press |

Repeat count and gap belong to the named command in the library. Capturing the same button under another name lets it have different repeat settings. This reproduces remote button presses; brightness changes depend on how the candle responds.

On **Scene**, choose **Add IR event**, then select the macro under **IR event command**. The timeline shows one point for the macro. Its step offsets are relative to that point, and every step must start before the state timeline ends. Steps run in offset order; equal offsets retain their listed order. Closely spaced steps wait for earlier transmissions, including their repeated presses and gaps. The displayed macro duration estimates that waiting within the macro; other IR events can add more delay.

Preview logs each expanded named command without transmitting it. Save the project to retain captures, names, macros, and timeline references, then upload the scene when ready for physical replay. Editing a macro changes all its timeline uses. A command used by a macro cannot be deleted until those steps are removed or changed; deleting a macro confirms removal of its timeline uses and keeps the learned commands.

Each project supports 32 macros with up to 32 steps each. The capacity meter includes all expanded commands in every use; a three-step macro uses 12 bytes per timeline placement, plus its shared command definitions. Macro names and definitions stay in the project file. They compile into existing timed IR records, so **macros need no additional firmware update** on a controller that already supports IR.

Changing the main state or stopping cancels remaining macro steps. An Off step in Approach will not run if a trigger enters Scare first; add the appropriate Off command at the destination state's start when needed. Macros are available on main-state timelines; parallel children remain output-only, and distance-zone actions currently select individual named commands.

### Standard Uno harness and Adafruit IR bench (October 14, 2026)

Select **Hardware -> Wiring preset -> Standard Uno harness** to use fixed assignments on Uno R3, classic Nano, or 5 V / 16 MHz Pro Mini. Each hardware slot keeps its pins when disabled, absent, renamed, or reordered. Missing optional slots are displayed as reserved. Check a slot's **Enable** control only when its device is installed. Disabled devices retain their settings and sequence edits but are omitted from the uploaded scene and desktop preview; disabled sensors are not sampled or pinged. Disabling the IR transceiver also retains its learned library and cues without transmitting them. Ordinary custom/shield presets still allocate pins dynamically.

The standard supports one DFPlayer and cut or fade-out/fade-in transitions. Continuous ambient plus foreground mixing and multi-player crossfades need another profile. D0/D1 remain reserved for USB serial. A5 can be a seventh output or DFPlayer BUSY feedback, but not both. The standard slots are defined in `src/shared/standard-harness.ts`.

| Connection | Original PIR/ultrasonic bench | Fixed standard pin |
|---|---|---|
| DFPlayer RX, through existing 1 kOhm resistor | D2 | D3 |
| DFPlayer TX, if connected (otherwise leave unwired) | D3 | D8 |
| Beam contact signal | D8 | D10 |
| PIR OUT | D9 | D11 |
| HC-SR04 TRIG | D10 | D12 |
| HC-SR04 ECHO | D11 | D13 |
| Solenoid SSR control | D12 | A3 (D17) |
| Strobe SSR control | D13 | A4 (D18) |
| Shield relays 1, 2, 3, 4 | D7, D6, D5, D4 | Unchanged |
| Adafruit IRin (white STEMMA wire) | Not installed | D2 |
| Adafruit IRout (green STEMMA wire) | Not installed | D9 |
| Optional backup PIR OUT | Not installed | A0 (D14) |
| Optional backup HC-SR04 TRIG / ECHO | Not installed | A1 / A2 (D15 / D16) |
| Spare output or optional DFPlayer BUSY | Not installed | A5 (D19) |

`projects/avr-bench/Standard Uno bench.cpc.json` is the prepared hardware-test scene. It preserves the original scene states, events, media, and IDs, enables the new IR transceiver, and leaves backup sensors and the A5 spare disabled. It compiles to 272 of 1,024 Uno scene bytes before learning commands. The original bench file is unchanged. Use this project instead of the earlier autoallocated `Adafruit IR bench.cpc.json`, whose SSRs were temporarily assigned A0/A1.

When converting another project, existing outputs are assigned in order to shield relays 1-4, DC SSR, AC SSR, then spare. The first/second PIR and ultrasonic become primary/backup; the one button/contact becomes the beam slot. Manual and timer triggers use no slot. Conversion preserves IDs and edits and rejects extra or incompatible devices rather than dropping them. Review the wiring map before deployment. Adding manual/timer triggers still uses the eight-trigger software budget. Removing a device from the upload changes runtime channel indices, so physical trigger sending requires an upload of the current scene on the current connection; editing device settings or reconnecting requires reconfirming by upload. Output testing additionally verifies the uploaded scene checksum.

Adafruit VIN (red) connects to the regulated external 5 V supply; GND (black) connects to its ground and Arduino ground. The board has its own LED driver and draws about 400 mA during transmit pulses at 5 V. Do not supply VIN from a GPIO or join the external 5 V rail to the USB-powered Uno 5 V rail. Follow the board labels when using another cable; the colors here are for Adafruit's cable. See [Adafruit's pinout](https://learn.adafruit.com/adafruit-infrared-ir-remote-transceiver/pinouts).

Before changing this wiring, turn off the strobe's AC supply and solenoid's 12 V supply, then disconnect USB and peripheral 5 V power. Disconnect the signal leads whose assignments change. With those leads and the new transceiver disconnected, power only the Uno through USB and upload the standard bench scene; this prevents the old saved scene from driving the new wiring. Disconnect USB again, complete the new wiring, then reconnect controller/peripheral power with prop load power still off for the first IR test.

In application 0.10.0, open the standard bench and use **Hardware -> IR remote commands -> Learn IR command**. Point the remote at the receiver, press one button, name the capture (for example, Candles on), test it, and save it. Learning/test stops the scene. Save the project after learning; upload it again when ready to use commands or macros in sequences. Existing firmware 0.7.2 supports the standard harness and IR workflow; a new flash is not required for this feature.

### Reusable wiring configurations (application 0.11.0)

Open **Hardware → Wiring configurations**, select a built-in or saved layout, review the current/proposed connections, and click **Apply configuration**. Selection alone changes nothing. Applying changes this project's hardware assignments; save the project and upload its scene separately when the physical wiring is ready. Changing between Uno and Mega also requires the matching board firmware; choosing another wiring layout on the same board does not require different firmware.

| Built-in configuration | Hardware layout |
|---|---|
| Uno / Classic Nano / Pro Mini — standard | Existing standard harness, including disabled backup sensor slots and an A5 spare output |
| Uno / Classic Nano / Pro Mini — dual beam | Same assignments, with a second active-low beam contact on A5 instead of the spare output |
| Uno / Classic Nano / Pro Mini — extra motion, no IR | Same standard harness, with additional PIR inputs on D2 and D9; IR remote control disabled |
| Mega — expanded standard | Relays D7/D6/D5/D4; DC/AC SSR D30/D31; beams D22/D23; PIR D24/D25; ultrasonic TRIG/ECHO D26/D27 and D28/D29; IR RX/TX D2/D11; MP3 TX/RX D18/D19, D16/D17, D14/D15; ten disabled extra outputs D32–D41 |

Fixed configurations preserve pin assignments during ordinary edits. Disabled physical devices keep their reserved pins; delete an unused device to reclaim its pins. Disabled IR frees its two pins, while retaining learned commands and cues in the project. Adding an output, sensor, or player in fixed mode requires assigning its pins explicitly. Validation reports collisions, unavailable pins, insufficient players, and scene capacity limits before upload. D0/D1 remain reserved for USB serial; Mega MP3 players use the three hardware UART pairs in order. The eight-trigger software limit still includes manual/timer triggers.

Customize the hardware, enter a **New configuration name**, and choose **Save as configuration** to add a reusable hardware-only snapshot. It contains board, pins, sensor types, electrical settings and installed-player choices, without media, timelines, transitions or learned IR commands. Each project keeps its own complete hardware settings; editing or deleting a library entry never changes other projects. Applying a layout preserves compatible existing device identities, scene references, detector settings and enable choices. New devices take the layout's defaults. An incompatible layout is rejected if it would remove an enabled or referenced device.

**Import configuration** and **Export configuration** share `.cpc-wiring.json` files between computers. Import adds a copy on ID collision, and built-ins cannot be overwritten. Desktop configurations are stored in `wiring-configurations.json` under Electron's per-user application data directory, separate from project files; browser-only development uses local browser storage. Save the project after applying a layout. Existing custom, relay-shield and legacy standard-harness projects continue to open as before.

For the dual-beam box, add one **GX12-2 mating pair**: two beam connectors and seven GX12 pairs total with both backup sensors. Beam 2 connects A5 to ground through its dry contact. It cannot share A5 with the spare output or player BUSY feedback. Assign the new beam's scene transitions explicitly; a wiring configuration does not choose what the sensor triggers.

## Boards and storage

The agreed standard enclosure configuration is an Uno-family controller with one DFPlayer, four shield relay outputs, optional SSR outputs for a 12 V DC solenoid and a 110/120 V AC strobe, an optional Adafruit IR transceiver, a beam contact input, and primary/backup positions for both PIR and HC-SR04 sensors. Reserving all of these uses 17 of the 18 GPIO available after host serial, leaving one spare; MP3 BUSY feedback is not included. The backup sensors and both SSRs are optional installations. One player uses cut or fade-out/fade-in transitions and cannot mix simultaneous ambient and foreground tracks.

The **Standard Uno harness** preset and the new fixed wiring configurations implement reserved slots and exclude disabled devices from the uploaded scene. The custom and relay-shield presets still change assignments when hardware requirements change. Do not treat an unused transition as a disabled sensor; use its Enable control.

The planned plastic ammo-box enclosure places the AC SSR inside, with a switched grounded AC receptacle for the strobe. Its load connection is separate from all sensor/audio connectors. DC SSR placement and relay-load connector types remain to be selected. **GX12 connectors are selected for all external sensors and the Adafruit IR transceiver; stereo 3.5 mm mini jacks are reserved for audio.** The IR transceiver mounts outside the box, facing the devices it controls, and uses a five-pin GX12 connector with four wired contacts and one unused contact. Its 5 V, ground, D2 receive, and D9 transmit assignments are unchanged. The distinct five-pin connector prevents interchange with the four-pin ultrasonic cables. The primary and backup ultrasonics use four-pin GX12 connectors; RJ45/Cat5 is not selected. Contact numbering remains to be documented before assembly.

Recommended connector order per fully provisioned box, including both backup sensors:

| Connector | Mating pairs per box | Connection |
|---|---:|---|
| GX12-2 | 1 | Beam dry contact: signal and ground |
| GX12-3 | 2 | Primary and backup PIR: 5 V, ground, signal |
| GX12-4 | 2 | Primary and backup HC-SR04: 5 V, ground, TRIG, ECHO |
| GX12-5 | 1 | Adafruit IR: 5 V, ground, IRin, IRout; one unused contact |
| Stereo 3.5 mm TRS | 1 panel jack | DFPlayer line audio: left, right, ground |

This is six GX12 mating pairs: six panel connectors and six matching cable plugs. No six- or seven-pin connectors are needed for these ports. Omitting the backup sensors reduces the count by one three-pin pair and one four-pin pair. The Spirit beam's existing mini plug can be retained with a short adapter cable to the box's GX12-2 port. These counts exclude power, USB, relay/SSR load connectors, and the AC receptacle.

The linked [DIYhz GX12-4 listing](https://www.amazon.com/dp/B089YTG1SX) describes a five-piece male/female connector offering with waterproof caps. An IP rating for the assembled connection was not verified; the cap description alone does not establish a sealed installation. Check that each purchased set includes both mating halves, and use suitable cable strain relief and panel sealing for the intended location.

| Board profile | Scene storage | Audio transport |
|---|---:|---|
| Uno R3 / ATmega328P | 1,024 bytes | Timer2 software UART |
| Classic Nano / ATmega328P | 1,024 bytes | Timer2 software UART |
| Pro Mini / ATmega328P, 5 V, 16 MHz | 1,024 bytes | Timer2 software UART |
| Mega 2560 | 4,096 bytes | Three hardware UARTs |

This MVP supports up to 32 outputs, eight triggers, eight states, and three players, subject to the board's actual pins and storage. These are software limits, not claims about the total GPIO on a Mega. Audio module combinations still require physical qualification. Uno R4, Nano Every, Pro Micro, ATmega168, and 3.3 V/8 MHz Pro Mini are not these profiles.

D0/D1 are reserved for the host. The OctoBanger shield preset reserves D7, D6, D5, D4 for its first four outputs; check that a particular shield matches. Audio players reserve two pins each, plus an input when BUSY feedback is enabled. Digital triggers use one pin; an HC-SR04 uses two; timers and app/manual triggers use none. Nano/Pro Mini A6/A7 can sample BUSY but are not interchangeable digital GPIO. Timer2 is reserved on Uno-family boards, so Timer2 PWM/tone are unavailable; D3/D11 still work as ordinary digital outputs.

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
- Export writes `/01/001.mp3` through `/01/255.mp3`. Insert a card into the computer's card reader and select its root (for example `F:\`) in **Export files for MP3 cards** to write directly to it. Repeat for every player's card so they have the same library. A local export folder is also supported if you prefer copying later. Runtime commands address folder 1 and the track number. MP3 files stay on the audio modules; scene data stays on the Arduino.

DFPlayer Mini and YX5300/Catalex have separate packet encoders. This version sends commands without decoding UART playback acknowledgments; optional BUSY wiring provides activity feedback separately. A healthy USB connection does not establish that a player/card is present or playing. Actual module folder handling, repeat mode, startup latency, and audible fade quality must be checked against the particular boards. Crossfades use paced 0–30 volume commands and are not sample-accurate.

Existing projects keep their original audio transitions. Fade out / fade in requires firmware 0.2.0 or newer; use **Firmware → Install firmware** before uploading it. The app checks support before changing the controller's saved scene.

Multiple players need separate mixer inputs or a suitable summing circuit before amplification. Do not join amplified speaker outputs. The displayed MCU TX pin connects to a module's RX; observe the module's signal-level requirements. RX pins are reserved for future feedback but the MVP does not decode module responses.

## First physical bench session

Start with USB disconnected while changing wiring. Use the Hardware tab's current mapping, because adding players or sensors can reallocate pins.

For a bench with only the Uno, four-relay shield, and three YX5300/Catalex players, open `examples/manual-bench-uno.cpc.json`. No sensors or physical buttons are required. Its single **Next audio state** trigger reserves D12 with an internal pull-up; leave that pin unwired. The module control pins remain TX D2/D8/D10 and reserved RX D3/D9/D11, with relays on D7/D6/D5/D4. All three player types are YX5300; change individual types in Hardware if using DFPlayer modules. The template expects card tracks 001, 002, and 003; link those MP3s in Media for desktop preview or card export.

Connect the controller and upload the bench scene, then expand the far-right chevron in the bottom **Physical controller** strip. Choose **Next audio state** and click **Send trigger**. Each click advances ambient only → track 2 with relay 1 then relay 2 → track 3 with relay 3 then relay 4 → ambient only. Each relay pulses for one second; the second pulse starts 1.5 seconds after state entry. Foreground clips loop for repeated listening, ambient continues mixed at volume 4, and crossfades last 750 ms. Normal ambient volume is 12 and foreground volume is 15. Wait at least three seconds between clicks to observe both pulses. **Arm / reset** returns directly to ambient; **STOP** silences audio, turns relays off, and requires **Arm / reset** before another trigger.

For individual relay testing, use **Test outputs → Enter output test → Hold / latch**. This stops audio and the scene. **Exit output test**, then **Arm / reset**, returns to audio testing. The existing firmware already provides these controls; no special test firmware is needed. Use firmware 0.6.0 or newer for the individual output-test controls.

1. Connect one unloaded relay or LED output and one button to ground with the button's internal pull-up enabled. Check inactive, active, STOP, reset, and power-up behavior, including active-low polarity if required.
2. Replace a trigger with PIR and verify activation/release. PIR needs its module-specific warm-up period.
3. Add one HC-SR04. Verify its enter distance and release margin, then repeat with audio traffic active. Several ultrasonic sensors are sampled in turn to reduce cross-talk.
4. Test one DFPlayer, then one YX5300, using known numbered MP3s. Add a second player and check start latency and fades through a mixer. Repeat with persistent ambient and a third player, particularly on Mega.
5. Record which board/module combinations work reliably before connecting actual prop loads.

Earlier bench sessions have user-confirmed relay, DFPlayer/YX5300 audio, beam, PIR, ultrasonic, and SSR operation. Each changed wiring configuration still needs a physical retest. Automated host tests and desktop previews do not verify the installed transceiver's range, real remote compatibility, load wiring, or sensor placement.

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
