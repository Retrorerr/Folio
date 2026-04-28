import itertools
import queue
import threading
from dataclasses import dataclass, field
from typing import Callable


@dataclass
class QueueJob:
    key: str
    fn: Callable[[], tuple[str, float]]
    event: threading.Event = field(default_factory=threading.Event)
    status: str = "pending"
    result: tuple[str, float] | None = None
    error: Exception | None = None
    ticket: int = 0


class TTSQueue:
    def __init__(self, worker_count: int = 6):
        self._jobs: dict[str, QueueJob] = {}
        self._queue: queue.PriorityQueue[tuple[int, int, str, int]] = queue.PriorityQueue()
        self._lock = threading.Lock()
        self._counter = itertools.count()
        self._workers = []
        for idx in range(worker_count):
            worker = threading.Thread(target=self._worker_loop, name=f"tts-worker-{idx}", daemon=True)
            worker.start()
            self._workers.append(worker)

    def submit(self, key: str, fn: Callable[[], tuple[str, float]], priority: int = 10) -> QueueJob:
        with self._lock:
            job = self._jobs.get(key)
            if job is None:
                job = QueueJob(key=key, fn=fn)
                self._jobs[key] = job
            elif job.status == "done":
                return job
            elif job.status == "error":
                job.event = threading.Event()
                job.status = "pending"
                job.result = None
                job.error = None

            job.fn = fn
            job.ticket += 1
            ticket = job.ticket
            self._queue.put((priority, next(self._counter), key, ticket))
            return job

    def wait(self, job: QueueJob) -> tuple[str, float]:
        job.event.wait()
        if job.error is not None:
            raise job.error
        if job.result is None:
            raise RuntimeError("TTS job completed without a result")
        return job.result

    def status(self, key: str) -> str | None:
        with self._lock:
            job = self._jobs.get(key)
            return job.status if job else None

    def _worker_loop(self):
        while True:
            _priority, _seq, key, ticket = self._queue.get()
            with self._lock:
                job = self._jobs.get(key)
                if job is None or job.ticket != ticket or job.status == "running":
                    continue
                if job.status == "done":
                    job.event.set()
                    continue
                job.status = "running"

            try:
                result = job.fn()
                with self._lock:
                    job.result = result
                    job.error = None
                    job.status = "done"
            except Exception as exc:
                with self._lock:
                    job.result = None
                    job.error = exc
                    job.status = "error"
            finally:
                job.event.set()
                with self._lock:
                    # Keep errored jobs so status() can report them; only evict completed ones.
                    if self._jobs.get(key) is job and job.status == "done":
                        self._jobs.pop(key, None)
