"""The browser and the server must agree on the repeated-line key.

`static/js/pdfview.js` computes the `repeated` set in the browser; `classify.py` applies
the header/footer rule on the server using it. The two normalisers drifted once already
(one collapsed digit runs, the other every digit), which silently disabled running-head
skipping on every document. This test and its JS twin read the same fixture file.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kokoro_reader.textpipe.classify import normalize_key

FIXTURE = Path(__file__).parent / "fixtures" / "repeat_keys.json"
CASES = json.loads(FIXTURE.read_text())["cases"]


@pytest.mark.parametrize(("raw", "expected"), CASES)
def test_normalize_key_matches_the_shared_contract(raw, expected):
    assert normalize_key(raw) == expected
