import threading

import pytest
from tts_queue import TTSQueue


def test_errored_jobs_are_retried_for_same_key():
    queue = TTSQueue(worker_count=1)

    def fail():
        raise RuntimeError("boom")

    first = queue.submit("same-chunk", fail, priority=0)
    with pytest.raises(RuntimeError, match="boom"):
        queue.wait(first)

    retry = queue.submit("same-chunk", lambda: ("chunk.wav", 250.0), priority=0)

    assert retry is not first
    assert queue.wait(retry) == ("chunk.wav", 250.0)


def test_retry_does_not_mutate_cancelled_job_handle():
    queue = TTSQueue(worker_count=0)
    cancelled = queue.submit("same-chunk", lambda: ("old.wav", 100.0), priority=0)

    assert queue.cancel_pending(lambda key: key == "same-chunk", reason="stale") == 1
    retry = queue.submit("same-chunk", lambda: ("new.wav", 100.0), priority=0)

    assert retry is not cancelled
    assert retry.ticket > cancelled.ticket
    assert queue.status("same-chunk") == "pending"
    with pytest.raises(RuntimeError, match="stale"):
        queue.wait(cancelled)


def test_running_job_is_not_replaced_by_duplicate_submit():
    queue = TTSQueue(worker_count=1)
    started = threading.Event()
    release = threading.Event()
    calls = []

    def slow():
        calls.append("slow")
        started.set()
        release.wait(timeout=2)
        return ("slow.wav", 100.0)

    first = queue.submit("same-chunk", slow, priority=0)
    assert started.wait(timeout=2)

    duplicate = queue.submit(
        "same-chunk",
        lambda: (_ for _ in ()).throw(AssertionError("duplicate fn should not run")),
        priority=0,
    )

    release.set()

    assert duplicate is first
    assert queue.wait(first) == ("slow.wav", 100.0)
    assert calls == ["slow"]
