"""Shared data types for the text pipeline.

The client (pdf.js) produces `Line`s; the pipeline produces `Block`s and `Sentence`s.
Everything here is frozen — transformations return new objects, never mutate inputs.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Iterable


@dataclass(frozen=True)
class Line:
    """One visual line of text on a page, as extracted by pdf.js.

    Coordinates are in PDF user space with the origin at the *top* left
    (i.e. already flipped by the client), in the same units as ``page_width``/
    ``page_height`` reported for the page.
    """

    idx: int                    # index of this line within the page
    text: str                   # concatenated item strings, single-spaced
    x0: float
    x1: float
    y: float                    # baseline, top-origin
    size: float                 # dominant glyph height
    font: str = ""              # dominant pdf.js font name
    items: tuple[int, ...] = () # pdf.js text-item indices making up this line
    item_x: tuple[float, ...] = ()   # x0 of each item, parallel to `items`
    item_text: tuple[str, ...] = ()  # str of each item, parallel to `items`
    item_size: tuple[float, ...] = ()  # glyph height of each item, parallel to `items`
    turned: bool = False        # set 90° to the page; its box is then one em wide

    @property
    def width(self) -> float:
        return max(0.0, self.x1 - self.x0)

    @staticmethod
    def from_json(d: dict[str, Any]) -> "Line":
        return Line(
            idx=int(d["idx"]),
            text=str(d.get("text", "")),
            x0=float(d.get("x0", 0.0)),
            x1=float(d.get("x1", 0.0)),
            y=float(d.get("y", 0.0)),
            size=float(d.get("size", 0.0)),
            font=str(d.get("font", "")),
            items=tuple(int(i) for i in d.get("items", ())),
            item_x=tuple(float(v) for v in d.get("item_x", ())),
            item_text=tuple(str(v) for v in d.get("item_text", ())),
            item_size=tuple(float(v) for v in d.get("item_size", ())),
            turned=d.get("turned") is True,  # only a JSON true: "false" is a truthy string
        )


@dataclass(frozen=True)
class PageGeometry:
    """A page's lines plus the box they live in."""

    page: int
    width: float
    height: float
    lines: tuple[Line, ...]

    @staticmethod
    def from_json(d: dict[str, Any]) -> "PageGeometry":
        return PageGeometry(
            page=int(d["page"]),
            width=float(d.get("width", 612.0)) or 612.0,
            height=float(d.get("height", 792.0)) or 792.0,
            lines=tuple(Line.from_json(x) for x in d.get("lines", ())),
        )


@dataclass(frozen=True)
class DocStats:
    """Document-level facts the client computes once, before classifying any page.

    `repeated` holds normalised line texts that appear on many pages — running heads,
    running feet, journal stamps. `body_size` is the modal body font size.
    """

    body_size: float = 10.0
    num_pages: int = 1
    repeated: frozenset[str] = frozenset()
    reference_page: int | None = None   # first page of the bibliography, if found
    reference_y: float | None = None    # ...and the heading's baseline on that page
    reference_end_page: int | None = None  # first page of an appendix that ends it
    #: Baseline y values (rounded to whole units) in the edge bands where a short line sits
    #: on most pages. A running head whose *text* changes per section — "2.4 Vector Spaces
    #: 35" — still lands on the same y every time, so position catches what text cannot.
    repeated_y: frozenset[int] = frozenset()

    @staticmethod
    def from_json(d: dict[str, Any]) -> "DocStats":
        return DocStats(
            body_size=float(d.get("body_size", 10.0)) or 10.0,
            num_pages=int(d.get("num_pages", 1)) or 1,
            repeated=frozenset(str(s) for s in d.get("repeated", ())),
            reference_page=(int(d["reference_page"])
                            if d.get("reference_page") is not None else None),
            reference_y=(float(d["reference_y"])
                         if d.get("reference_y") is not None else None),
            reference_end_page=(int(d["reference_end_page"])
                                if d.get("reference_end_page") is not None else None),
            repeated_y=frozenset(int(v) for v in d.get("repeated_y", ())),
        )


@dataclass(frozen=True)
class Block:
    """A classified run of lines.

    `text` is the display/raw text; `spoken` is what TTS should say (filled in later by
    normalize/mathspeak/llm). `items` is the flattened pdf.js item indices, used by the
    client to highlight the right glyphs while this block is read.
    """

    kind: str                   # one of config.BLOCK_KINDS
    text: str
    page: int
    line_ids: tuple[int, ...] = ()
    items: tuple[int, ...] = ()
    spoken: str = ""
    speak: bool = True
    source: str = "rules"       # "rules" | "llm"
    reason: str = ""            # why it was classified this way (debug/UI tooltip)

    def with_spoken(self, spoken: str, source: str = "rules") -> "Block":
        return replace(self, spoken=spoken, source=source)

    def to_json(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "text": self.text,
            "page": self.page,
            "line_ids": list(self.line_ids),
            "items": list(self.items),
            "spoken": self.spoken,
            "speak": self.speak,
            "source": self.source,
            "reason": self.reason,
        }


#: One page's share of a sentence: the page and the pdf.js items it covers there.
Part = tuple[int, tuple[int, ...]]


@dataclass(frozen=True)
class Sentence:
    """One TTS unit. The client plays these in order.

    A sentence that runs over a page turn (N4) keeps `page` and `items` for where it
    starts -- every consumer that knows one page still reads it right -- and lists every
    page's share in `spans`. A one-page sentence leaves `spans` empty.
    """

    text: str                   # what Kokoro is asked to say
    raw: str                    # original on-page text, for the queue preview
    page: int
    kind: str
    items: tuple[int, ...] = ()
    source: str = "rules"
    spans: tuple[Part, ...] = ()

    @property
    def parts(self) -> tuple[Part, ...]:
        """Each page the sentence is on, in reading order, with its items there."""
        return self.spans or ((self.page, self.items),)

    def to_json(self) -> dict[str, Any]:
        out = {
            "text": self.text,
            "raw": self.raw,
            "page": self.page,
            "kind": self.kind,
            "items": list(self.items),
            "source": self.source,
        }
        if self.spans:
            out["spans"] = [{"page": page, "items": list(items)} for page, items in self.spans]
        return out


def flatten_items(lines: Iterable[Line]) -> tuple[int, ...]:
    out: list[int] = []
    for ln in lines:
        out.extend(ln.items)
    return tuple(out)
