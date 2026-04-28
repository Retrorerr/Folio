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

    assert retry is first
    assert queue.wait(retry) == ("chunk.wav", 250.0)
