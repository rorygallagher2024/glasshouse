#!/usr/bin/env python
#
# Helper for server/lib/remotebuttons.js.
# Reads remote button events on webOS using non-blocking I/O.
# Compatible with both Python 2.7 (webOS 4) and Python 3 (webOS 7 and later).
#
import os
import sys
import time
import select
import struct
import signal
import errno

BUTTON_CODES = {
    398: 'red',
    399: 'green',
    400: 'yellow',
    401: 'blue',
    # Streaming buttons, IR_KEY_* in /usr/share/X11/xkb/keycodes/lg less 8.
    1037: 'netflix',
    1038: 'amazon',
    1042: 'disneyplus',
    1043: 'lgchannels',
    1044: 'rakutentv',
    1086: 'alexa'
}

# The Home button, reported going down and up: Glasshouse Home opens LG's
# Home when it is held. remotebuttons.js has the source of the code.
HOME_CODE = 773

QT_KEY_CODES = {
    18874385: 'red',
    18874386: 'green',
    18874387: 'yellow',
    18874388: 'blue',
    18874408: 'netflix',
    18874409: 'amazon',
    18874396: 'disneyplus',
    18874397: 'lgchannels',
    18874426: 'rakutentv',
    18874416: 'alexa'
}

running = True

def handle_sigterm(signum, frame):
    global running
    running = False

signal.signal(signal.SIGTERM, handle_sigterm)
signal.signal(signal.SIGINT, handle_sigterm)

def open_devices(devs):
    for i in range(16):
        path = '/dev/input/event%d' % i
        if path in devs.values() or not os.path.exists(path):
            continue
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            devs[fd] = path
        except Exception:
            pass


def main():
    devs = {}
    open_devices(devs)
    next_scan = time.time() + 5

    log_path = '/tmp/var/log/inputcommon'
    log_fd = None
    log_pos = 0
    if os.path.exists(log_path):
        try:
            log_pos = os.path.getsize(log_path)
            log_fd = open(log_path, 'r')
            log_fd.seek(log_pos)
        except Exception:
            log_fd = None

    last_press = {}
    debounce_sec = 0.2

    def emit_button(color, code):
        now = time.time()
        if now - last_press.get(color, 0) < debounce_sec:
            return
        last_press[color] = now
        sys.stdout.write('%s %d\n' % (color, code))
        sys.stdout.flush()

    try:
        stdin_fd = sys.stdin.fileno()
    except Exception:
        stdin_fd = -1

    while running:
        # Input devices can disappear/reappear when an app or remote changes.
        # Retry slowly, including paths that failed to open or read earlier.
        if time.time() >= next_scan:
            open_devices(devs)
            next_scan = time.time() + 5
        watch_fds = list(devs.keys())
        if stdin_fd >= 0:
            watch_fds.append(stdin_fd)

        try:
            r, _, _ = select.select(watch_fds, [], [], 0.5)
        except Exception:
            break

        if stdin_fd in r:
            try:
                data = os.read(stdin_fd, 64)
                if not data:
                    break
            except Exception:
                break

        for fd in r:
            if fd == stdin_fd:
                continue
            try:
                buf = os.read(fd, 256)
            except OSError as exc:
                if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR):
                    continue
                buf = b''

            if not buf:
                # select keeps a hung-up evdev fd readable. Keeping it here
                # spins without waiting (millions of reads on the LG C1).
                del devs[fd]
                try:
                    os.close(fd)
                except OSError:
                    pass
                continue

            ev_size = 16 if len(buf) % 16 == 0 else (24 if len(buf) % 24 == 0 else 0)
            if not ev_size:
                continue

            for i in range(0, len(buf), ev_size):
                chunk = buf[i:i + ev_size]
                if len(chunk) == 16:
                    _, _, type_, code, val = struct.unpack('IIHHi', chunk)
                elif len(chunk) == 24:
                    _, _, type_, code, val = struct.unpack('QQHHi', chunk)
                else:
                    continue

                if type_ == 1 and code == HOME_CODE and val in (0, 1):
                    sys.stdout.write('home %d\n' % val)
                    sys.stdout.flush()
                    continue

                if type_ == 1 and val == 1:
                    color = BUTTON_CODES.get(code)
                    if color:
                        emit_button(color, code)
                    else:
                        sys.stdout.write('key %d\n' % code)
                        sys.stdout.flush()

        # webOS rotates inputcommon. Follow the path, not the old fd: if the
        # file was replaced or truncated, reopen it and read the new file from
        # the start. Seeking the old fd back to 0 replays every old press.
        if log_fd is None and os.path.exists(log_path):
            try:
                log_fd = open(log_path, 'r')
                log_pos = 0
            except Exception:
                log_fd = None
        if log_fd:
            try:
                if not os.path.exists(log_path):
                    log_fd.close()
                    log_fd = None
                    continue
                st = os.stat(log_path)
                if (st.st_ino != os.fstat(log_fd.fileno()).st_ino
                        or st.st_size < log_pos):
                    log_fd.close()
                    log_fd = None
                    log_fd = open(log_path, 'r')
                    log_pos = 0
                cur_size = st.st_size
                if cur_size > log_pos:
                    lines = log_fd.readlines()
                    log_pos = log_fd.tell()
                    for line in lines:
                        if 'pressed' in line or 'D_KEY_PRESS' in line:
                            for qt_code, color in QT_KEY_CODES.items():
                                if str(qt_code) in line:
                                    emit_button(color, qt_code)
            except Exception:
                pass

    for fd in devs:
        try:
            os.close(fd)
        except Exception:
            pass
    if log_fd:
        try:
            log_fd.close()
        except Exception:
            pass

if __name__ == '__main__':
    main()
