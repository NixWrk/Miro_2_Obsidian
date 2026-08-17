from __future__ import annotations

from pathlib import Path


MIRO_JSON_DIR = Path(__file__).resolve().parents[1] / "Miro_2_Json"

from Miro_2_Json.miro_downloader import (  # noqa: E402
    MAX_RETRY_DELAY_SECONDS,
    _retry_delay_seconds,
)


def test_retry_after_is_finite_nonnegative_and_bounded() -> None:
    fallback = 0.8

    assert _retry_delay_seconds(None, fallback) == fallback
    assert _retry_delay_seconds("NaN", fallback) == fallback
    assert _retry_delay_seconds("-1", fallback) == fallback
    assert _retry_delay_seconds("Infinity", fallback) == fallback
    assert _retry_delay_seconds("not-a-delay", fallback) == fallback
    assert _retry_delay_seconds("0", fallback) == 0
    assert _retry_delay_seconds("999999", fallback) == MAX_RETRY_DELAY_SECONDS
