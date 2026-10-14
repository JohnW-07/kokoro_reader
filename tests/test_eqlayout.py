"""Display equations set in two dimensions (N14): glyph repair and linearisation.

thinkstats.pdf (Think Stats 2e, CMEX/CMSY fonts) reaches pdf.js as `Â` for the summation
sign and `\\x00` for the minus, with the sum's limit and the fraction's numerator on lines
of their own above and below. The mean was read "1 mu equals n A hat x sub i i". The
fixtures are that book's geometry, PDF pages 23, 24 and 30, as pdf.js reports it.
"""

from __future__ import annotations

from typing import Sequence

from kokoro_reader.textpipe import eqlayout, glyphfix
from kokoro_reader.textpipe.pipeline import build_script
from kokoro_reader.textpipe.types import DocStats, Line, PageGeometry

Item = tuple[float, str, float]
BIG, ROMAN, SCRIPT, SYMBOL = 16.7372, 11.9552, 8.9664, 12.4573
STATS = DocStats(body_size=12.0, num_pages=1)


def mk(idx: int, y: float, size: float, x1: float, items: Sequence[Item],
       font: str = "g_d0_f3") -> Line:
    return Line(idx=idx, text="".join(t for _, t, _ in items).strip(), x0=items[0][0], x1=x1, y=y,
                size=size, font=font, items=tuple(range(idx * 100, idx * 100 + len(items))),
                item_x=tuple(x for x, _, _ in items), item_text=tuple(t for _, t, _ in items),
                item_size=tuple(s for _, _, s in items))


def prose(idx: int, y: float, text: str) -> Line:
    return mk(idx, y, 12.0, 525.6, [(129.6, text, ROMAN)], font="g_d0_f1")


# thinkstats p23: the mean, μ = (1/n) ∑_i x_i
P23 = (
    mk(8, 445.3, 12.0, 329.1, [(323.1, "1", ROMAN)], font="g_d0_f1"),
    mk(9, 453.4, 12.0, 357.0, [
        (297.7, "μ", ROMAN), (304.7, " ", ROMAN), (308.3, "=", SYMBOL), (318.0, " ", SYMBOL),
        (322.8, "n", ROMAN), (329.5, " ", ROMAN), (332.9, "Â", BIG), (348.3, "x", ROMAN),
        (354.3, " ", ROMAN), (354.5, "_i", SCRIPT)]),
    mk(10, 466.3, 9.0, 340.6, [(338.1, "i", SCRIPT)]),
)
# thinkstats p24: the variance, s² = (1/n) ∑_i (x_i − μ)²
P24 = (
    mk(13, 342.6, 9.0, 333.9, [(241.5, "2", SCRIPT), (246.0, " ", SCRIPT), (264.8, "1", ROMAN),
                               (329.4, "2", SCRIPT)], font="g_d0_f1"),
    mk(14, 347.5, 12.0, 329.3, [
        (234.6, "s", ROMAN), (241.3, " ", ROMAN), (249.9, "=", SYMBOL), (259.6, " ", SYMBOL),
        (264.4, "n", ROMAN), (271.1, " ", ROMAN), (274.6, "Â", BIG), (287.7, "(", SYMBOL),
        (292.5, " ", SYMBOL), (293.0, "x", ROMAN), (299.0, " ", ROMAN), (299.2, "_i", SCRIPT),
        (301.7, " ", SCRIPT), (304.9, "\x00", SYMBOL), (314.5, " ", SYMBOL), (317.2, "μ", ROMAN),
        (324.1, " ", ROMAN), (324.4, ")", SYMBOL), (329.3, " ", SYMBOL)]),
    mk(15, 360.5, 9.0, 282.2, [(279.7, "i", SCRIPT)]),
)
# thinkstats p30: the mean of a PMF, μ = ∑_i p_i x_i
P30 = (
    mk(14, 330.3, 12.0, 313.2, [
        (255.1, "μ", ROMAN), (262.1, " ", ROMAN), (265.7, "=", SYMBOL), (275.4, " ", SYMBOL),
        (279.0, "Â", BIG), (294.8, "p", ROMAN), (300.8, " ", ROMAN), (301.0, "_i", SCRIPT),
        (303.5, " ", SCRIPT), (304.5, "x", ROMAN), (310.5, " ", ROMAN), (310.7, "_i", SCRIPT)]),
    mk(15, 343.2, 9.0, 286.6, [(284.1, "i", SCRIPT)]),
)


def fixed(lines: Sequence[Line]) -> tuple[Line, ...]:
    return tuple(glyphfix.fix_line(ln) for ln in lines)


# ── glyph repair ──────────────────────────────────────────────────────────────


def test_big_lone_a_circumflex_is_the_summation_sign():
    line = glyphfix.fix_line(P23[1])
    assert line.text == "μ = n ∑x _i"
    assert line.item_text[6] == "∑"
    assert line.item_text[:6] == P23[1].item_text[:6]


def test_lone_nul_is_the_minus_sign():
    line = glyphfix.fix_line(P24[1])
    assert line.text == "s = n ∑( x _i − μ )"
    assert line.item_text[13] == "−"


def test_text_and_items_stay_in_lockstep():
    """The client trims the line text; p24's trailing blank item must not stop the repair."""
    for line in fixed(P23 + P24 + P30):
        assert line.text == "".join(line.item_text).strip()
        assert "Â" not in line.text and "\x00" not in line.text


def test_a_circumflex_at_text_size_is_a_letter():
    line = mk(0, 100.0, 12.0, 200.0, [(100.0, "Â", ROMAN), (110.0, "me", ROMAN)])
    assert glyphfix.fix_line(line) == line


def test_nul_inside_a_word_is_left_alone():
    """Avelo.pdf reports a ligature as `\\x00nd`; only a lone NUL is CMSY's minus."""
    line = mk(0, 100.0, 12.0, 200.0, [(100.0, "\x00nd", ROMAN), (120.0, " more", ROMAN)])
    assert glyphfix.fix_line(line) == line


def test_nul_split_from_its_word_is_a_ligature_not_a_minus():
    """Avelo.pdf p4: `You can ` + `\\x00` + `nd them` -- "find", with the fi lost."""
    line = mk(0, 100.0, 6.0, 300.0, [(100.0, "You can ", 6.0), (130.0, "\x00", 6.0),
                                      (133.0, "nd them", 6.0)])
    assert glyphfix.fix_line(line) == line


def test_a_run_of_nuls_is_not_a_minus():
    """Exit_Ticket_831.pdf: `\\x00\\x00\\x00 This project ...`, an ellipsis or dash run."""
    line = mk(0, 100.0, 12.0, 300.0, [(100.0, "\x00", 12.0), (106.0, "\x00", 12.0),
                                       (112.0, "\x00", 12.0), (118.0, " ", 12.0),
                                       (121.0, "This project", 12.0)])
    assert glyphfix.fix_line(line) == line


def test_fix_page_keeps_every_line_and_its_order():
    geom = PageGeometry(page=23, width=612.0, height=792.0, lines=P23)
    out = glyphfix.fix_page(geom)
    assert [ln.idx for ln in out.lines] == [8, 9, 10]
    assert out.lines[1].text == "μ = n ∑x _i"


# ── linearisation ─────────────────────────────────────────────────────────────


def test_numerator_over_a_token_and_limit_under_the_sum():
    assert eqlayout.linearize(fixed(P23)) == r"μ = \frac{1}{n}, ∑_{i} x _i"


def test_superscripts_beside_a_token_and_numerator_over_one():
    assert eqlayout.linearize(fixed(P24)) == r"s^{2} = \frac{1}{n}, ∑_{i} ( x _i − μ )^{2}"


def test_limit_only():
    assert eqlayout.linearize(fixed(P30)) == r"μ = ∑_{i} p _i x _i"


def test_text_size_glyph_over_script_sized_operands_is_not_a_fraction():
    """PiZero.pdf p5: the 7 pt `τ` marks over a 10 pt loss whose subscripted terms are
    7 pt too; against the line's median size they passed as numerators ("tau over L")."""
    tau = mk(17, 270.9, 7.0, 286.4, [(66.1, "τ", 6.97), (69.8, " ", 6.97), (199.5, "τ", 6.97),
                                      (253.1, "τ", 6.97), (282.4, "2", 6.97)])
    loss = mk(18, 275.0, 10.0, 289.7, [
        (59.3, 'L', 9.96), (71.1, '(', 9.96), (74.9, 'θ', 9.96), (79.9, ') =', 9.96),
        (94.3, ' ', 9.96), (97.0, 'E', 9.96), (103.7, '_p', 6.97), (107.8, '(', 6.97),
        (110.9, 'A', 6.97), (117.7, '_t', 4.98), (121.0, '|', 6.97), (123.3, 'o', 6.97),
        (127.8, '_t', 4.98), (131.1, ')', 6.97), (134.3, ',q', 6.97), (140.5, '(', 6.97),
        (143.6, 'A', 6.97), (150.4, 'τ', 4.98), (150.4, '_t', 4.98), (153.2, ' ', 4.98),
        (154.9, '|', 6.97), (157.2, 'A', 6.97), (164.0, '_t', 4.98), (167.3, ')', 6.97),
        (170.9, '||', 9.96), (176.4, 'v', 9.96), (182.5, '_θ', 6.97), (186.3, ' ', 6.97),
        (187.0, '(', 9.96), (190.9, 'A', 9.96), (199.5, '_t', 6.97), (202.5, ' ', 6.97),
        (204.5, ',', 9.96), (207.3, ' ', 9.96), (208.9, 'o', 9.96), (214.7, '_t', 6.97),
        (218.2, ')', 9.96), (222.0, ' ', 9.96), (224.3, '−', 9.96), (232.0, ' ', 9.96),
        (234.2, 'u', 9.96), (240.6, '(', 9.96), (244.5, 'A', 9.96), (253.1, '_t', 6.97),
        (256.1, ' ', 6.97), (258.1, '|', 9.96), (260.9, 'A', 9.96), (269.5, '_t', 6.97),
        (273.0, ')', 9.96), (276.9, '||', 9.96), (286.9, ',', 9.96)])
    assert eqlayout.linearize((tau, loss)) is None


def test_script_mark_from_the_client_is_dropped_from_a_satellite():
    """thinkstats p106: the exponent arrives as `_2` (the client marks a shifted baseline);
    over `)` it is a superscript, not "to the sub 2"."""
    sat = mk(11, 281.2, 12.0, 340.6, [(273.7, "1", ROMAN), (336.6, "_2", SCRIPT)])
    main = mk(12, 289.3, 12.0, 336.5, [
        (227.9, "MSE", ROMAN), (254.0, " ", ROMAN), (257.6, "=", SYMBOL), (267.3, " ", SYMBOL),
        (272.1, "m", ROMAN), (281.4, " ", ROMAN), (284.9, "Â", BIG), (297.7, " ", BIG),
        (298.0, "(", SYMBOL), (302.8, " ", SYMBOL), (303.3, "x", ROMAN), (305.2, "¯", ROMAN),
        (309.3, " ", ROMAN), (312.1, "\x00", SYMBOL), (321.7, " ", SYMBOL), (324.4, "μ", ROMAN),
        (331.3, " ", ROMAN), (331.6, ")", SYMBOL), (336.5, " ", SYMBOL)])
    assert eqlayout.linearize(fixed((sat, main))) == r"MSE = \frac{1}{m}, ∑ ( x¯ − μ )^{2}"


def test_accent_over_a_glyph_is_its_hat_not_a_numerator():
    """thinkstats p129: the `ˆ` over `b` in `aˆ + bx` was read "hat over b"."""
    sat = mk(29, 622.2, 12.0, 374.4, [(274.7, "1", ROMAN), (326.2, "ˆ", ROMAN),
                                       (369.9, "2", SCRIPT), (374.4, " ", SCRIPT)], font="g_d0_f1")
    main = mk(30, 627.2, 12.0, 425.6, [
        (230.2, "MSE", ROMAN), (256.3, " ", ROMAN), (259.9, "=", SYMBOL), (269.6, " ", SYMBOL),
        (274.4, "n", ROMAN), (281.0, " ", ROMAN), (284.5, "Â", BIG), (297.3, " ", BIG),
        (297.6, "(", SYMBOL), (302.5, " ", SYMBOL), (302.8, "a", ROMAN), (303.7, "ˆ", ROMAN),
        (309.1, " ", ROMAN), (311.7, "+", SYMBOL), (321.4, " ", SYMBOL), (324.3, "b", ROMAN),
        (331.3, "x", ROMAN), (337.3, " ", ROMAN), (337.5, "_i", SCRIPT), (340.0, " ", SCRIPT),
        (343.1, "\x00", SYMBOL), (352.8, " ", SYMBOL), (355.4, "y", ROMAN), (361.4, " ", ROMAN),
        (361.6, "_i", SCRIPT), (364.1, " ", SCRIPT), (364.9, ")", SYMBOL), (369.7, " ", SYMBOL),
        (378.3, "=", SYMBOL), (388.0, " ", SYMBOL), (391.5, "Var", ROMAN), (410.4, " ", ROMAN),
        (410.8, "(", SYMBOL), (415.6, " ", SYMBOL), (415.9, "#", ROMAN), (420.4, " ", ROMAN),
        (420.7, ")", SYMBOL)])
    out = eqlayout.linearize(fixed((sat, main)))
    assert out is not None and "bˆx" in out and r"\frac{ˆ}" not in out


def test_one_line_is_left_to_the_text():
    assert eqlayout.linearize(fixed(P30[:1])) is None


def test_two_full_rows_are_not_scripts_of_each_other():
    rows = (mk(0, 300.0, 12.0, 330.0, [(250.0, "a = b + c", ROMAN)]),
            mk(1, 314.7, 12.0, 330.0, [(250.0, "d = e + f", ROMAN)]))
    assert eqlayout.linearize(rows) is None


# ── end to end ────────────────────────────────────────────────────────────────


def spoken_equations(lines: Sequence[Line], page: int) -> list[str]:
    geom = PageGeometry(page=page, width=612.0, height=792.0, lines=tuple(lines))
    _, blocks, _ = build_script([geom], STATS)
    return [b.spoken for b in blocks if b.kind == "equation"]


def test_p23_mean_reads_as_a_sum():
    lines = (prose(6, 405.7, "If you have a sample of n values, the mean is the sum of them"),
             prose(7, 420.4, "divided by the number of values; in other words"), *P23,
             prose(11, 489.4, "The words mean and average are sometimes used interchangeably,"))
    assert spoken_equations(lines, 23) == ["mu equals 1 over n, the sum over i of x sub i"]


def test_p24_variance_reads_minus_not_a_full_stop():
    lines = (prose(12, 329.8, "is the mean squared deviation from the mean, written as"),
             *P24, prose(16, 378.0, "The term is called the deviation from the mean, so variance"))
    assert spoken_equations(lines, 24) == [
        "s squared equals 1 over n, the sum over i of (x sub i minus mu) squared"]


def test_wrapped_sentence_tail_with_a_minus_stays_prose():
    """thinkstats p84: `z \\x00 x.` ends a sentence on a line of its own; once its minus was
    decoded the line read as math and the sentence lost "z minus x"."""
    lines = (prose(15, 515.9, "less than z, given that the first term is x. Well, if the first is x and"),
             prose(16, 530.6, "the sum has to be less than z, then the second term has to be less than"),
             mk(17, 545.3, 12.0, 160.8, [(129.7, "z", ROMAN), (135.7, " ", ROMAN),
                                         (138.0, "\x00", SYMBOL), (147.6, " ", SYMBOL),
                                         (150.0, "x.", ROMAN)]),
             prose(18, 570.9, "To get the probability that Y is less than z, we evaluate the CDF."))
    geom = PageGeometry(page=84, width=612.0, height=792.0, lines=lines)
    _, blocks, _ = build_script([geom], STATS)
    assert [b.kind for b in blocks if 17 in b.line_ids] == ["body"]
    assert any("less than z minus x" in b.spoken for b in blocks)
