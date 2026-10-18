# OctoBanger behavior and replacement research

Research date: October 9, 2026. This is the baseline for discussing enhancements to a replacement application. It describes the installed OctoBanger system, its firmware and data formats, and comparable projects. Implementation scope and technology choices remain open.

The existing system is a desktop scene editor paired with an autonomous Arduino sequencer and a separate serial MP3 player. Its essential workflow can be preserved. Several firmware limitations, a desktop wiring-report discrepancy, and an obsolete project serialization format need explicit treatment if compatibility is a goal. Static inspection establishes the findings below; behavior of the attached hardware and equivalence between the supplied source and HEX have not been tested.

## Existing workflow

The seven supplied screenshots and the described workflow establish these application requirements:

1. Open an existing controller or create one with a name, comments, media mode, and eight named/color-coded channels. Each channel has a comment and active-low option; new dialog channels default to active-high.
2. Select ambient/scare media as applicable. Keep the controller in its own folder beneath `Controllers`.
3. Install firmware separately through the Arduino Uploader, selecting COM port, HEX file, and board type.
4. Set the controller pin profile, trigger idle level, timing compensation, boot delay, and end-of-sequence delay.
5. Edit events on eight timeline lanes against the audio waveform. Events specify active intervals; selection and editing are different modes. Desktop audio controls include play, stop, record, position, volume, and balance.
6. Connect over serial, inspect the device report, upload configuration, and reconnect after the application's reset/disconnect cycle.
7. Upload the sequence independently and use the device Trigger button to test it.
8. Deploy the controller to run autonomously from its PIR or other trigger.

The editor's PC audio playback, device configuration upload, sequence upload, firmware flashing, and MP3 SD-card preparation are separate operations. Seeing a waveform or hearing PC playback does not establish that the MP3 board has received or can play the corresponding track.

The [sample build guide](https://buttonbanger.com/downloads/octobanger/octobanger_example_build.pdf) demonstrates a four-relay shield plus an additional SSR channel. Its configuration/reconnection example and wiring diagram agree with the firmware's A0 trigger input and A2 media output. Its trigger chart distinguishes a high-going PIR from a switch-to-ground input. The [project overview](https://buttonbanger.com/?page_id=164) documents the Uno/Nano/Pro Mini family and records fixes in September 2018 and May 2021, including compatibility work for newer MP3 modules.

## Components and source organization

Paths in this report refer to the inspected installation at `C:\octobanger`.

| Component | Responsibility and evidence |
| --- | --- |
| `OctoBanger.exe` | Windows Forms desktop editor; assembly version 1.0.0.0, NorthOsoft copyright 2017. CLR target v2.0.50727 with 32BITREQUIRED; includes a reference to Ionic.Zip 1.9.1.8. |
| `Hex/src/OctoBanger_TTL.ino` | Main setup, EEPROM storage, configuration validation, trigger polling, sequence playback, diagnostics, and PC serial protocol. Reports firmware version 8.2.0. |
| `Hex/src/PinMaps.h` | Default TTL, Shield, and placeholder Custom pin tables. |
| `Hex/src/MiniMedia.h` | Transmit-only MP3 and Sprite video commands using a software serial transmitter. |
| `Hex/OctoBanger_TTL.hex` | Precompiled firmware uploaded by AVRDUDE. Source equivalence is unverified. |
| `avrdude.exe` and `avrdude.conf` | MCU programming utility and part/programmer definitions. This is separate from the running firmware's serial protocol. |
| `fmodex.dll` | Desktop audio dependency. |
| `Controllers/*/*.OBC` | Serialized desktop project objects; media files live separately. |

The main sketch depends on Arduino `EEPROM.h` and the two local headers. Its major regions are startup at line 94, pin initialization at 127, trigger detection at 173, sequence buffering at 190, configuration loading at 202, reporting at 243, playback at 347, physical output writes at 391, and serial handling at 444. Comments describe the introduction of compression in January 2017 and a playback-counter fix in September 2018. A media change is dated May 2021. The package's 2017 build label therefore does not identify every bundled source revision.

`Database/INFO.xml:13` gives build 2017.3.11. `OctoBanger.exe.config:4` enables update checking; it does not define uploader profiles. Native support files include `fmodex.dll`, `libusb0.dll`, and `cygwin1.dll`. The installed tree did not provide a standalone LICENSE/COPYING file establishing a reuse license for the application.

## Outputs and pin profiles

The firmware supplies eight digital on/off control signals. Electrical load characteristics belong to the connected relay, SSR, LED driver, and power circuitry. Firmware has no PWM dimming, servo positioning, voltage selection, load sensing, or output feedback.

| Function | Default_TTL | Shield |
| --- | --- | --- |
| Channel 1 | D2 | D7 |
| Channel 2 | D3 | D6 |
| Channel 3 | D4 | D5 |
| Channel 4 | D5 | D4 |
| Channel 5 | D6 | D8 |
| Channel 6 | D7 | D9 |
| Channel 7 | D8 | D10 |
| Channel 8 | D9 | D11 |
| Trigger input | D11 | A0 |
| Intended trigger output | D10 | A1 |
| Media serial output | D12 | A2 |

Source: `Hex/src/PinMaps.h:21–25`. Shield mode changes both channel order and the trigger/media pins. Channels 1–4 match the four-relay shield; channels 5–8 remain available separately. The Custom row is an invalid placeholder in this source and falls back to Default_TTL. There is no runtime custom-pin editor in the firmware.

The desktop executable contains a different Shield trigger/media row: **16, 17, 18**, while the source uses **A0, A1, A2**. On the intended ATmega328P Arduino layout these are different connections. The sample's generated `readme.txt:9–13` reproduces the desktop values. Static evidence is the UInt16 pin table at executable file offset `0x45b78`, initialized by method token `0x060004c3`. Configuration sends a profile number, not all the physical pin numbers, so the firmware ultimately controls the assignment. The new app should obtain wiring information from a verified firmware profile rather than copying the old desktop report.

Logical event state is converted to the physical pin level by XOR with the channel's polarity bit: a bit value of 0 means active-high; a bit value of 1 means active-low. An idle state mask of zero returns each output to its configured inactive level. The firmware's no-config fallback uses all active-low outputs, despite an inconsistent source comment and the desktop dialog's active-high default. Evidence: `OctoBanger_TTL.ino:68–77,225–236,391–407`.

## Trigger and playback behavior

`TriggerAmbientLevel` means the **idle input level**:

| Setting | Trigger condition | Input configuration |
| --- | --- | --- |
| Low | Input high | Internal pull-up disabled; suitable for the described PIR, which supplies its idle-low signal. |
| Hi | Input low | Internal pull-up enabled; suitable for a momentary contact to ground. |

The sample guide's page 10 explains that a disconnected PIR can leave a Low-configured input floating; its optional 20 kΩ pull-down retains a defined idle level. Hi is a different trigger wiring choice, not a generic substitute for a pull-down on a high-going input. The local `Docs/pir_info.pdf` also describes idle-low/high-on-detection operation.

Firmware takes two samples 5 ms apart. Hi requires both samples low; Low accepts either sample high, so the debounce is asymmetric. Triggers are level-based: an input held active can start another scene after the sequence and cooldown finish. An already-active input at startup invokes a 30-second guard before automatic triggering. Evidence: `OctoBanger_TTL.ino:115–124,161–188,298–302,347–354`.

The sequence starts media, applies the media delay and additional startup delay, steps through output states, returns outputs to idle, stops the scare track, resumes ambient media if enabled, and waits the reset/end delay. A sequence with zero records returns immediately without starting media (`OctoBanger_TTL.ino:359`). The source blocks serial handling during playback and cooldown. A PC stop command cannot interrupt that implementation as written.

## Timeline timing and sequence capacity

The desktop has **6,000 uncompressed sample bytes at 50 ms each**, giving a **five-minute editing horizon**. Each byte holds the eight channels' logical states for one sample. The executable's `get_MaxMS` method token `0x060004dc` multiplies the array length by 50. Inspected projects all contain a 6,000-byte `_baseChannelData` array.

Device storage uses pairs of bytes:

```text
[eight-channel state mask][duration in nominal 50 ms samples]
```

Repeated unchanged states are compressed into durations, with at most 255 samples per record. The sequence area has 1,000 bytes, or **500 records**. The desktop constants include `FRAMES_MAX=500` and `FRAMES_WARN=450`. The displayed/reporting frame count refers to these compressed records, not the total number of 50 ms samples or a simple count of drawn events. Evidence: `OctoBanger_TTL.ino:7–13,46,264–270,357–376,549–575` and desktop static metadata.

Consequently, a dense sequence changing every 50 ms can exhaust storage in 25 seconds, even though the editor spans five minutes. A sparse sequence uses much less storage. The binary format has a theoretical maximum of 500 × 255 × 50 ms = 106 minutes 15 seconds; that arithmetic is not supported editor duration or a tested hardware capability.

| Timing Offset Type | Firmware interval | Effect |
| --- | --- | --- |
| Default, value 0 | 49.595 ms | Subtracts 0.405 ms from every nominal sample to compensate for the author's observed slow clone timing. |
| None, value 1 | 50.000 ms | Uses the nominal interval measured by the board clock. |

The compensation is 0.81% and accumulates. For 6,000 samples on an accurate clock, Default schedules the end approximately 2.43 seconds earlier than None. It is neither automatic calibration nor a one-time audio shift. Firmware uses cumulative playback deadlines, but its printed duration always assumes 50 ms. Evidence: `OctoBanger_TTL.ino:15–24,33,73–74,264–270,367–376`.

## Media behavior

| Enum | Desktop mode | Idle | Trigger |
| --- | --- | --- | --- |
| 0 | None | No media operation | Sequence outputs only |
| 1 | Mp3_ScareOnly | Stopped | Plays track index 1 |
| 2 | Mp3_Ambient_Scare | Loops track index 1 | Plays track index 2 |
| 3 | Video | Sends initialization byte 0x00 | Sends byte 0x01 to a Sprite video player |

Source: `MiniMedia.h:14–17,85–94,138–180`. Video is control of an external player; the Arduino does not decode video. `Database/INFO.xml:29` identifies the associated hardware as **MedeaWiz Sprite**. Compatibility with other video players is not established.

The MP3 transmitter is annotated as 9600 baud and sends eight-byte commands:

```text
7E FF 06 command 00 data_high data_low EF
```

Implemented commands select microSD/TF storage, set volume, play a numbered track, loop a track, and stop. The firmware sends no filenames and reads no acknowledgments, playback position, completion, or card status. The desktop's SD-card workflow must make the numbered tracks correspond to the scene's media. Desktop metadata labels ambient export `001.mp3` and scare export `002.mp3` (executable offsets `0x1e1b89` and `0x1e1d92`), matching ambient-plus-scare's track indexes. Scare-only firmware plays index 1, so export naming/copy order for that mode must be verified separately.

There is one stored volume for both tracks. Valid configured volume is 1–30; invalid stored values fall back to 15. The no-config fallback uses 22. Sequence completion stops the scare track even if the audio file is longer. The media-delay field actually adds **10 ms per stored unit**, up to 2,550 ms, despite a variable name suggesting hundreds of milliseconds. Desktop unit conversion needs confirmation. Media commands and an additional 100 ms delay precede the sequence clock, so start alignment needs measurement rather than an assumption of simultaneous starts.

Evidence: `MiniMedia.h:22–27,69–103,138–204,229–253`; `OctoBanger_TTL.ino:223–240,360–389`. The [MD_YX5300 library documentation](https://majicdesigns.github.io/MD_YX5300/page_software.html) demonstrates that the broader protocol supports acknowledgments and asynchronous responses; these features are absent from OctoBanger's transmit-only implementation. Its [repository](https://github.com/MajicDesigns/MD_YX5300) identifies an LGPL-3.0 license and is a possible future library candidate, not a selected dependency.

## Configuration storage and serial interface

The sketch identifies itself as 8.2.0. Its EEPROM compatibility signature is the five bytes `{8,2,0,2,6}`. It stores one scene/configuration and copies sequence bytes into a 1,000-byte RAM buffer.

| EEPROM address | Stored value |
| --- | --- |
| 0–999 | Compressed sequence pairs |
| 1000–1001 | Record count, little-endian |
| 1002 | Pin-map enum |
| 1003 | Channel polarity bitmask |
| 1004 | Media-type enum |
| 1005 | Media delay |
| 1006 | End/reset delay in seconds |
| 1007 | Boot delay in seconds |
| 1008 | Volume |
| 1009 | Trigger idle level |
| 1010 | Timing-offset enum |
| 1011–1018 | Unused by this source |
| 1019–1023 | Compatibility signature |

Boot and reset delays are byte values, allowing 0–255 seconds. Source: `OctoBanger_TTL.ino:43–89,202–240`.

The PC serial connection is **115200 baud**. Startup emits `.OBC`, a human-readable configuration report, and `Ready`. Every command starts with ASCII `@` and a command character:

| Command | Behavior |
| --- | --- |
| `@V` | Version |
| `@H` / `@C` | Enable / disable automatic triggering |
| `@D` | Dump EEPROM addresses 0–1018 as 1,019 raw bytes |
| `@F` | Return nine raw configuration bytes |
| `@S` | Upload sequence |
| `@U` | Upload configuration |
| `@P` | Print configuration report |
| `@T` | Play immediately, bypassing automatic-trigger gating |
| `@M` plus one raw byte | Set all eight logical output states |
| `@O` | Return signature validity as `OK` or `NO` |

```text
Sequence upload:
@S <payload_length_lo> <payload_length_hi> <state,duration pairs...>

Configuration upload:
@U 09 00 <pinmap> <polarity> <media> <media_delay>
         <reset_seconds> <boot_seconds> <volume> <trigger_idle> <timing>
```

Lengths are little-endian, and configuration payload length must be nine. Transfers lack checksums, atomic staging, transaction identifiers, and structured completion/error results. Synchronous EEPROM writes mean host pacing also matters. `@U` prints a reconnection request and reloads variables, but does not itself perform an MCU reset or repeat hardware initialization. The observed application disconnect/reconnect supplies the reset lifecycle. Evidence: `OctoBanger_TTL.ino:94–114,444–632`.

`@C` only gates future automatic triggers; it does not stop current playback or clear outputs previously set by `@M` (`OctoBanger_TTL.ino:477–480`).

## Desktop project format

`.OBC` is a .NET BinaryFormatter/NRBF object graph, not text XML or JSON. It contains configuration, channel metadata, the 6,000-sample channel-state array, waveform/cache information, and .NET UI delegate metadata. MP3 audio is separate. A replacement needs an explicit project schema; importing legacy files should decode the data records without instantiating serialized application types.

The root serialized type is `OctoBanger.OctoBangerController`. Its useful fields are:

| Object | Stored fields |
| --- | --- |
| Controller | `_stamp_buff` (8,2,0), `_displayname`, `_filepath`, `_comment`, `_pinMapping`, `_triggerAmbientLevel`, `_timingOffsetType`, `_baseChannels`, `_delayEndSecs`, `_bootDelaySecs`, `_mediaProps`, `_sequence` |
| Channel | `_displayname`, `_comment`, `_drawColor`, `_hiOut`, `_renderHeight` |
| Media | `_ambientFileName`, `_audioFileName`, `_serialMediaType`, `_volume`, `_mediaDelay`, `audiodata` waveform cache |
| Sequence | `_endMS`, `_lockedChannels` (8 booleans), `_baseChannelData` (6,000 bytes) |

`_hiOut` is labeled the channel's off state by the sample report; all inspected channels store false, consistent with unchecked Active Low. Additional persistence details include dirty flags, `LastProperty`, a database-id placeholder and serialized property-change delegates.

Passive parsing consumed all three inspected files. The saved snapshots are:

| Property | Bundled sample | Kenny first | Kenny second |
| --- | --- | --- | --- |
| File size | 20,210 bytes | 66,893 bytes | 66,889 bytes |
| Pin mapping | Shield | Default_TTL | Default_TTL |
| Trigger idle | Low | Low | Low |
| Timing offset | Default | Default | None |
| Boot / end delay | 0 / 15 seconds | 0 / 15 seconds | 0 / 15 seconds |
| Audio mode | Ambient + scare | Ambient + scare | Ambient + scare |
| Volume / media delay | 30 / 0 | 30 / 0 | 30 / 0 |
| Stored sequence end | 4,519 ms | 275,040 ms | 275,040 ms |
| Nonzero timeline samples | 71 | 0 | 366 |

The sample references `Chorus.mp3` and `chainsaw-04.mp3`. Both user projects reference `OnMyOwn.mp3` and `hip pop for us rejects second mix.mp3`. The first user controller has no active samples. The saved second controller includes events near 237.35–244.35 seconds as well as near the beginning. These observations describe saved files, not necessarily the unsaved state shown in the screenshots. Media length and the chosen sequence endpoint are independent.

Reproducible binary anchors: the root member-value block begins at byte 708 in each file. Media/sequence blocks begin at 1505/1809 in the sample, 1450/1777 in the first user controller, and 1453/1780 in the second.

## AVRDUDE configuration and upload profiles

The bundled AVRDUDE binary identifies version **5.11**. Static inspection of the desktop upload handler establishes this command shape:

```text
avrdude.exe -Cavrdude.conf -v -v -v -v -patmega328p -carduino -b57600 -P\\.\<COM port> -D -Uflash:w:"<absolute HEX path>":i
```

| Selected target | Upload baud | Behavior |
| --- | --- | --- |
| Pro Mini | 57,600 | Displays a manual-reset reminder for an adapter without DTR. |
| Nano | 57,600 | Uses the legacy baud profile. The label does not establish compatibility with every Nano bootloader. |
| Uno | 115,200 | Replaces the base command's 57,600 value. |

Arduino's [Nano processor-selection documentation](https://support.arduino.cc/hc/en-us/articles/4401874304274-Select-the-right-processor-for-Arduino-Nano) distinguishes ATmega328P and ATmega328P Old Bootloader choices. A replacement's board profile should represent that distinction rather than relying on a single Nano label.

The command selects the ATmega328P and Arduino programmer, overrides the serial port, disables automatic erase with `-D`, and writes Intel HEX to flash. It has no fuse-write operation and no `-V` option disabling verification. If the adjacent HEX description contains `*** FOR UNO ONLY ***`, the desktop disables the other two board choices.

Evidence: executable upload handler token `0x06000004`; data resource `fe8c30c294a3a8b`, decoded offsets 252 (base arguments), 310/316 (baud values), 323 (port prefix), 331/347 (flash argument), and 107 (reset reminder). UI initializer token `0x0600000b` associates field `0x0400000f` with Uno. Inspection decoded resource data without executing application methods or the uploader.

The configuration file is a large catalog of AVR parts/programmers. Its relevant definitions are:

| Setting | Value | File evidence |
| --- | --- | --- |
| Revision | 991, August 26, 2011 | `avrdude.conf:1` |
| Fallback ports | `lpt1`, `com1` | `:317–318` |
| Default bitclock example | 2.5, commented out | `:319` |
| Programmer | `id="arduino"`, `type=arduino` | `:335–339` |
| MCU entry | `id="m328p"`, description `ATMEGA328P` | `:9235–9237` |
| Device signature | `1E 95 0F` | `:9245` |
| EEPROM | 1,024 bytes; 4-byte page definition, nonpaged | `:9287–9290` |
| Flash | 32,768 bytes; 128-byte pages; 256 pages | `:9321–9325` |
| Fuses | One-byte low, high and extended fuse access definitions | `:9362,9373,9384` |

The file defines how fuse memory can be accessed; it does not choose target fuse values for these boards. The application command, not the fallback `com1` setting, chooses the actual COM port and baud. Flash capacity in the MCU definition is total device capacity, not necessarily space available to an application after a bootloader. Firmware flashing must remain distinct from configuration and sequence uploads through the already-running sketch.

## Source issues affecting compatibility

These findings apply to the inspected source. They have not been reproduced on the attached Arduino or proven present in the shipped HEX.

| Finding | Practical consequence | Source evidence |
| --- | --- | --- |
| Playback pulses `TRIGGER_PINS[2]`, while trigger output initialization uses `[1]`. | Intended daisy-chain trigger pulses go to the media pin in this source. | `.ino:167–168,360–365` |
| Sequence upload buffers before updating the prior zero record count. | First upload after an empty configuration can leave the RAM sequence stale until restart or another upload. | `.ino:190–199,572–575` |
| Playback and cooldown block serial processing and discard received bytes. | Responsive stop and live playback status require firmware work. | `.ino:347–389,425–440` |
| Declared sequence length can exceed accepted storage or be odd. | Malformed uploads or stored counts can lead to out-of-bounds playback. | `.ino:218–221,551–579` |
| Length reads have no timeout; manual output byte is not awaited. | Partial commands can hang or produce unintended behavior. | `.ino:502–504,535–564` |
| Configuration reload omits pin/media initialization. | Reconnection/reset is needed for configuration changes to become fully effective. | `.ino:616–632` |
| Desktop and firmware disagree on Shield auxiliary pins. | Generated wiring reports can point to the wrong pins. | `PinMaps.h:24`; sample readme; executable table described above |

These support a real design choice: retain the legacy protocol behind a compatibility adapter, or ship revised firmware with explicit version/capability reporting and reliable uploads. A new GUI alone cannot remove blocking playback or add features that the existing device protocol cannot represent.

## Comparable projects

The comparison concerns authoring and controller behavior. None of the inspected projects established drop-in compatibility with OctoBanger project files or its installed firmware.

| Project | Relevant capabilities | Ideas to consider and differences |
| --- | --- | --- |
| [Fright Ideas Director](https://www.frightideas.com/director/software) and [Flex 2](https://www.frightideas.com/flex2.html) | Animation/audio editor, managed media export, live preview through compatible hardware; Flex variants offer 2/4/8 outputs, MP3 and trigger inputs. | Closest complete authoring/deployment comparison. Uses vendor hardware. Consider integrated media preparation, live output testing and explicit scene behaviors. |
| [ShowMatic PicoRelay](https://www.frightideas.com/picorelay.html) | Four relays, two inputs, MP3, local recording/storage, WiFi configuration and optional cloud monitoring; operates locally offline. | Useful model for setup beside the prop and visible trigger/device state. Different hardware and channel count. The [vendor category](https://www.frightideas.com/prop-controllers.html) describes newer WiFi products replacing PicoBoos. |
| [SyncSix](https://kurtcontrollers.com/?page_id=304) | Arduino-based six-output controller with ambient/scare MP3, trigger options, button recording and layered overdubbing. [Sketches are public](https://github.com/kurtlamm/SyncSix). | Closest inexpensive Arduino comparison. Button-oriented authoring; no equivalent desktop timeline established. A clear reuse license was not established. |
| [Vixen](https://www.vixenlights.com/docs/started/introduction/) | Windows sequencer with waveform, [timing marks](https://www.vixenlights.com/docs/usage/sequencer/sequencer-basics/marks/), generic serial outputs and [FPP export](https://www.vixenlights.com/docs/usage/general/import-export/falcon-export/). | Strong reference for timeline navigation, named markers and export profiles. A serial output does not by itself provide autonomous Uno playback. |
| [xLights and FPP Connect](https://manual.xlights.org/xlights/chapters/chapter-five-menus/tools/fpp-connect) with [Falcon Player](https://github.com/FalconChristmas/fpp) | Deploys sequence/media/configuration to an autonomous Raspberry Pi or BeagleBone player. FPP supports [GPIO-triggered actions](https://manual.falconplayer.com/060-gpio-inputs/). | Useful model for coordinated deployment and future larger/networked shows. FPP runs on an SBC, not the Uno. |
| [Brookshire VSA](https://www.brookshiresoftware.com/vsa_overview.htm) | Timeline control of relays, servos and motors, media integration, [event editing and capture](https://www.brookshiresoftware.com/vsa-docs/), and compatible hardware exports. | Relevant event semantics, exact timing and channel overdubbing. Commercial product with a different playback hardware ecosystem. |
| [VenueMagic](https://www.venuemagic.com/) | Timeline show control with input-driven actions; [SC+](https://www.venuemagic.com/purchase/) exports to standalone ShowNodes. [Version 4](https://www.venuemagic.com/venuemagic4features/) adds conditions and randomized playback. | Useful reference for separating scene content from trigger rules and multi-zone behavior. Much broader scope and a commercial ecosystem. |

Public source availability and free desktop software do not, by themselves, identify a reuse license. No legacy code or third-party implementation has been incorporated into the replacement.

## Enhancement discussion

The user's existing enhancement ideas should set priorities. The research suggests discussing these decisions before selecting a framework or implementing the editor:

- **Compatibility:** Must existing `.OBC` projects import? Must existing OctoBanger firmware work unchanged, or can the replacement install revised firmware?
- **Hardware scope:** Keep Uno/Nano/Pro Mini, eight binary outputs and YX5300 as the initial target, or include additional boards, channels, servos, dimming, or networked devices?
- **Editing:** Which operations matter most: undo/redo, exact start/end fields, snapping, markers, copy/paste/repeat, group moves, zoom, keyboard shortcuts, or recording channel actions over playback?
- **Scene behavior:** One scare scene or multiple/random variants? Ambient output animation as well as ambient audio? Explicit held-trigger, retrigger and cooldown policies?
- **Deployment and testing:** Unified config/sequence upload, automatic reconnect, readable device state, upload verification, channel tests, simulation and device playback controls?
- **Platform:** Windows-only desktop initially, or cross-platform authoring? Autonomous operation of the prop remains separate from the author's UI platform.

A reasonable starting hypothesis is to keep the inexpensive autonomous hardware and improve the editor and deployment experience, while defining a versioned project format and a replaceable device interface. This is a discussion starting point, not an approved feature list or architecture.

## Evidence identity

The user-provided screenshots document UI behavior. Local source and binary inspection document implementation. The linked project/vendor pages document comparisons as accessed on the research date. No COM port was opened, no firmware or configuration was uploaded, and the installed application and controller files were not modified.

SHA256 values for the inspected artifacts:

```text
Hex/src/OctoBanger_TTL.ino
6C181499C8CDC2F31FC271C2A8DC9012DF193E12ED43B7A6622920ADFC72D2A1
Hex/src/MiniMedia.h
45DC44A5B91CE9552A7866BA9B074E19245DE8BEAE999B12E66B853374F8A8A2
Hex/src/PinMaps.h
9BCBCBC9F6ACB8AEA54F68612AA9B37E666472BF481623BD117C43B933EB6A29
Hex/OctoBanger_TTL.hex
16E14D99CFBF395293375D1F2D5CABB329B54A345B73207C4DD60A94FE9DEC16
avrdude.conf
3144B904192529849D97919A04DAC8E1D5C78600654DAE803DB93A54638E28EC
OctoBanger.exe
A39A4121158EED1A7D0E18E898F3F44430673A196E219AB3517E28E0702DD660
```

## PIR reliability comparison - October 12, 2026

Inspected the installed OctoBanger source, the local SyncSix sketches, and our current firmware and bench project. These findings establish software behavior, not a measured cause of the reported missed detections. No firmware was flashed, no trigger was sent, and the scene was not changed. A read-only COM6 STATUS snapshot reported firmware 0.7.1, valid scene, running false, state 2, and all outputs off. This snapshot does not establish the controller state during earlier failed tests. Firmware 0.7.2's separate sonar/audio arbitration fix remains prepared but not installed.

| Behavior | OctoBanger TTL | SyncSix V1.1 | Cheap Prop Controller/current bench |
| --- | --- | --- | --- |
| Detection | Current active input level | Current active input level | Debounced inactive-to-active change |
| PIR electrical mode | Idle LOW / active HIGH, plain INPUT, no internal pull-up | Standard trigger is active LOW through a 74HC165; external conditioning cannot be established without its schematic | D9, active HIGH, plain INPUT, no internal pull-up |
| Input filtering | Two reads 5 ms apart; active-HIGH accepts either HIGH, despite a comment implying both must agree | No debounce on standard trigger | 100 ms stable activation and release in this project |
| Already active at startup/reset | Active startup postpones acceptance for 30 seconds, then the current level can trigger | Active level can trigger after ordinary initialization | Samples the current level; an already-active input must go inactive and activate again |
| During playback | Blocking playback; input not sampled | Blocking playback; input not sampled | Inputs keep updating; only mappings belonging to the current main state act |
| Still active when back at idle | Can replay after the configured reset delay (default 30 seconds) | Can replay on the next idle check | Does not replay solely because the input is still active |
| Sensor warmup | Configurable boot delay, default zero; separate active-startup guard | No dedicated PIR warmup | No dedicated warmup interval; held-input startup suppression does not suppress later warmup pulses |

Source locations: OctoBanger's [input configuration](C:/octobanger/Hex/src/OctoBanger_TTL.ino:161), [trigger reads](C:/octobanger/Hex/src/OctoBanger_TTL.ino:173), [startup guard](C:/octobanger/Hex/src/OctoBanger_TTL.ino:107), and [playback/cooldown](C:/octobanger/Hex/src/OctoBanger_TTL.ino:370); SyncSix's [main loop](C:/Code/SyncSix/SyncSix_V1.1.ino:87), [blocking playback](C:/Code/SyncSix/SyncSix_V1.1.ino:146), and [trigger bit](C:/Code/SyncSix/SyncSix_V1.1.ino:333); our [debouncer](../../firmware/include/primitives.hpp:13), [baseline initialization](../../firmware/src/main.cpp:143), [input polling](../../firmware/src/main.cpp:231), and [state-specific dispatch](../../firmware/include/scene_image.hpp:276).

In the saved bench, PIR only maps Ambient to Approach. It intentionally has no action in Approach or Scare. Returning to Ambient does not synthesize a new edge from an already-HIGH PIR; Arm/reset while HIGH also waits for a real release. A STOPped controller ignores scene triggers. These conditions can look like missed motion without implying a sensor or debounce fault. No direct raw-input telemetry is currently available to identify which condition occurred in the reported test.

### SyncSix's 3.3 V variant

[SyncSix_3V3Trigger.ino](C:/Code/SyncSix/SyncSix_3V3Trigger.ino:2) replaces ultrasonic sensing with a voltage-sensitive input on A2. It uses a plain input and asserts a trigger when analogRead exceeds its threshold. This is voltage detection, not PIR sensitivity adjustment. The code declares a 2.7 V threshold, but passes it to Arduino's integer map() at line 52: 2.7 becomes 2, giving threshold 409 and acceptance at ADC count 410 or higher, approximately 2.0 V with a 5 V reference. The [installed Arduino implementation](C:/Users/kenne/.platformio/packages/framework-arduino-avr/cores/arduino/WMath.cpp:52) takes integer long arguments. The configurable analog-threshold idea is useful; that conversion should not be copied.

A 5 V ATmega328P digital input is specified to recognize HIGH at 0.6 times VCC, or 3.0 V. A normal approximately 3.3 V PIR output should meet that requirement, but an actual LOW/HIGH voltage measurement at the Uno would distinguish a marginal signal from state/rearm behavior. Sources: [Microchip datasheet, DC characteristics](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf#page=258), [Adafruit PIR testing](https://learn.adafruit.com/pir-passive-infrared-proximity-motion-sensor/testing-a-pir). Analog threshold sensing cannot be enabled on the current D9 wiring; it would require an analog-capable input and a supported allocation/configuration change.

### Applicable improvements and diagnostic order

1. Expose raw HIGH/LOW, debounced activity, waiting-for-release status, controller running/current state, and whether that state has a mapping for the input. Log accepted and ignored activations with a reason. This separates a missing electrical signal from an intentional software gate.
2. Preserve fresh-activation behavior as the default; the user explicitly preferred one-shot scene behavior. An optional active-level-on-entry/retrigger policy would be a deliberate behavior change, not a sensitivity fix.
3. Consider configurable startup settling and explicit readiness. PIR modules can take 30-60 seconds to settle, and the hardware hold time/jumper can keep the output HIGH despite additional movement ([Adafruit testing guide](https://learn.adafruit.com/pir-passive-infrared-proximity-motion-sensor/testing-a-pir)). Do not treat generic pot rotation guidance as authoritative for this user's particular HiLetgo layout.
4. If measured HIGH voltage is marginal, investigate supply/common-ground/wiring or add properly calibrated analog thresholds with hysteresis. There is no evidence yet that reducing the current 100 ms debounce improves detection: normal PIR pulses last much longer.

No dedicated PIR sensitivity algorithm was found in either legacy firmware. SyncSix's BUSY-based suppression near audio completion applies specifically to its ultrasonic path; it is not a PIR reliability mechanism.

The user clarified that the symptom is missed walk-ins. The next discriminating observation is the PIR OUT voltage before and during an apparent miss, with the controller STOPped so the sensor can be evaluated without scene outputs: remaining LOW suggests the module did not detect motion; remaining HIGH means no new edge occurred; a fresh sustained LOW-to-HIGH transition shifts investigation to input recognition and scene readiness. Motion across the lens can be compared with a direct approach. No physical measurements have yet established which case applies.
