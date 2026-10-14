"""Tests for kokoro_reader.textpipe.normalize (R5: citations are not read)."""

from __future__ import annotations

import pytest

from kokoro_reader import config
from kokoro_reader.textpipe.normalize import (
    dehyphenate,
    expand_abbreviations,
    fix_ligatures,
    is_speakable,
    normalize,
    split_sentences,
    strip_citations,
)

# ── fix_ligatures ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "glyph,expected",
    [("ﬁ", "fi"), ("ﬂ", "fl"), ("ﬀ", "ff"), ("ﬃ", "ffi"), ("ﬄ", "ffl"),
     ("ﬅ", "st"), ("ﬆ", "st")],
)
def test_fix_ligatures_expands_every_presentation_form(glyph: str, expected: str) -> None:
    # Arrange / Act
    result = fix_ligatures(f"a{glyph}b")

    # Assert
    assert result == f"a{expected}b"


def test_fix_ligatures_replaces_curly_quotes_and_apostrophes() -> None:
    # Arrange
    text = "“the model’s ‘best’ result”"

    # Act
    result = fix_ligatures(text)

    # Assert
    assert result == "\"the model's 'best' result\""


def test_fix_ligatures_normalises_en_and_em_dashes() -> None:
    # Arrange
    text = "pages 10–15 were fine—mostly"

    # Act
    result = fix_ligatures(text)

    # Assert
    assert result == "pages 10-15 were fine — mostly"


def test_fix_ligatures_removes_invisible_spaces_and_soft_hyphens() -> None:
    # Arrange
    text = "co­operate​now here﻿"

    # Act
    result = fix_ligatures(text)

    # Assert
    assert result == "cooperatenow here"


def test_fix_ligatures_folds_mathematical_alphanumeric_letters_to_ascii() -> None:
    """Cosmos p12 sets `H/s_HW` in Mathematical Italic, which nothing downstream reads.

    mathspeak's `_IDENT` class is ASCII plus Greek, so U+1D400-U+1D7FF letters fall
    through every subscript, fraction and function rule untouched and reach the voice
    as raw codepoints. 547 characters over 81 spoken blocks of the 11-paper corpus.
    """
    # Arrange
    text = ("\U0001d43b/\U0001d460_\U0001d43b\U0001d44a and \U0001d70e over \U0001d7ce"
            " and \U0001d4d2 and \U0001d524")

    # Act
    result = fix_ligatures(text)

    # Assert
    assert result == "H/s_HW and \u03c3 over 0 and C and g"


def test_fix_ligatures_leaves_the_glyphs_mathspeak_already_speaks_alone() -> None:
    """Script and double-struck capitals carry meaning a fold would destroy.

    mathspeak reads the double-struck letters as the sets they name and the script
    capitals as plain names, with a special case for big-O; NFKC would flatten all of
    them to bare capitals first and the words would be lost. Neither sub-block appears
    in the corpus's spoken text at all, so excluding both costs nothing measurable.
    """
    # Arrange
    text = "x \u2208 \u211d and \U0001d53c[x] and \U0001d4aa(n) and \U0001d543"

    # Act
    result = fix_ligatures(text)

    # Assert
    assert result == text


# ── dehyphenate ───────────────────────────────────────────────────────────────


def test_dehyphenate_rejoins_word_split_across_a_line_break() -> None:
    # Arrange
    text = "the informa-\ntion content"

    # Act
    result = dehyphenate(text)

    # Assert
    assert result == "the information content"


def test_dehyphenate_rejoins_word_split_by_hyphen_and_space() -> None:
    # Arrange / Act
    result = dehyphenate("the informa- tion content")

    # Assert
    assert result == "the information content"


def test_dehyphenate_preserves_genuine_hyphenated_compounds() -> None:
    # Arrange
    text = "a state-of-the-art non-linear model"

    # Act
    result = dehyphenate(text)

    # Assert
    assert result == text


@pytest.mark.parametrize(
    "text,expected",
    [
        # PI0_6.pdf, PiZero.pdf, VLALitReview.pdf — the commonest compound in the corpus.
        ("a vision-language- action model", "a vision-language-action model"),
        ("the state-of-the- art result", "the state-of-the-art result"),
        ("evaluated out-of- distribution", "evaluated out-of-distribution"),
        # ...and across a real line break, which is where the split comes from.
        ("a vision-language-\naction model", "a vision-language-action model"),
    ],
)
def test_dehyphenate_keeps_the_hyphen_when_a_compound_is_split(
    text: str, expected: str
) -> None:
    """M4 — `state-of-the- art` was being glued into `state-of-theart`.

    A hyphen directly before the fragment means the break happened inside a compound,
    whose parts are whole words; dropping the hyphen there produces a word no voice can
    say. 32 such splits appear across the 13-PDF corpus.
    """
    # Arrange / Act
    result = dehyphenate(text)

    # Assert
    assert result == expected


def test_dehyphenate_of_a_suffix_after_a_compound_keeps_a_spurious_hyphen() -> None:
    """The known cost of the rule above, recorded rather than hidden.

    `high-dimen- sional` is a genuine word break that happens to follow a hyphen, so it
    becomes `high-dimen-sional` instead of `high-dimensional`. Telling the two apart
    needs a dictionary the pure functions here do not have. It is 4 of the 32 splits in
    the corpus, and it still reads as the right words; the alternative mangles the other
    28 into `vision-languageaction`.
    """
    # Arrange / Act / Assert
    assert dehyphenate("a high-dimen- sional space") == "a high-dimen-sional space"


def test_dehyphenate_does_not_join_before_a_capital_or_digit() -> None:
    # Arrange
    text = "the pre-\nTrained model and the top-\n5 error"

    # Act
    result = dehyphenate(text)

    # Assert
    assert result == text


def test_dehyphenate_does_not_join_when_the_head_is_one_character() -> None:
    # Arrange / Act
    result = dehyphenate("an x- ray scan")

    # Assert
    assert result == "an x- ray scan"


# ── strip_citations ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text,expected",
    [
        ("as shown [12] here", "as shown here"),
        ("as shown [3, 7-9] here", "as shown here"),
        ("as shown [12], [15] here", "as shown here"),
        ("as shown [4; 9] here", "as shown here"),
    ],
)
def test_strip_citations_removes_numeric_bracket_citations(text: str, expected: str) -> None:
    # Arrange / Act
    result = strip_citations(text)

    # Assert
    assert result == expected


@pytest.mark.parametrize(
    "text",
    [
        "the [MASK] token is predicted",
        "the [CLS] token is pooled",
        "see [Appendix A] for details",
    ],
)
def test_strip_citations_keeps_non_citation_brackets(text: str) -> None:
    # Arrange / Act
    result = strip_citations(text)

    # Assert
    assert result == text


@pytest.mark.parametrize(
    "text,expected",
    [
        ("This holds (Smith et al., 2020).", "This holds."),
        ("This holds (Smith & Jones 2019; Lee 2021).", "This holds."),
        ("This holds (see Kingma and Ba, 2015).", "This holds."),
        ("We use Adam (Kingma et al. 2015) throughout.", "We use Adam throughout."),
    ],
)
def test_strip_citations_removes_author_year_parentheticals(text: str, expected: str) -> None:
    # Arrange / Act
    result = strip_citations(text)

    # Assert
    assert result == expected


@pytest.mark.parametrize(
    "text",
    [
        "the value is (x + 1) exactly",
        "the result (as shown below) is stable",
        "we set (alpha, beta) to zero",
    ],
)
def test_strip_citations_keeps_ordinary_and_math_parentheticals(text: str) -> None:
    # Arrange / Act
    result = strip_citations(text)

    # Assert
    assert result == text


@pytest.mark.parametrize(
    "text",
    [
        # PiZero.pdf p3 / PI0_6.pdf p2 / GR00TN1.pdf p5 — flow-matching timesteps.
        "with a flow matching timestep τ ∈ [0, 1] and sampled noise",
        # mml-book.pdf — canonical basis vectors and a solution vector.
        "Consider R2 with the canonical basis e = [1, 0]⊤, e = [0, 1]⊤.",
        "Therefore, a solution is [42, 8, 0, 0]⊤.",
        "the vector [1, 0, 0, 0]⊤ cannot be obtained by a linear combination",
        # mml-book.pdf — probability lives in an interval.
        "the probability of a single event must lie in the interval [0, 1], and",
        "numbers that provide a uniform sample in the interval [0,1]; second,",
        # VJEPA_2.pdf p8 — index-set notation, no zero to give it away.
        "a sequence of actions (ak)k∈[15] by computing the change",
    ],
)
def test_strip_citations_keeps_numeric_intervals_and_vectors(text: str) -> None:
    """M1 — `[0, 1]` and `[1, 0, 0]` are maths, and deleting them corrupts the sentence.

    Bibliographies number from 1, so a zero inside the brackets is decisive: all 46
    zero-bearing bracket groups across 13 real PDFs were intervals or vectors, and none
    of the other 1,148 was. A set-membership glyph in front settles the rest.
    """
    # Arrange / Act
    result = strip_citations(text)

    # Assert
    assert result == text


def test_strip_citations_removes_a_trailing_year_fragment() -> None:
    # Arrange
    text = "reported by Smith, 2020) in the survey"

    # Act
    result = strip_citations(text)

    # Assert
    assert result == "reported by Smith in the survey"


def test_strip_citations_repairs_the_space_left_before_punctuation() -> None:
    # Arrange
    text = "the effect is shown [12] ."

    # Act
    result = strip_citations(text)

    # Assert
    assert result == "the effect is shown."


# ── expand_abbreviations ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text,expected",
    [
        ("e.g., the model", "for example, the model"),
        ("i.e., the model", "that is, the model"),
        ("cf. the survey", "compare the survey"),
        ("A vs. B", "A versus B"),
        ("see Fig. 3", "see Figure 3"),
        ("see Eq. 4", "see Equation 4"),
        ("see Sec. 2", "see Section 2"),
        ("see Ref. 8", "see Reference 8"),
        ("see Tab. 1", "see Table 1"),
        ("see App. C", "see Appendix C"),
        ("approx. 40 items", "approximately 40 items"),
        ("x and y, resp. here", "x and y, respectively here"),
        ("optimal w.r.t. the loss", "optimal with respect to the loss"),
        ("choose z s.t. z is positive", "choose z such that z is positive"),
        ("by Thm. 2", "by Theorem 2"),
        ("by Def. 1", "by Definition 1"),
        ("by Lem. 3", "by Lemma 3"),
        ("by Prop. 4", "by Proposition 4"),
        ("by Cor. 5", "by Corollary 5"),
        ("by Alg. 6", "by Algorithm 6"),
        ("apples, oranges, etc. here", "apples, oranges, et cetera here"),
    ],
)
def test_expand_abbreviations_spells_out_academic_shorthand(text: str, expected: str) -> None:
    # Arrange / Act
    result = expand_abbreviations(text)

    # Assert
    assert result == expected


def test_expand_abbreviations_preserves_case_at_a_sentence_start() -> None:
    # Arrange / Act
    result = expand_abbreviations("E.g. this holds")

    # Assert
    assert result == "For example this holds"


def test_expand_abbreviations_leaves_similar_words_untouched() -> None:
    # Arrange
    text = "the config. of the approximation and the reference list"

    # Act
    result = expand_abbreviations(text)

    # Assert
    assert result == text


def test_expand_abbreviations_expands_et_al_mid_sentence() -> None:
    # Arrange / Act
    result = expand_abbreviations("Kingma et al. proposed Adam")

    # Assert
    assert result == "Kingma and others proposed Adam"


def test_expand_abbreviations_keeps_the_sentence_break_after_et_al() -> None:
    # Arrange / Act
    result = expand_abbreviations("Reported by Kingma et al. Then we stop.")

    # Assert
    assert result == "Reported by Kingma and others. Then we stop."
    assert len(split_sentences(result)) == 2


@pytest.mark.parametrize(
    "text,expected",
    [
        ("95% of runs", "95 percent of runs"),
        ("R&D spend", "R and D spend"),
        ("see #3", "see number 3"),
        ("about ~5 items", "about approximately 5 items"),
        ("at 40°C now", "at 40 degrees Celsius now"),
        ("takes 20 ms total", "takes 20 milliseconds total"),
        ("takes 20ms total", "takes 20 milliseconds total"),
        ("takes 3 ns total", "takes 3 nanoseconds total"),
        ("takes 7 μs total", "takes 7 microseconds total"),
        ("runs at 10Hz on", "runs at 10 hertz on"),
        ("a higher frequency (120Hz).", "a higher frequency (120 hertz)."),
        ("sampled at 16 kHz", "sampled at 16 kilohertz"),
        ("a 2.4GHz radio", "a 2.4 gigahertz radio"),
        ("a 3 x 4 grid", "a 3 by 4 grid"),
        ("a 224x224 image", "a 224 by 224 image"),
    ],
)
def test_expand_abbreviations_spells_out_units_and_symbols(text: str, expected: str) -> None:
    # Arrange / Act
    result = " ".join(expand_abbreviations(text).split())

    # Assert
    assert result == expected


def test_expand_abbreviations_leaves_hex_literals_alone() -> None:
    # Arrange / Act
    result = expand_abbreviations("the mask 0x1F is used")

    # Assert
    assert result == "the mask 0x1F is used"


# ── split_sentences ───────────────────────────────────────────────────────────


def test_split_sentences_ignores_initials_and_decimals() -> None:
    # Arrange
    text = "J. W. Smith showed that 0.95 is enough. Next sentence."

    # Act
    result = split_sentences(text)

    # Assert
    assert result == ["J. W. Smith showed that 0.95 is enough.", "Next sentence."]


def test_split_sentences_does_not_break_on_et_al() -> None:
    # Arrange
    text = "We follow Kingma et al. (2015) here. Then we stop."

    # Act
    result = split_sentences(text)

    # Assert
    assert result == ["We follow Kingma et al. (2015) here.", "Then we stop."]


@pytest.mark.parametrize(
    "text",
    [
        "We use e.g. Adam and i.e. SGD in Fig. 3 of Sec. 2 here.",
        "Version 1.2.3 shipped with a 0.95 score today.",
        "We waited... and then the result arrived here.",
    ],
)
def test_split_sentences_treats_abbreviation_periods_as_non_boundaries(text: str) -> None:
    # Arrange / Act
    result = split_sentences(text)

    # Assert
    assert result == [text]


def test_split_sentences_splits_on_question_and_exclamation_marks() -> None:
    # Arrange
    text = "Does it work? It does! Good."

    # Act
    result = split_sentences(text)

    # Assert
    assert result == ["Does it work?", "It does!", "Good."]


def test_split_sentences_drops_blank_entries() -> None:
    # Arrange / Act
    result = split_sentences("   \n\n  One sentence here.   \n\n  ")

    # Assert
    assert result == ["One sentence here."]


def test_split_sentences_returns_empty_list_for_blank_input() -> None:
    # Arrange / Act / Assert
    assert split_sentences("") == []
    assert split_sentences("   \n ") == []


def test_split_sentences_hard_wraps_a_runaway_sentence() -> None:
    # Arrange: one 900+ character sentence with clause boundaries throughout.
    clause = "the model was trained on a large corpus of documents, "
    text = ("We report that " + clause * 18).strip().rstrip(",") + "."
    assert len(text) > 900

    # Act
    result = split_sentences(text, max_chars=config.SENTENCE_MAX_CHARS)

    # Assert
    assert len(result) > 1
    assert all(len(piece) <= config.SENTENCE_MAX_CHARS for piece in result)


def test_split_sentences_wraps_even_without_any_clause_boundary() -> None:
    # Arrange
    text = "word " * 200

    # Act
    result = split_sentences(text, max_chars=100)

    # Assert
    assert all(len(piece) <= 100 for piece in result)
    assert "".join(piece.replace(" ", "") for piece in result) == "word" * 200


# ── is_speakable ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text",
    ["We show that the bound is tight.", "The model converges quickly."],
)
def test_is_speakable_accepts_ordinary_prose(text: str) -> None:
    # Arrange / Act / Assert
    assert is_speakable(text) is True


@pytest.mark.parametrize(
    "text",
    ["", "   ", "12", "3.14", "-- ...", "[12]", "1234567890123456789", "!!!???---***"],
)
def test_is_speakable_rejects_fragments_and_symbol_soup(text: str) -> None:
    # Arrange / Act / Assert
    assert is_speakable(text) is False


def test_is_speakable_rejects_text_shorter_than_the_configured_minimum() -> None:
    # Arrange
    text = "a" * (config.MIN_SPEAKABLE_CHARS - 1)

    # Act / Assert
    assert is_speakable(text) is False
    assert is_speakable("a" * config.MIN_SPEAKABLE_CHARS) is True


# ── normalize ─────────────────────────────────────────────────────────────────


def test_normalize_composes_the_full_pipeline() -> None:
    # Arrange
    text = "The ﬁrst  result (Smith et al., 2020) shows a 95% improve-\nment [12], [15]."

    # Act
    result = normalize(text)

    # Assert
    assert result == "The first result shows a 95 percent improvement."


def test_normalize_collapses_all_whitespace_to_single_spaces() -> None:
    # Arrange
    text = "  line one\n\tline   two \n"

    # Act
    result = normalize(text)

    # Assert
    assert result == "line one line two"


def test_normalize_returns_empty_string_for_empty_input() -> None:
    # Arrange / Act / Assert
    assert normalize("") == ""


IDEMPOTENCE_SAMPLES = (
    "The ﬁrst  result (Smith et al., 2020) shows a 95% improve-\nment [12], [15].",
    "See Fig. 3 and Eq. 4; the error is ~5% at 40°C in 20 ms.",
    "A state-of-the-art non-linear model, e.g. a transformer, is used [3, 7-9].",
    "The [MASK] token is predicted (as shown below) for (x + 1) inputs.",
    "Reported by Kingma et al. Then we stop. J. W. Smith agrees.",
    "R&D grew 3x4 fold — the “best” result yet, per Ref. 8.",
    # M5 — the three shapes that disproved the docstring's claim, each taken from a
    # block of a real PDF. Sweeping all 27,245 blocks of the 13-document corpus turned
    # up no other counterexample.
    #   VJEPA_2.pdf p14: `&` expanded to " and ", leaving `Pick- and -Place`, which the
    #   second pass's hyphen-and-space rule then glued into `Pickand`.
    "Figure 10 Pick-&-Place. Closed-loop execution for multi-goal pick-&-place tasks.",
    #   MaskViT.pdf p7: the final whitespace collapse ran after the spacing repair, so a
    #   newline became a space the first pass never got to clean up.
    "the gate (\n&\nthe mask) is applied",
    #   PiZero.pdf p1: the same, before punctuation rather than after a bracket.
    "the ratio is 8\n:\n: ! 7",
)


@pytest.mark.parametrize("text", IDEMPOTENCE_SAMPLES)
def test_normalize_is_idempotent(text: str) -> None:
    # Arrange
    once = normalize(text)

    # Act
    twice = normalize(once)

    # Assert
    assert twice == once


def test_unspaced_single_digit_x_is_left_alone_for_subscripted_variables():
    """`2x1` in linear algebra is 2 times x-sub-1, not a 2-by-1 grid.

    Both readings are single-digit-x-single-digit and cannot be told apart, so the tie is
    broken in favour of the maths: "lambda 1x1 + lambda 2x2" was being spoken as
    "lambda 1 by 1 plus lambda 2 by 2", which is wrong in a way a listener cannot recover
    from. A grid written `3x4` merely sounds slightly odd. Spaced (`3 x 4`) and
    multi-digit (`224x224`) forms are unambiguous and still expand.
    """
    assert "by" not in normalize("lambda 1x1 + lambda 2x2 = 0")
    assert "by" not in normalize("c1x1 + c2x2 + c3x3")
    assert normalize("a 3 x 4 grid") == "a 3 by 4 grid"
    assert normalize("a 224x224 image") == "a 224 by 224 image"


# ── M3: a short sentence is still a sentence ──────────────────────────────────

@pytest.mark.parametrize("text", ["It fails.", "We do not.", "This is.", "Not so!", "Why not?"])
def test_short_complete_sentences_are_spoken(text: str) -> None:
    assert is_speakable(text), text


@pytest.mark.parametrize(
    "text",
    ["In this", "such that", "We can", "Note that", "used in", "a.", "Remark.", "X", "2."],
)
def test_line_break_fragments_are_still_dropped(text: str) -> None:
    """These are what a column break leaves behind, not short sentences.

    613 such fragments appear across the 25-document corpus; none is a complete thought.
    """
    assert not is_speakable(text), text
