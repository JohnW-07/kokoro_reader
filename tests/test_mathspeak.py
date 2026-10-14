"""R7: display and inline math is spoken as English, not glyph soup."""

from __future__ import annotations

import pytest

from kokoro_reader.textpipe.mathspeak import looks_like_equation, math_density, speak

# Realistic fragments in the style of ML/stats papers, used for the blanket
# idempotence and no-double-space invariants.
CORPUS: tuple[str, ...] = (
    "The cat sat on the mat.",
    "We improved accuracy by 5% over the baseline.",
    "We show that xᵢ ≤ n for all i.",
    "Let θ ∈ ℝ^d denote the parameters.",
    r"\theta := \arg\min_\theta L(\theta)",
    r"\sum_{i=1}^{n} x_i",
    "∑_{i=1}^{n} w_i x_i",
    "Σ_{i=1}^n α_i x_i ≤ β",
    "The loss is L(θ) = 𝔼[ℓ(f(x), y)] + λ‖θ‖_2.",
    "p(y|x) ∝ p(x|y) p(y)",
    "This runs in O(n log n) time.",
    "∫_0^∞ e^{-t} dt = 1",
    "∂L/∂θ = 0",
    "lim_{n→∞} x_n = x",
    "f: X → Y",
    "|S| ≤ |X|",
    "‖x − y‖₂ ≤ ε",
    "Var(X) = 𝔼[X²] − 𝔼[X]²",
    "⌊n/2⌋ + ⌈n/2⌉ = n",
    "A state-of-the-art e-mail classifier and/or ranker.",
    "α β γ δ ε ζ η θ ι κ λ μ ν ξ π ρ σ τ υ φ χ ψ ω",
    "Γ Δ Θ Λ Ξ Π Σ Φ Ψ Ω",
    "∀ ∃ ∄ ¬ ∧ ∨ ⇒ ⇔ ↦ ∞ ∂ ∇ ∅ ℓ † ∴ ∵ ≫ ≪",
    "x^{n+1} = x^{n} + Δx",
    "KL(q‖p) = ∫ q(z) log (q(z)/p(z)) dz",
    "p(z|x) = p(x|z)p(z)/p(x)",
    "We set the learning rate η = 10^{-3} and β₁ = 0.9.",
    "Then E[‖θ_T − θ*‖²] ≤ O(1/√T).",
    "Let 𝒟 = {(x_i, y_i)}_{i=1}^N ⊂ ℝ^d.",
    "∇_θ J(θ) = 𝔼[∇_θ log π_θ(a|s) A(s,a)]",
    "For x < y we have f(x) < f(y).",
    "See https://example.com/paper for details.",
)


# --------------------------------------------------------------------------- #
# Symbol families
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "glyph,word",
    [
        ("α", "alpha"), ("β", "beta"), ("γ", "gamma"), ("δ", "delta"),
        ("ε", "epsilon"), ("ζ", "zeta"), ("η", "eta"), ("θ", "theta"),
        ("ι", "iota"), ("κ", "kappa"), ("λ", "lambda"), ("μ", "mu"),
        ("ν", "nu"), ("ξ", "xi"), ("π", "pi"), ("ρ", "rho"), ("σ", "sigma"),
        ("τ", "tau"), ("υ", "upsilon"), ("φ", "phi"), ("χ", "chi"),
        ("ψ", "psi"), ("ω", "omega"),
    ],
)
def test_speaks_every_lowercase_greek_letter_by_name(glyph: str, word: str) -> None:
    # Arrange / Act
    spoken = speak(f"the value {glyph} is small")

    # Assert
    assert spoken == f"the value {word} is small"


@pytest.mark.parametrize(
    "glyph,word",
    [("Γ", "gamma"), ("Θ", "theta"), ("Λ", "lambda"), ("Ξ", "xi"),
     ("Φ", "phi"), ("Ψ", "psi"), ("Ω", "omega")],
)
def test_unambiguous_greek_capitals_read_as_the_plain_letter_name(glyph: str, word: str) -> None:
    assert speak(f"{glyph} = 0") == f"{word} equals 0"


def test_capital_sigma_in_operator_position_reads_as_sum() -> None:
    assert speak("Σ x_i") == "the sum of x sub i"


def test_capital_sigma_as_a_matrix_name_reads_as_capital_sigma() -> None:
    assert speak("Σ = A A^T") == "capital sigma equals A A transpose"


def test_capital_pi_in_operator_position_reads_as_product() -> None:
    assert speak("Π p_i") == "the product of p sub i"


def test_capital_delta_before_a_variable_reads_as_delta() -> None:
    assert speak("Δw = -η ∇L") == "delta w equals minus eta gradient L"


@pytest.mark.parametrize(
    "glyph,word",
    [
        ("≤", "less than or equal to"), ("≥", "greater than or equal to"),
        ("≠", "not equal to"), ("≈", "approximately equal to"),
        ("≡", "is equivalent to"), ("∝", "is proportional to"),
        ("±", "plus or minus"), ("∓", "minus or plus"), ("×", "times"),
        ("÷", "divided by"), ("⋅", "dot"), ("∘", "composed with"),
        ("⊗", "tensor product"), ("⊕", "direct sum"), ("∪", "union"),
        ("∩", "intersect"), ("⊆", "is a subset of"), ("⊇", "is a superset of"),
        ("∈", "element of"), ("∉", "not an element of"),
        ("⇒", "implies"), ("⇔", "if and only if"), ("↦", "maps to"),
        ("≫", "much greater than"), ("≪", "much less than"),
        ("∴", "therefore"), ("∵", "because"),
    ],
)
def test_speaks_binary_operators_and_relations_in_english(glyph: str, word: str) -> None:
    assert speak(f"a {glyph} b") == f"a {word} b"


@pytest.mark.parametrize(
    "glyph,word",
    [("∀", "for all"), ("∃", "there exists"), ("∄", "there does not exist"),
     ("¬", "not"), ("∞", "infinity"), ("∂", "partial"), ("∇", "gradient"),
     ("∅", "the empty set"), ("†", "dagger")],
)
def test_speaks_unary_and_standalone_symbols_in_english(glyph: str, word: str) -> None:
    assert word in speak(f"we take {glyph} here")


@pytest.mark.parametrize(
    "glyph,word",
    [("ℝ", "the reals"), ("ℕ", "the naturals"), ("ℤ", "the integers"),
     ("ℚ", "the rationals"), ("ℂ", "the complexes")],
)
def test_blackboard_bold_sets_read_as_named_sets(glyph: str, word: str) -> None:
    assert speak(f"x ∈ {glyph}") == f"x element of {word}"


def test_reals_to_the_d_keeps_the_exponent() -> None:
    assert speak("ℝ^d") == "the reals to the d"


# --------------------------------------------------------------------------- #
# Superscripts and subscripts
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "source,expected",
    [
        ("x^2", "x squared"),
        ("x^3", "x cubed"),
        ("x^T", "x transpose"),
        ("x^{T}", "x transpose"),
        ("x^{-1}", "x inverse"),
        ("x^*", "x star"),
        ("x^n", "x to the n"),
        ("x^{n+1}", "x to the n plus 1"),
        ("x_i", "x sub i"),
        ("x_{i,j}", "x sub i j"),
        ("x_0", "x sub 0"),
        ("x_t", "x sub t"),
    ],
)
def test_ascii_scripts_are_verbalised(source: str, expected: str) -> None:
    assert speak(source) == expected


@pytest.mark.parametrize(
    "source,expected",
    [
        ("x²", "x squared"),
        ("x³", "x cubed"),
        ("xⁿ", "x to the n"),
        ("xᵢ", "x sub i"),
        ("xⱼ", "x sub j"),
        ("x₀", "x sub 0"),
        ("x₁", "x sub 1"),
        ("x⁻¹", "x inverse"),
    ],
)
def test_unicode_scripts_match_their_ascii_twins(source: str, expected: str) -> None:
    assert speak(source) == expected


# --------------------------------------------------------------------------- #
# Notation idioms
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "source,expected",
    [
        ("O(n log n)", "big O of n log n"),
        ("𝒪(n)", "big O of n"),
        ("Θ(n²)", "big theta of n squared"),
        ("Ω(n)", "big omega of n"),
    ],
)
def test_asymptotic_notation_reads_as_big_o_family(source: str, expected: str) -> None:
    assert speak(source) == expected


def test_asymptotic_bound_inside_a_sentence() -> None:
    assert speak("Sorting runs in O(n log n) time.") == "Sorting runs in big O of n log n time."


@pytest.mark.parametrize(
    "source,expected",
    [
        ("‖x‖", "the norm of x"),
        ("||x||", "the norm of x"),
        ("‖x‖_2", "the L2 norm of x"),
        ("‖x‖₂", "the L2 norm of x"),
        ("‖θ‖_2", "the L2 norm of theta"),
    ],
)
def test_norms_are_named_by_their_subscript(source: str, expected: str) -> None:
    assert speak(source) == expected


def test_absolute_value_bars_read_as_absolute_value() -> None:
    assert speak("|x|") == "the absolute value of x"


def test_bars_around_a_single_capital_read_as_cardinality() -> None:
    assert speak("|S| = n") == "the cardinality of S equals n"


@pytest.mark.parametrize(
    "source,expected",
    [
        (r"\frac{a}{b}", "a over b"),
        ("a/b", "a over b"),
        (r"\sqrt{x}", "the square root of x"),
        ("√x", "the square root of x"),
    ],
)
def test_fractions_and_roots(source: str, expected: str) -> None:
    assert speak(source) == expected


@pytest.mark.parametrize(
    "source,expected",
    [
        ("E[X]", "the expectation of X"),
        ("𝔼[X]", "the expectation of X"),
        ("Var(X)", "the variance of X"),
        ("Cov(X, Y)", "the covariance of X and Y"),
    ],
)
def test_expectation_and_moments(source: str, expected: str) -> None:
    assert speak(source) == expected


def test_conditional_probability_reads_the_bar_as_given() -> None:
    assert speak("p(y|x)") == "p of y given x"


def test_kl_divergence_double_bar_is_a_separator_not_a_norm() -> None:
    assert speak("KL(q‖p)") == "the KL divergence from q to p"
    assert speak("D_{KL}(p‖q) ≥ 0") == "the KL divergence from p to q greater than or equal to 0"


def test_ratio_of_two_function_calls_reads_as_over() -> None:
    assert speak("p(z)/p(x)") == "p of z over p of x"


def test_negative_exponent_reads_as_to_the_minus_n() -> None:
    assert speak("η = 10^{-3}") == "eta equals 10 to the minus 3"


def test_strict_inequalities_are_verbalised() -> None:
    assert speak("ε > 0") == "epsilon greater than 0"
    assert speak("a < b") == "a less than b"


def test_calligraphic_capitals_read_as_plain_letters() -> None:
    assert speak("𝒟 ⊂ ℝ^d") == "D is a proper subset of the reals to the d"


def test_argmin_subscript_reads_as_arg_min_over() -> None:
    assert speak("θ := argmin_θ L(θ)") == "theta is defined as arg min over theta of L of theta"


def test_argmax_subscript_reads_as_arg_max_over() -> None:
    assert speak("argmax_x f(x)") == "arg max over x of f of x"


@pytest.mark.parametrize(
    "source",
    [r"\sum_{i=1}^{n} x_i", "∑_{i=1}^{n} x_i", "Σ_{i=1}^n x_i"],
)
def test_summation_with_limits_reads_from_lower_to_upper(source: str) -> None:
    assert speak(source) == "the sum from i equals 1 to n of x sub i"


def test_product_with_limits() -> None:
    assert speak("∏_{i=1}^{n} p_i") == "the product from i equals 1 to n of p sub i"


def test_definite_integral_reads_from_lower_to_upper() -> None:
    assert speak("∫_a^b f(x) dx") == "the integral from a to b of f of x d x"


def test_partial_derivative_reads_with_respect_to() -> None:
    assert speak("∂L/∂θ") == "the partial derivative of L with respect to theta"


def test_ordinary_derivative_operator() -> None:
    assert speak("d/dx") == "the derivative with respect to x"


def test_limit_to_infinity() -> None:
    assert speak("lim_{n→∞} x_n = x") == "the limit as n goes to infinity of x sub n equals x"


def test_arrow_to_infinity_reads_as_goes_to_infinity() -> None:
    assert speak("x → ∞") == "x goes to infinity"


@pytest.mark.parametrize("source", ["x := y", "x ≜ y"])
def test_definition_symbols_read_as_is_defined_as(source: str) -> None:
    assert speak(source) == "x is defined as y"


def test_function_signature_reads_as_from_to() -> None:
    assert speak("f: X → Y") == "f from X to Y"


def test_function_signature_into_the_reals() -> None:
    assert speak("f: ℝ^d → ℝ") == "f from the reals to the d to the reals"


def test_floor_ceiling_and_inner_product_fences() -> None:
    assert speak("⌊x⌋") == "the floor of x"
    assert speak("⌈x⌉") == "the ceiling of x"
    assert speak("⟨u, v⟩") == "the inner product of u and v"


def test_trailing_equation_number_is_dropped() -> None:
    assert speak("x = y + z (3)") == "x equals y plus z"


def test_lone_equation_number_becomes_equation_n() -> None:
    assert speak("(3)") == "equation 3"


def test_trailing_parenthetical_in_prose_is_not_treated_as_an_equation_number() -> None:
    source = "We report results for the smaller variant (2)"
    assert speak(source) == source


# --------------------------------------------------------------------------- #
# Spacing repair
# --------------------------------------------------------------------------- #


def test_glyphs_packed_without_spaces_are_separated() -> None:
    assert speak("x∈ℝ") == "x element of the reals"


@pytest.mark.parametrize("source", CORPUS)
def test_output_never_contains_double_spaces_or_space_before_punctuation(source: str) -> None:
    spoken = speak(source)
    assert "  " not in spoken
    assert " ." not in spoken
    assert " ," not in spoken


# --------------------------------------------------------------------------- #
# Idempotence (hard requirement — the pipeline may call speak more than once)
# --------------------------------------------------------------------------- #


def test_plain_prose_is_returned_unchanged() -> None:
    assert speak("The cat sat on the mat.") == "The cat sat on the mat."


def test_prose_with_a_percentage_is_returned_unchanged() -> None:
    source = "We improved accuracy by 5% over the baseline."
    assert speak(source) == source


def test_hyphenated_prose_is_not_read_as_subtraction() -> None:
    source = "A state-of-the-art e-mail classifier and/or ranker."
    assert speak(source) == source


@pytest.mark.parametrize("source", CORPUS)
def test_speak_is_idempotent_over_the_corpus(source: str) -> None:
    once = speak(source)
    assert speak(once) == once


# --------------------------------------------------------------------------- #
# math_density
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "prose",
    [
        "The cat sat on the mat.",
        "We improved accuracy by 5% over the baseline.",
        "We show that the model converges to a stationary point in practice.",
        "Table 2 reports the ablation over three random seeds.",
    ],
)
def test_prose_scores_below_the_low_density_threshold(prose: str) -> None:
    assert math_density(prose) < 0.05


@pytest.mark.parametrize(
    "equation",
    [
        "‖x − y‖₂ ≤ ε",
        r"\sum_{i=1}^{n} x_i \le n",
        "f(x) = w^T x + b",
        "θ := argmin_θ L(θ)",
        "p(y|x) ∝ p(x|y) p(y)",
    ],
)
def test_display_equations_score_above_the_high_density_threshold(equation: str) -> None:
    assert math_density(equation) > 0.25


def test_density_is_bounded_to_the_unit_interval() -> None:
    for sample in CORPUS:
        assert 0.0 <= math_density(sample) <= 1.0


def test_empty_text_has_zero_density() -> None:
    assert math_density("") == 0.0
    assert math_density("   \n ") == 0.0


# --------------------------------------------------------------------------- #
# looks_like_equation
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "equation",
    [
        "‖x − y‖₂ ≤ ε",
        "x_i = \\sum_j a_{ij} y_j",
        "f(x) = w^T x + b",
        "α ≤ β",
        "∑_{i=1}^{n} w_i x_i",
        "θ := argmin_θ L(θ)",
    ],
)
def test_display_equation_shapes_are_recognised(equation: str) -> None:
    assert looks_like_equation(equation) is True


@pytest.mark.parametrize(
    "prose",
    [
        "We improved accuracy by 5%",
        "The cat sat on the mat.",
        "Figure 3 shows the training curves for all four models.",
        "This is discussed further in Section 2.",
        "For x < y we have f(x) < f(y).",
        "The model uses a (large) transformer with f(x) as the head.",
        "",
        "   ",
    ],
)
def test_ordinary_prose_is_not_an_equation(prose: str) -> None:
    assert looks_like_equation(prose) is False


# ── Regressions found by reading real textbook pages (2026-09-10) ─────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("a ⋆ b", "a star b"),
        ("A ⊙ B", "A elementwise product B"),
        ("X ∖ Y", "X without Y"),
        ("w · x", "w dot x"),
        ("A ≅ B", "A is isomorphic to B"),
    ],
)
def test_glyphs_seen_in_linear_algebra_texts_are_spoken(raw, expected):
    assert speak(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("A\\B", "A without B"),
        ("R\\{−1}", "R without minus 1"),
        ("X \\setminus Y", "X without Y"),
    ],
)
def test_set_difference_never_reaches_the_voice_as_a_backslash(raw, expected):
    assert speak(raw) == expected


def test_set_minus_rule_does_not_eat_latex_macro_names():
    """`\\setminus` starts with a letter; a naive rule read it as "without setminus"."""
    assert "setminus" not in speak("X \\setminus Y")
    assert speak("\\frac{a}{b}") == "a over b"
    assert speak("\\alpha + \\beta") == "alpha plus beta"


def test_braces_are_never_spoken():
    assert "{" not in speak("{x ∈ Z : x > 0}")
    assert "}" not in speak("{x ∈ Z : x > 0}")


def test_long_bare_number_runs_collapse_to_the_word_matrix():
    """A typeset matrix flattens to number soup; reading it aloud is worse than silence."""
    assert speak("  1 0 2 0 1 1 0 0 A = (2.57)") == "matrix A equals (2.57)"


def test_matrix_collapsing_keeps_the_prose_around_it():
    out = speak("1 0 2 0 1 0 0 0 we write down the augmented matrix")
    assert "we write down the augmented matrix" in out


@pytest.mark.parametrize(
    "raw",
    [
        "We report 3 datasets and 5 seeds.",
        "accuracy was 98.6 and 97.2",
        "x = 1 2 3",
    ],
)
def test_short_number_sequences_are_left_alone(raw):
    assert "matrix" not in speak(raw)


def test_combining_solidus_negation_is_not_read_as_the_positive_relation():
    """LaTeX writes ≠ as '=' plus U+0338. Dropping the mark inverts the sentence."""
    assert speak("z ̸= 1") == "z not equal to 1"
    assert "not equal" in speak("k ̸= ell")


def test_slanted_inequality_variants_are_spoken():
    assert speak("k ⩾ 2") == "k greater than or equal to 2"
    assert speak("dim(U) ⩽ dim(V)") == "dim(U) less than or equal to dim(V)"


def test_private_use_bracket_glyphs_never_reach_the_voice():
    """Computer Modern emits large brackets as PUA pieces; they also broke matrix runs."""
    raw = "  1 0 2 0 1 1 0 0 A =   (2.57)"
    out = speak(raw)
    assert not any("" <= ch <= "" for ch in out)
    assert out == "matrix A equals (2.57)"


# ── Accents: an estimate is read as one, a name is left alone ─────────────────

@pytest.mark.parametrize(
    ("raw", "said"),
    [
        ("x̂ = y", "x hat equals y"),
        ("θ̂", "theta hat"),
        ("x̄ is the mean", "x bar is the mean"),
        ("ỹ ≈ y", "y tilde approximately equal to y"),
        ("ŷ ≠ y", "y hat not equal to y"),
        ("ẑt", "z hat t"),
        ("zˆk+1", "z hat k plus 1"),          # the extractor strands U+02C6 after its letter
        ("x⃗", "x vector"),
    ],
)
def test_maths_accents_are_spoken(raw: str, said: str) -> None:
    assert speak(raw) == said


@pytest.mark.parametrize("name", ["Núñez", "naïve café", "Öztürk", "Roberto Martín-Martín"])
def test_accents_inside_words_are_left_alone(name: str) -> None:
    """A mark is only maths when its base letter starts a token; author names are read."""
    assert speak(name) == name
