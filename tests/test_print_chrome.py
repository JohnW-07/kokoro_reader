"""Browser print headers and footers (N10).

Safari and Chrome stamp every printed page with a title and date/time header and a URL and
"Page n of m" footer, in small type in the outer few percent of the page. A web page saved
as a PDF is one to three pages long, below the four pages the repetition rule needs, so the
header was read aloud — its date as "9 over 27/26". The fixtures are the geometry of
"View Submitted Waiver.pdf" and the ENES140 Typeform evaluations, as pdf.js reports it.
"""

from __future__ import annotations

from typing import Sequence

from kokoro_reader.textpipe.classify import classify_page, compute_doc_stats
from kokoro_reader.textpipe.types import Block, DocStats, Line, PageGeometry

PAGE_W, PAGE_H = 612.0, 792.0
HEADER_Y, FOOTER_Y = 24.0, 749.0      # Safari's print chrome on a US Letter page
CHROME = 7.0
WAIVER_HEADER = "View Submitted Waiver 7/23/26, 9:30 PM"
WAIVER_FOOTER = "https://www2.academichealthplans.com/student/waiversubmitconfirm.php Page 1 of 1"
TYPEFORM_HEADER = "How Is Your Confidence? 9/27/26, 8:44 PM"
TYPEFORM_FOOTER = ("https://form.typeform.com/to/H3YNDcvB?typeform-medium=embed-sdk"
                   "…mbed-hide-headers=true&embed-opacity=100 Page 1 of 1")
FURNITURE = ("header", "footer", "pagenum")
PROSE = "Please allow seven to ten business days for the waiver to be processed"


def line(idx: int, text: str, y: float, size: float, *, x0: float = 18.0,
         x1: float = 594.0) -> Line:
    words = tuple(f"{w} " for w in text.split())
    return Line(idx=idx, text=text, x0=x0, x1=x1, y=y, size=size, font="g_d0_f1",
                items=tuple(range(idx * 100, idx * 100 + len(words))),
                item_x=tuple(x0 + k * 20.0 for k in range(len(words))),
                item_text=words, item_size=(size,) * len(words))


def page(number: int, lines: Sequence[Line]) -> PageGeometry:
    return PageGeometry(page=number, width=PAGE_W, height=PAGE_H, lines=tuple(lines))


def waiver_page(header: str = WAIVER_HEADER, footer: str = WAIVER_FOOTER) -> PageGeometry:
    """The Waiver's own page: everything, the print chrome included, is set at 6-9 pt."""
    return page(1, [
        line(0, header, HEADER_Y, CHROME),
        line(1, "Account Info Waiver Contact Us Logout", 99.5, CHROME, x0=220.0, x1=586.0),
        line(2, PROSE, 152.5, 9.0, x0=157.0, x1=479.0),
        line(3, "Your submitted waiver id is", 185.5, 9.0, x0=257.0, x1=379.0),
        line(4, footer, FOOTER_Y, CHROME),
    ])


def typeform_page() -> PageGeometry:
    return page(1, [
        line(0, TYPEFORM_HEADER, HEADER_Y, CHROME),
        line(1, "Your score suggests a high level of Confidence that can be maintained",
             226.6, 20.8, x0=84.0, x1=493.0),
        line(2, "and enhanced through study and practice as discussed in the canvas.",
             253.8, 20.8, x0=84.0, x1=493.0),
        line(3, TYPEFORM_FOOTER, FOOTER_Y, CHROME),
    ])


def kinds(blocks: Sequence[Block]) -> dict[int, str]:
    """Line index -> the kind of the block that holds it."""
    return {i: b.kind for b in blocks for i in b.line_ids}


def classified(geom: PageGeometry, stats: DocStats | None = None) -> dict[int, str]:
    return kinds(classify_page(geom, stats or compute_doc_stats([geom])))


def test_waiver_header_and_footer_are_print_chrome():
    """The prose stays: at 9 pt over a 7 pt body it reads as a heading, but it is spoken."""
    got = classified(waiver_page())
    assert (got[0], got[4]) == ("header", "footer")
    assert got[2] not in FURNITURE


def test_typeform_header_and_footer_are_print_chrome():
    got = classified(typeform_page(), DocStats(body_size=20.8, num_pages=1))
    assert (got[0], got[3], got[1], got[2]) == ("header", "footer", "body", "body")


def test_chrome_layout_date_first_and_page_fraction_footer():
    """Chrome puts the date first and ends the footer with `1/3`; a saved local file has a
    file:// URL."""
    got = classified(waiver_page(header="10/3/26, 6:16 PM What is the Industry Condition?",
                                 footer="file:///Users/me/form.html 1/3"))
    assert (got[0], got[4]) == ("header", "footer")


def test_signature_needs_the_outermost_line():
    """A dated line with text above it is part of the page, not its print header."""
    geom = page(1, [
        line(0, "Receipt", 12.0, CHROME),
        line(1, "Submitted on 7/23/26, 9:30 PM", HEADER_Y, CHROME),
        line(2, PROSE, 152.5, 9.0),
    ])
    assert classified(geom)[1] != "header"


def test_signature_needs_the_outer_band():
    """At 8% of the page the same text is not where a browser prints its header."""
    geom = page(1, [line(0, WAIVER_HEADER, 0.08 * PAGE_H, CHROME), line(1, PROSE, 152.5, 9.0)])
    assert classified(geom)[0] != "header"


def test_signature_needs_type_no_larger_than_the_body():
    geom = page(1, [
        line(0, "Ticket 7/23/26, 9:30 PM", HEADER_Y, 15.6),
        line(1, PROSE, 152.5, 9.0),
        line(2, "and keep this page for your records until the waiver is processed.",
             164.5, 9.0),
    ])
    assert classified(geom, DocStats(body_size=9.0))[0] != "header"


def test_url_in_prose_at_the_foot_is_not_a_footer():
    """Only a line that opens with the URL is the print footer."""
    geom = page(1, [
        line(0, "Your score suggests a high level of Confidence that can be maintained",
             226.6, CHROME),
        line(1, "The form is at https://form.typeform.com/to/H3YNDcvB for anyone who missed it",
             FOOTER_Y, CHROME),
    ])
    assert classified(geom)[1] != "footer"


def small_repeat_doc(n_pages: int, size: float) -> list[PageGeometry]:
    """A short print whose only furniture is a booking number, repeated at the top."""
    return [page(k, [
        line(0, "Booking number: #3341144806", 26.3, size, x0=466.0, x1=582.0),
        line(1, "Travelling with our buses is without regard to race, color or creed and",
             300.0, 10.0, x0=72.0, x1=540.0),
        line(2, "all passengers are asked to report to the counter two hours before.",
             312.0, 10.0, x0=72.0, x1=540.0),
    ]) for k in range(1, n_pages + 1)]


def test_small_edge_line_on_two_pages_is_repeated():
    pages = small_repeat_doc(2, size=6.0)
    stats = compute_doc_stats(pages)
    assert "booking number #" in stats.repeated
    assert classified(pages[1], stats)[0] == "header"


def test_body_size_edge_line_on_two_pages_is_not_repeated():
    """The two-page minimum is for small type only; a short doc's own text may repeat."""
    assert compute_doc_stats(small_repeat_doc(2, size=10.0)).repeated == frozenset()


def test_small_edge_line_on_one_page_is_not_repeated():
    assert compute_doc_stats(small_repeat_doc(1, size=6.0)).repeated == frozenset()
