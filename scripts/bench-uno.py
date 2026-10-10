"""Destructive scene-storage acceptance checks for a USB-only test board.

Requires explicit --allow-overwrite and a scene image built for the connected board.
Does not install firmware. Leaves a valid sample scene stored and execution STOPped.
"""
import argparse
import json
from pathlib import Path
import time
import serial

parser = argparse.ArgumentParser()
parser.add_argument('--port', required=True)
parser.add_argument('--image', required=True)
parser.add_argument('--allow-overwrite', action='store_true', required=True)
parser.add_argument('--audio-image')
args = parser.parse_args()
image = Path(args.image).read_bytes()
results = []

def crc16(data):
    crc = 0xffff
    for index, value in enumerate(data):
        if index in (6, 7):
            value = 0
        crc ^= value << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xffff if crc & 0x8000 else (crc << 1) & 0xffff
    return crc

port = serial.Serial(args.port, 115200, timeout=0.1, write_timeout=2)
time.sleep(2)
port.reset_input_buffer()

def command(text, expect_error=False, timeout=4):
    port.write((text + '\n').encode())
    port.flush()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = port.readline().decode('utf-8', errors='replace').strip()
        if not line:
            continue
        try:
            reply = json.loads(line)
        except json.JSONDecodeError:
            continue
        if reply.get('type') in ('state', 'log'):
            continue
        if reply.get('type') == 'error':
            if expect_error:
                return reply
            raise AssertionError(f'{text[:30]} rejected: {reply}')
        if expect_error:
            raise AssertionError(f'Expected rejection: {text[:30]} returned {reply}')
        return reply
    raise AssertionError(f'Timeout for {text[:30]}')

def check(name, assertion, evidence=None):
    if not assertion:
        raise AssertionError(f'FAILED {name}: {evidence}')
    entry = {'check': name, 'passed': True, 'evidence': evidence}
    results.append(entry)
    print(json.dumps(entry), flush=True)

def upload(data, fail_commit=False):
    command(f'BEGIN {len(data)} {int.from_bytes(data[6:8], "little")}')
    for offset in range(0, len(data), 32):
        command(f'DATA {offset} {data[offset:offset+32].hex()}')
    return command('COMMIT', expect_error=fail_commit)

try:
    hello = command('HELLO')
    check('Protocol and target handshake', hello.get('protocol') == 1 and hello.get('board') == 'uno', hello)
    upload(image)
    status = command('STATUS')
    check('Compiled sample accepted in EEPROM', status.get('valid') is True and status.get('state') == 0, status)
    command('RUN')
    command('TRIGGER 0')
    status = command('STATUS')
    check('Idle to Approach transition and active event', status.get('state') == 1 and status.get('outputs') == 1, status)
    command('TRIGGER 1')
    status = command('STATUS')
    check('Approach to Scare transition', status.get('state') == 2, status)
    started = time.monotonic()
    command('STOP')
    latency = (time.monotonic() - started) * 1000
    status = command('STATUS')
    check('STOP responsive and all outputs logically inactive', status.get('running') is False and status.get('outputs') == 0 and latency < 500, {'ackLatencyMs': round(latency, 2), 'status': status})
    command('RUN')
    command('TRIGGER 0')
    command('TRIGGER 1')
    command('TRIGGER 2')
    status = command('STATUS')
    check('Reset trigger returns idle', status.get('state') == 0 and status.get('outputs') == 0, status)
    if args.audio_image:
        upload(Path(args.audio_image).read_bytes())
        time.sleep(1.2)
        response_times = []
        for cycle in range(45):
            command(f'TRIGGER {cycle % 3}')
            start = time.monotonic()
            command('STATUS')
            response_times.append((time.monotonic() - start) * 1000)
            if cycle % 9 == 8:
                command('STOP')
                stopped = command('STATUS')
                check(f'Audio UART stress STOP cycle {cycle + 1}', stopped.get('running') is False and stopped.get('outputs') == 0)
                command('RUN')
        check('Host serial remains responsive during three-player audio traffic', max(response_times) < 500, {'requests': len(response_times), 'maxStatusLatencyMs': round(max(response_times), 2)})
        upload(image)
    command('BEGIN 65535 0', expect_error=True)
    check('Oversize upload rejected before destroying scene', command('STATUS').get('valid') is True)
    command(f'BEGIN {len(image)} {int.from_bytes(image[6:8], "little")}')
    command('DATA 32 00', expect_error=True)
    command('COMMIT', expect_error=True)
    check('Incomplete and out-of-order upload cannot run', command('STATUS').get('running') is False)
    bad_crc = bytearray(image)
    bad_crc[-1] ^= 1
    upload(bad_crc, fail_commit=True)
    check('Corrupted image rejected', command('STATUS').get('valid') is False)
    bad_pin = bytearray(image)
    output_offset = int.from_bytes(bad_pin[20:22], 'little')
    bad_pin[output_offset] = 0
    bad_pin[6:8] = crc16(bad_pin).to_bytes(2, 'little')
    upload(bad_pin, fail_commit=True)
    check('Valid CRC cannot bypass reserved-pin validation', command('STATUS').get('valid') is False)
    upload(image)
    port.dtr = False
    time.sleep(0.1)
    port.dtr = True
    time.sleep(2)
    port.reset_input_buffer()
    status = command('STATUS')
    check('Scene survives controller reset', status.get('valid') is True and status.get('state') == 0, status)
    command('STOP')
    status = command('STATUS')
    check('Bench left stopped', status.get('running') is False and status.get('outputs') == 0, status)
finally:
    try:
        command('STOP')
    except Exception:
        pass
    port.close()
    folder = Path('artifacts')
    folder.mkdir(exist_ok=True)
    (folder / 'uno-bench-results.json').write_text(json.dumps(results, indent=2) + '\n')
