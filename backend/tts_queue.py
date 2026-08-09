import itertools
import queue
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class QueueJob:
    key: str
    fn: Callable[[], tuple[str, float]]
    event: threading.Event = field(default_factory=threading.Event)
    status: str = "pending"
    result: tuple[str, float] | None = None
    error: Exception | None = None
    ticket: int = 0
    priority: int = 10
    metadata: dict[str, Any] | None = None


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

    def submit(
        self,
        key: str,
        fn: Callable[[], tuple[str, float]],
        priority: int = 10,
        metadata: dict[str, Any] | None = None,
    ) -> QueueJob:
        with self._lock:
            job = self._jobs.get(key)
            if job is None:
                job = QueueJob(key=key, fn=fn)
                self._jobs[key] = job
            elif job.status == "done" or job.status == "running":
                return job
            elif job.status == "error":
                # Keep the failed submission immutable for any callers that
                # still hold its handle. Reusing it can make a late waiter
                # observe the retry's fresh event and block on the wrong job.
                job = QueueJob(key=key, fn=fn, ticket=job.ticket)
                self._jobs[key] = job

            job.fn = fn
            job.priority = priority
            job.metadata = metadata
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

    def cancel_pending(self, predicate: Callable[[str], bool], reason: str = "Cancelled") -> int:
        """Cancel queued jobs that have not started yet.

        Running model calls are intentionally left alone: killing an in-flight
        local model generation is not safe, but dropping stale pending work
        prevents the queue from loading another engine after the current job.
        """
        cancelled = 0
        with self._lock:
            for job in list(self._jobs.values()):
                if job.status != "pending" or not predicate(job.key):
                    continue
                job.ticket += 1
                job.result = None
                job.error = RuntimeError(reason)
                job.status = "error"
                job.event.set()
                cancelled += 1
        return cancelled

    def has_active_priority_at_or_below(self, priority: int) -> bool:
        with self._lock:
            return any(
                job.priority <= priority and job.status in {"pending", "running"}
                for job in self._jobs.values()
            )

    def activity(self, pending_limit: int = 12) -> dict:
        def serialize(job: QueueJob) -> dict:
            return {
                "key": job.key,
                "status": job.status,
                "priority": job.priority,
                "metadata": dict(job.metadata or {}),
            }

        with self._lock:
            running = [
                serialize(job)
                for job in self._jobs.values()
                if job.status == "running"
            ]
            pending = sorted(
                (
                    serialize(job)
                    for job in self._jobs.values()
                    if job.status == "pending"
                ),
                key=lambda item: (item["priority"], item["key"]),
            )[:pending_limit]

        active = running[0] if running else (pending[0] if pending else None)
        return {
            "active": active,
            "running": running,
            "pending": pending,
        }

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
                    if self._jobs.get(key) is job and job.status == "done":
                        self._jobs.pop(key, None)
