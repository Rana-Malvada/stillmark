"""Warm model processes with bounded, nonblocking parent-side I/O and shutdown.

One request occupies one process. A timed-out/crashed process and its descendants
are discarded; the next request starts a replacement without losing other slots.
Only this worker's own children exchange the private framed pickle protocol.
"""
from concurrent.futures import Future
import os
from pathlib import Path
import pickle
import select
import signal
import struct
import subprocess
import sys
import time

MAX_MESSAGE_BYTES = 32 * 1024 * 1024


def frame(value):
    data = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
    if len(data) > MAX_MESSAGE_BYTES:
        raise ValueError('Inference message exceeds limit')
    return struct.pack('!Q', len(data)) + data


def read_message(stream):
    header = stream.read(8)
    if not header:
        raise EOFError()
    if len(header) != 8:
        raise ValueError('Interrupted inference header')
    length = struct.unpack('!Q', header)[0]
    if length > MAX_MESSAGE_BYTES:
        raise ValueError('Inference message exceeds limit')
    data = stream.read(length)
    if len(data) != length:
        raise ValueError('Interrupted inference message')
    return pickle.loads(data)


class InferencePool:
    def __init__(self, workers, *, timeout=180, command=None):
        if workers < 1 or timeout <= 0:
            raise ValueError('Invalid inference pool limits')
        self.timeout = timeout
        self.command = command or [sys.executable, str(Path(__file__).resolve()), '--serve']
        self.slots = [None] * workers
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

    def _start(self):
        process = subprocess.Popen(self.command, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, start_new_session=True)
        os.set_blocking(process.stdin.fileno(), False)
        os.set_blocking(process.stdout.fileno(), False)
        return {'process': process, 'future': None, 'write': b'', 'read': bytearray()}

    def submit(self, function, *args):
        # Keep the existing photo executor interface, while rank uses submit_rank.
        return self._submit(('photo', args[0]))

    def submit_rank(self, query, documents):
        return self._submit(('rank', query, documents))

    def _submit(self, payload):
        if self.closed:
            raise RuntimeError('Inference pool closed')
        data = frame(payload)
        for index, slot in enumerate(self.slots):
            if slot is not None and slot['future'] is not None:
                continue
            if slot is not None and slot['process'].poll() is not None:
                self._discard(index)
                slot = None
            if slot is None:
                slot = self.slots[index] = self._start()
            future = slot['future'] = Future()
            slot.update(write=data, read=bytearray(), deadline=time.monotonic() + self.timeout)
            return future
        raise RuntimeError('No free inference slot')

    def _discard(self, index):
        slot = self.slots[index]
        if slot is None:
            return
        process = slot['process']
        # Native OCR may spawn descendants. Kill the process group even if its
        # leader already exited, so descendants cannot hold stdout or CPU open.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError:
            # Darwin can report EPERM for a group whose sole child has exited
            # but has not been reaped yet. A live, unkillable child is an error.
            if process.poll() is None:
                raise
        try:
            process.wait(timeout=.1)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            if process.poll() is None:
                raise
        process.wait(timeout=1)
        process.stdin.close()
        process.stdout.close()
        self.slots[index] = None

    def cancel(self, future, error=None):
        for index, slot in enumerate(self.slots):
            if slot is not None and slot['future'] is future:
                self._discard(index)
                if not future.done():
                    future.set_exception(error or InterruptedError('Inference stopped'))
                return

    def poll(self, timeout=.25):
        active = [(i, s) for i, s in enumerate(self.slots) if s and s['future']]
        if not active:
            return
        for _, slot in active:
            if time.monotonic() >= slot['deadline']:
                self.cancel(slot['future'], TimeoutError('Inference deadline reached'))
        active = [(i, s) for i, s in enumerate(self.slots) if s and s['future']]
        if not active:
            return
        timeout = max(0, min(timeout, min(s['deadline'] for _, s in active) - time.monotonic()))
        readable, writable, _ = select.select(
            [s['process'].stdout for _, s in active],
            [s['process'].stdin for _, s in active if s['write']], [], timeout)
        for index, slot in active:
            try:
                process = slot['process']
                if process.stdin in writable:
                    written = os.write(process.stdin.fileno(), slot['write'][:65536])
                    slot['write'] = slot['write'][written:]
                if process.stdout in readable:
                    data = os.read(process.stdout.fileno(), 65536)
                    if not data:
                        raise RuntimeError('Inference process interrupted')
                    slot['read'].extend(data)
                    if len(slot['read']) >= 8:
                        length = struct.unpack('!Q', slot['read'][:8])[0]
                        if length > MAX_MESSAGE_BYTES:
                            raise ValueError('Inference response exceeds limit')
                        if len(slot['read']) >= 8 + length:
                            kind, result = pickle.loads(slot['read'][8:8 + length])
                            if kind not in ('ok', 'error'):
                                raise ValueError('Invalid inference response')
                            future = slot['future']
                            slot['future'] = None
                            if kind == 'ok':
                                future.set_result(result)
                            elif kind == 'error':
                                error = {'ValueError': ValueError, 'TimeoutError': TimeoutError,
                                         'FileNotFoundError': FileNotFoundError}.get(result, RuntimeError)
                                future.set_exception(error('Inference failed: ' + str(result)))
            except (OSError, EOFError, ValueError, RuntimeError, pickle.PickleError) as error:
                future = slot['future']
                self._discard(index)
                if future is not None and not future.done():
                    future.set_exception(error)

    def close(self):
        self.closed = True
        for index, slot in enumerate(self.slots):
            if slot is not None:
                future = slot['future']
                self._discard(index)
                if future is not None and not future.done():
                    future.set_exception(InterruptedError('Inference pool closed'))


def serve():
    # Model/library messages must not corrupt the result protocol on stdout.
    output = os.fdopen(os.dup(sys.stdout.fileno()), 'wb')
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    from worker import initialize_photo_worker, process_photo
    initialize_photo_worker()
    from worker import photo_models
    while True:
        try:
            request = read_message(sys.stdin.buffer)
        except EOFError:
            return
        try:
            if request[0] == 'photo':
                result = process_photo(request[1])
            elif request[0] == 'rank':
                result = photo_models.rank(request[1], request[2])
            else:
                raise ValueError('Invalid inference operation')
            response = ('ok', result)
        except Exception as error:
            response = ('error', type(error).__name__)
        output.write(frame(response))
        output.flush()


if __name__ == '__main__':
    serve()
