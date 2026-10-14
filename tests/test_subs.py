"""T6: user substitutions change what the voice says, never what the page shows.

`GR00T` is printed text Kokoro spells out letter by letter; a substitution makes it say
"groot". D1 puts the rewrite on `_voice`'s local copy of the raw text, so `block.text`,
`block.items` and every sentence's highlight items must come out exactly as they would
without it.
"""

from __future__ import annotations

import pytest

from kokoro_reader import config
from kokoro_reader.config import Substitution
from kokoro_reader.textpipe import subs

from .test_integration import _payload, client  # noqa: F401 - `client` is a fixture
from .test_pipeline import THREE_SENTENCES, assert_sane, build, only_block, para_page

GROOT = Substitution(find="GR00T", replace="groot")

GROOT_PARAGRAPH = (
    "We introduce GR00T N1, an open foundation model for humanoid robots.",
    "The GR00T model reads images and language. Unlike GR00TN1 variants, it",
    "runs a diffusion head so that GR00T acts at a high control frequency.",
)


def spoken_text(sentences) -> str:
    return " ".join(s.text for s in sentences)


# ── Matching rules (D3) ───────────────────────────────────────────────────────


@pytest.mark.parametrize("text, expected", [
    ("GR00T N1 is here.", "groot N1 is here."),
    ("(GR00T), GR00T.", "(groot), groot."),
    ("GR00T-N1", "groot-N1"),                     # a hyphen ends a word
    ("GR00TN1 and xGR00T", "GR00TN1 and xGR00T"),  # never inside a longer token
    ("GR00T_2", "GR00T_2"),                       # `_` joins a word, as in `x_t`
    ("Gr00t and gr00t", "Gr00t and gr00t"),       # case-sensitive by default
])
def test_whole_word_case_sensitive_by_default(text, expected):
    assert subs.apply(text, (GROOT,)) == expected


def test_ignore_case_matches_any_spelling():
    rule = Substitution(find="gr00t", replace="groot", ignore_case=True)
    assert subs.apply("GR00T, Gr00t and gr00t but not GR00TN1", (rule,)) == \
        "groot, groot and groot but not GR00TN1"


@pytest.mark.parametrize("find, text, expected", [
    ("π0", "the π0 policy and π0-FAST beat aπ0 and π01", "the pi zero policy and pi zero-FAST beat aπ0 and π01"),
    ("C++", "C++ and C++11 code", "pi zero and C++11 code"),
    ("R&D", "our R&D team", "our pi zero team"),
])
def test_boundaries_hold_for_non_ascii_and_punctuated_terms(find, text, expected):
    """`\\b` cannot bound a term ending in `+`; the lookarounds can."""
    assert subs.apply(text, (Substitution(find=find, replace="pi zero"),)) == expected


def test_find_text_is_literal_not_a_regex():
    rule = Substitution(find="a.b", replace="X")
    assert subs.apply("a.b axb", (rule,)) == "X axb"
    assert subs.apply("backslash \\1", (Substitution(find="backslash", replace="\\1"),)) == "\\1 \\1"


def test_a_phrase_matches_across_any_whitespace():
    rule = Substitution(find="GR00T N1", replace="groot en one")
    assert subs.apply("GR00T  N1 and GR00T\nN1", (rule,)) == "groot en one and groot en one"


def test_longest_term_wins_and_replacements_are_not_chained():
    rules = (Substitution("GR00T", "groot"), Substitution("GR00T N1", "groot en one"),
             Substitution("groot", "WRONG"))
    assert subs.apply("GR00T N1 then GR00T", rules) == "groot en one then groot"


def test_no_substitutions_returns_the_text_unchanged():
    assert subs.apply("GR00T", ()) == "GR00T"


@pytest.mark.parametrize("a, b, duplicate", [
    (Substitution("GR00T", "x"), Substitution("GR00T", "y"), True),
    (Substitution("GR00T", "x"), Substitution("Gr00t", "y"), False),
    (Substitution("GR00T", "x"), Substitution("gr00t", "y", ignore_case=True), True),
])
def test_same_find(a, b, duplicate):
    assert subs.same_find(a, b) is duplicate
    assert (subs.first_duplicate((a, b)) is b) is duplicate


# ── Pipeline (D1) ─────────────────────────────────────────────────────────────


def test_groot_is_spoken_while_block_text_and_items_are_unchanged():
    page = [para_page(1, GROOT_PARAGRAPH)]
    plain_block, plain = only_block(page)
    block, sentences = only_block(page, substitutions=(GROOT,))

    said = spoken_text(sentences)
    assert said.count("groot") == 3
    assert "GR00T " not in said and "GR00T," not in said and "GR00TN1" in said
    assert block.text == plain_block.text and "GR00T" in block.text
    assert block.items == plain_block.items and block.line_ids == plain_block.line_ids
    assert all(s.raw == block.text for s in sentences)
    # Same sentence count, so the per-sentence highlight is exactly what it was without it.
    assert [s.items for s in sentences] == [s.items for s in plain]
    assert len(sentences) > 1 and any(s.items != block.items for s in sentences)
    assert_sane(block, sentences)


def test_substitutions_see_the_raw_text_before_normalize():
    # normalize turns "%" into " percent", so a sub on the raw symbol only works before it.
    rule = Substitution(find="pp%", replace="percentage points")
    page = [para_page(1, ("Success rose by 12 pp% on the kitchen tasks.",))]
    _, sentences = only_block(page, substitutions=(rule,))
    assert "12 percentage points on" in spoken_text(sentences)


def test_a_replacement_that_adds_a_sentence_falls_back_to_the_coarse_highlight():
    """A sub cannot slide a highlight: a new boundary makes the pairing coarse, never wrong."""
    block, sentences = only_block([para_page(1, THREE_SENTENCES)],
                                  substitutions=(Substitution("variance", "spread. It is"),))
    assert "spread. It is" in spoken_text(sentences)
    assert all(s.items == block.items for s in sentences)
    assert_sane(block, sentences)


def test_a_replacement_that_removes_every_word_skips_the_block_with_a_reason():
    rules = tuple(Substitution(w.strip(".,"), "") for w in set(" ".join(THREE_SENTENCES).split()))
    unique = tuple({r.find: r for r in rules}.values())
    sentences, blocks, _ = build([para_page(1, THREE_SENTENCES)], substitutions=unique)
    assert not sentences
    assert all(not b.speak and b.reason for b in blocks)


def test_the_invariants_hold_across_a_document_with_substitutions():
    pages = [para_page(1, GROOT_PARAGRAPH), para_page(2, THREE_SENTENCES)]
    rules = (GROOT, Substitution("model", "network", ignore_case=True))
    sentences, blocks, _ = build(pages, substitutions=rules)
    by_key = {(b.page, b.text): b for b in blocks}
    assert sentences
    for s in sentences:
        assert_sane(by_key[(s.page, s.raw)], [s])


# ── Route boundary ────────────────────────────────────────────────────────────


def _groot_page():
    from .test_integration import _line

    page = _payload()["pages"][0]
    return {**page, "lines": [*page["lines"][:1],
                              _line(1, "We show that GR00T converges at the expected rate.", 140.0),
                              *page["lines"][2:]]}


def build_with(client, substitutions):  # noqa: F811 - `client` is the fixture
    return client.post("/api/script/build", json=_payload(
        pages=[_groot_page()], options={"substitutions": substitutions}))


def test_route_applies_substitutions(client):  # noqa: F811
    res = build_with(client, [{"find": " GR00T ", "replace": " groot ", "ignore_case": False}])
    assert res.status_code == 200, res.text
    body = res.json()
    said = " ".join(s["text"] for s in body["sentences"])
    assert "groot converges" in said and "GR00T" not in said
    assert any("GR00T" in b["text"] for b in body["blocks"])


def test_route_without_substitutions_is_unchanged(client):  # noqa: F811
    said = " ".join(s["text"] for s in build_with(client, []).json()["sentences"])
    assert "GR00T converges" in said


@pytest.mark.parametrize("substitutions", [
    [{"find": "", "replace": "x"}],
    [{"find": "   ", "replace": "x"}],
    [{"find": "GR00T", "replace": "a"}, {"find": "GR00T", "replace": "b"}],
    [{"find": "GR00T", "replace": "a"}, {"find": "gr00t", "replace": "b", "ignore_case": True}],
    [{"find": "x" * (config.MAX_SUB_FIND_CHARS + 1), "replace": "x"}],
    [{"find": "GR00T", "replace": "x" * (config.MAX_SUB_REPLACE_CHARS + 1)}],
    [{"find": f"term{i}", "replace": "x"} for i in range(config.MAX_SUBSTITUTIONS + 1)],
    [{"find": "GR\x0000T", "replace": "x"}],
    [{"find": "GR00T", "replace": "gro\not"}],
    [{"replace": "x"}],
    [{"find": 5, "replace": "x"}],
    "GR00T=groot",
])
def test_route_rejects_invalid_substitutions(client, substitutions):  # noqa: F811
    assert build_with(client, substitutions).status_code == 422


def test_route_accepts_the_limits_exactly(client):  # noqa: F811
    rules = [{"find": f"term{i}", "replace": "x" * config.MAX_SUB_REPLACE_CHARS}
             for i in range(config.MAX_SUBSTITUTIONS - 1)]
    rules.append({"find": "G" * config.MAX_SUB_FIND_CHARS, "replace": "x"})
    assert build_with(client, rules).status_code == 200


def test_read_options_substitutions_are_immutable():
    from kokoro_reader.routes.script import OptionsModel

    opts = OptionsModel(substitutions=[{"find": "GR00T", "replace": "groot"}]).to_options()
    assert opts.substitutions == (GROOT,)
    assert isinstance(opts.substitutions, tuple)
    with pytest.raises(AttributeError):
        opts.substitutions[0].find = "x"  # type: ignore[misc]
    hash(opts)  # frozen all the way down, so it can key a cache
