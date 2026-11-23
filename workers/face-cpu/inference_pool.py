"""Persistent native inference children with interruptible, public process control.

Each child owns its models. Pipe reads run in bounded I/O threads; terminating a
child closes its pipes, so a native crash cannot deadlock a process-pool queue.
"""
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
import multiprocessing
from pathlib import Path
import pickle
import struct
import subprocess
import sys
import threading


def _read(stream):
    header = stream.read(8)
    if len(header) != 8:
        raise RuntimeError("Inference process interrupted")
    size = struct.unpack("!Q", header)[0]
    data = stream.read(size)
    if len(data) != size:
        raise RuntimeError("Inference result interrupted")
    return pickle.loads(data)


def _write(stream, value):
    data = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
    stream.write(struct.pack("!Q", len(data)))
    stream.write(data)
    stream.flush()


class Result:
    def __init__(self, future):
        self.future = future

    def get(self, timeout):
        try:
            return self.future.result(timeout=timeout)
        except FutureTimeout as error:
            raise multiprocessing.TimeoutError() from error


class InferencePool:
    def __init__(self, processes, model_paths):
        self.model_paths = model_paths
        self.executor = ThreadPoolExecutor(max_workers=processes, thread_name_prefix="inference-io")
        self.locks = [threading.Lock() for _ in range(processes)]
        self.processes = []
        self.index = 0
        self.stopped = threading.Event()
        self.process_lock = threading.Lock()
        try:
            for _ in range(processes):
                self.processes.append(self._start())
        except Exception:
            self.terminate()
            self.join()
            raise

    def _start(self):
        return subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--serve", *self.model_paths],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        )

    def _analyze(self, index, path):
        with self.locks[index]:
            with self.process_lock:
                if self.stopped.is_set():
                    raise RuntimeError("Inference stopped")
                process = self.processes[index]
                if process.poll() is not None:
                    process.stdin.close()
                    process.stdout.close()
                    process = self.processes[index] = self._start()
            _write(process.stdin, path)
            result = _read(process.stdout)
            if isinstance(result, Exception):
                raise result
            return result

    def apply_async(self, _function, args):
        index = self.index % len(self.processes)
        self.index += 1
        return Result(self.executor.submit(self._analyze, index, args[0]))

    def terminate(self):
        with self.process_lock:
            self.stopped.set()
            for process in self.processes:
                if process.poll() is None:
                    process.kill()

    def close(self):
        # Every submitted result has completed before a normal close.
        self.stopped.set()
        for process in self.processes:
            process.stdin.close()

    def join(self):
        for process in self.processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        self.executor.shutdown(wait=True, cancel_futures=True)
        for process in self.processes:
            process.stdin.close()
            process.stdout.close()


def serve():
    import cv2
    from faces import Models, analyze

    cv2.setNumThreads(1)
    models = Models(*sys.argv[2:])
    while True:
        try:
            path = _read(sys.stdin.buffer)
        except RuntimeError:
            return
        try:
            file = Path(path)
            if file.stat().st_size > 200 * 1024 * 1024:
                raise ValueError("source exceeds size limit")
            result = analyze(models, file.read_bytes())
        except Exception as error:
            result = error
        _write(sys.stdout.buffer, result)


if __name__ == "__main__":
    serve()
