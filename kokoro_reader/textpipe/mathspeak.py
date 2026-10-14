"""Rule-based verbalisation of mathematical notation (R7).

Input is text as pdf.js extracts it from a typeset paper: mostly Unicode math
glyphs, occasionally LaTeX fragments. Output is spoken English suitable for a
TTS engine.

Design
------
* All notation knowledge lives in module-level tables (dicts/tuples); the
  functions only apply them. Adding a symbol means editing data, not logic.
* ``speak`` is a fixed **ordered** pipeline of small pure stages. Ordering is
  the whole ballgame: structural, multi-character patterns must be consumed
  *before* single-glyph substitution, otherwise ``\\sum_{i=1}^{n}`` is shredded
  into "the sum of sub i equals 1 to the n" before the limits rule ever sees
  it. Each stage below carries the reason it sits where it sits.
* Every stage is idempotent on its own output, so ``speak(speak(t)) == speak(t)``.
  The general trick: each stage consumes the punctuation it triggers on
  (``^``, ``_``, ``|``, ``\\``, glyphs) and emits only plain words.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Callable, Final, Mapping

# --- Character classes --------------------------------------------------------- #

_GREEK_RANGE: Final = "\u0370-\u03ff\u1d6a-\u1d7f"
_IDENT: Final = f"A-Za-z0-9{_GREEK_RANGE}"

# --- Tables: LaTeX -> Unicode glyph -------------------------------------------- #

_GREEK_LOWER: Final[Mapping[str, str]] = {
    "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon",
    "ϵ": "epsilon", "ζ": "zeta", "η": "eta", "θ": "theta", "ϑ": "theta",
    "ι": "iota", "κ": "kappa", "λ": "lambda", "μ": "mu", "µ": "mu",
    "ν": "nu", "ξ": "xi", "ο": "omicron", "π": "pi", "ϖ": "pi", "ρ": "rho",
    "ϱ": "rho", "ς": "sigma", "σ": "sigma", "τ": "tau", "υ": "upsilon",
    "φ": "phi", "ϕ": "phi", "χ": "chi", "ψ": "psi", "ω": "omega",
}

# Capitals that are unambiguous in papers (Γ is the gamma function, Λ an
# eigenvalue matrix, ...). Σ / Π / Δ are handled contextually instead.
_GREEK_UPPER: Final[Mapping[str, str]] = {
    "Γ": "gamma", "Θ": "theta", "Λ": "lambda", "Ξ": "xi",
    "Φ": "phi", "Ψ": "psi", "Ω": "omega",
}

_LATEX_TO_GLYPH: Final[Mapping[str, str]] = {
    # Greek
    **{f"\\{name}": ch for ch, name in _GREEK_LOWER.items() if ch != "µ"},
    **{f"\\{name.capitalize()}": ch for ch, name in _GREEK_UPPER.items()},
    "\\Sigma": "Σ", "\\Pi": "Π", "\\Delta": "Δ", "\\varepsilon": "ε",
    "\\varphi": "φ", "\\vartheta": "θ",
    # relations / operators
    "\\leq": "≤", "\\le": "≤", "\\geq": "≥", "\\ge": "≥", "\\neq": "≠",
    "\\ne": "≠", "\\approx": "≈", "\\equiv": "≡", "\\propto": "∝",
    "\\sim": "∼", "\\pm": "±", "\\mp": "∓", "\\times": "×", "\\div": "÷",
    "\\cdot": "⋅", "\\circ": "∘", "\\otimes": "⊗", "\\oplus": "⊕",
    "\\setminus": "∖", "\\backslash": "∖", "\\odot": "⊙", "\\star": "⋆",
    "\\cup": "∪", "\\cap": "∩", "\\subset": "⊂", "\\subseteq": "⊆",
    "\\supset": "⊃", "\\supseteq": "⊇", "\\in": "∈", "\\notin": "∉",
    "\\forall": "∀", "\\exists": "∃", "\\nexists": "∄", "\\neg": "¬",
    "\\lnot": "¬", "\\land": "∧", "\\wedge": "∧", "\\lor": "∨",
    "\\vee": "∨", "\\to": "→", "\\rightarrow": "→", "\\gets": "←",
    "\\leftarrow": "←", "\\leftrightarrow": "↔", "\\Rightarrow": "⇒",
    "\\implies": "⇒", "\\Leftarrow": "⇐", "\\Leftrightarrow": "⇔",
    "\\iff": "⇔", "\\mapsto": "↦", "\\infty": "∞", "\\partial": "∂",
    "\\nabla": "∇", "\\emptyset": "∅", "\\varnothing": "∅", "\\ell": "ℓ",
    "\\dagger": "†", "\\top": "⊤", "\\perp": "⊥", "\\parallel": "∥",
    "\\triangleq": "≜", "\\coloneqq": "≔", "\\therefore": "∴",
    "\\because": "∵", "\\gg": "≫", "\\ll": "≪", "\\lfloor": "⌊",
    "\\rfloor": "⌋", "\\lceil": "⌈", "\\rceil": "⌉", "\\langle": "⟨",
    "\\rangle": "⟩", "\\|": "‖",
    # big operators (limits are parsed by _speak_big_operators)
    "\\sum": "∑", "\\prod": "∏", "\\int": "∫", "\\oint": "∮",
    "\\bigcup": "⋃", "\\bigcap": "⋂",
    # named function macros -> bare words, so `\arg\min_\theta` becomes
    # `argmin_θ` and is picked up by the argmin/argmax rule as one unit.
    "\\arg": "arg", "\\min": "min", "\\max": "max", "\\sup": "sup",
    "\\inf": "inf", "\\lim": "lim", "\\argmin": "argmin", "\\argmax": "argmax",
    "\\log": "log", "\\ln": "ln", "\\exp": "exp", "\\sin": "sin",
    "\\cos": "cos", "\\tan": "tan", "\\det": "det", "\\tr": "tr",
}

_MATHBB: Final[Mapping[str, str]] = {
    "R": "ℝ", "N": "ℕ", "Z": "ℤ", "Q": "ℚ", "C": "ℂ", "E": "𝔼", "P": "ℙ",
}

# --- Tables: single glyph -> spoken words -------------------------------------- #

_GLYPH_WORDS: Final[Mapping[str, str]] = {
    "≤": "less than or equal to", "≥": "greater than or equal to",
    "≠": "not equal to", "≈": "approximately equal to",
    "≡": "is equivalent to", "∝": "is proportional to",
    "∼": "distributed as", "±": "plus or minus", "∓": "minus or plus",
    "×": "times", "÷": "divided by", "⋅": "dot", "∘": "composed with",
    "⊗": "tensor product", "⊕": "direct sum", "∪": "union",
    "∩": "intersect", "⊂": "is a proper subset of", "⊆": "is a subset of",
    "⊃": "is a proper superset of", "⊇": "is a superset of",
    "∈": "element of", "∉": "not an element of", "∀": "for all",
    "∃": "there exists", "∄": "there does not exist", "¬": "not",
    "∧": "and", "∨": "or", "→": "goes to", "←": "is assigned",
    "↔": "if and only if", "⇒": "implies", "⇐": "is implied by",
    "⇔": "if and only if", "↦": "maps to", "∞": "infinity",
    "∂": "partial", "∇": "gradient", "√": "square root of",
    "∑": "the sum of", "∏": "the product of", "∫": "the integral of",
    "∮": "the contour integral of", "⋃": "the union of",
    "⋂": "the intersection of", "∅": "the empty set", "ℓ": "ell",
    "†": "dagger", "⊤": "transpose", "⊥": "perpendicular to",
    "∥": "parallel to", "‖": "norm", "≜": "is defined as",
    "≔": "is defined as", "∴": "therefore", "∵": "because",
    "≫": "much greater than", "≪": "much less than",
    "⌊": "the floor of", "⌋": " ", "⌈": "the ceiling of", "⌉": " ",
    "⟨": " ", "⟩": " ", "⟶": "goes to", "−": "minus",
    # Found missing while reading real linear-algebra and ML texts:
    "⩽": "less than or equal to", "⩾": "greater than or equal to",
    "⇝": "leads to", "♢": "end of example", "∎": "end of proof",
    "⋆": "star", "⊙": "elementwise product", "∖": "without",
    "‡": "double dagger", "·": "dot", "∗": "star", "≅": "is isomorphic to",
    "≪": "much less than", "⊊": "is a strict subset of", "∁": "the complement of",
    "∆": "delta", "∡": "angle", "∠": "angle", "≺": "precedes", "≻": "succeeds",
    "⪯": "is preceded by or equal to", "⪰": "succeeds or equals",
}

_SET_WORDS: Final[Mapping[str, str]] = {
    "ℝ": "the reals", "ℕ": "the naturals", "ℤ": "the integers",
    "ℚ": "the rationals", "ℂ": "the complexes", "𝔼": "the expectation",
    "ℙ": "the probability",
}

# Calligraphic capitals used as plain names (𝒪 is claimed earlier by _speak_order).
_SCRIPT_LETTERS: Final[Mapping[str, str]] = dict(
    zip("𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵", "ABCDEFGHIJKLMNPQRSTUVWXYZ")
)

_SUP_GLYPHS: Final[Mapping[str, str]] = dict(
    zip("⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱᵀᵃᵇᶜᵈᵉᵍʰʲᵏˡᵐᵒᵖʳˢᵗᵘᵛʷˣʸᶻ", "0123456789+-=()niTabcdeghjklmoprstuvwxyz")
)

_SUB_GLYPHS: Final[Mapping[str, str]] = dict(
    zip("₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ", "0123456789+-=()aehijklmnoprstuvx")
) | {"ᵦ": "beta", "ᵧ": "gamma"}

_SUP_WORDS: Final[Mapping[str, str]] = {
    "2": "squared", "3": "cubed", "T": "transpose", "⊤": "transpose",
    "-1": "inverse", "*": "star", "†": "dagger", "'": "prime",
}

_BIG_OP_NAMES: Final[Mapping[str, str]] = {
    "∑": "sum", "Σ": "sum", "∏": "product", "Π": "product",
    "∫": "integral", "∮": "contour integral", "⋃": "union",
    "⋂": "intersection",
}

_ORDER_NAMES: Final[Mapping[str, str]] = {
    "O": "big O", "𝒪": "big O", "Θ": "big theta", "Ω": "big omega",
    "o": "little o",
}

_LIMIT_NAMES: Final[Mapping[str, str]] = {
    "argmax": "arg max", "argmin": "arg min", "arg max": "arg max",
    "arg min": "arg min", "max": "max", "min": "min", "sup": "supremum",
    "inf": "infimum",
}

_MOMENT_NAMES: Final[Mapping[str, str]] = {
    "Var": "variance", "Cov": "covariance", "Corr": "correlation",
}

_STOPWORDS: Final[frozenset[str]] = frozenset(
    """a an the and or but if then that this these those we our us they it its
    is are was were be been being of in on for to from with without by as at
    have has had do does did can may might should would could will shall not
    show shows shown where when which while than there here also however thus
    such use used using paper method results model dataset""".split()
)

# --- Compiled patterns (module level; never rebuilt per call) ------------------ #

_WS_RE: Final = re.compile(r"\s+")
_LATEX_CMD_RE: Final = re.compile(r"\\[A-Za-z]+")
_MATHBB_RE: Final = re.compile(r"\\math(?:bb|cal|scr)\s*\{\s*([A-Za-z])\s*\}")
_TEXTLIKE_RE: Final = re.compile(
    r"\\(?:text|mathrm|mathbf|mathit|mathsf|boldsymbol|operatorname)\s*\{([^{}]*)\}"
)
_ENV_RE: Final = re.compile(r"\\(?:begin|end)\s*\{[^{}]*\}")
_SPACER_RE: Final = re.compile(r"\\(?:,|;|:|!|\s|quad|qquad|displaystyle|limits)")
_DELIM_RE: Final = re.compile(r"\\(?:left|right|big|Big|bigg|Bigg)\s*")
_DOLLAR_RE: Final = re.compile(r"\$\$?([^$]{1,400}?)\$\$?", re.DOTALL)
_MATHY_INNER_RE: Final = re.compile(r"[\\^_=<>]|[\u2190-\u22ff\u0370-\u03ff]")
_BRACKET_MATH_RE: Final = re.compile(r"\\[\[\]()]")

_SUP_RUN_RE: Final = re.compile(f"[{''.join(_SUP_GLYPHS)}]+")
_SUB_RUN_RE: Final = re.compile(f"[{''.join(_SUB_GLYPHS)}]+")

_EQ_NUM_RE: Final = re.compile(r"\(\s*(\d{1,3}[a-z]?)\s*\)\s*$")
_DEFINED_RE: Final = re.compile(r"\s*(?::=|≜|≔|=:)\s*")

_PARTIAL_FRAC_RE: Final = re.compile(
    r"\\[dt]?frac\s*\{\s*∂\s*([^{}]{1,30}?)\s*\}\s*\{\s*∂\s*([^{}]{1,30}?)\s*\}"
)
_D_FRAC_RE: Final = re.compile(
    r"\\[dt]?frac\s*\{\s*d\s*([^{}]{1,20}?)\s*\}\s*\{\s*d\s*([^{}]{1,20}?)\s*\}"
)
_PARTIAL_SLASH_RE: Final = re.compile(
    rf"∂\s*([{_IDENT}][{_IDENT}_^{{}}]{{0,12}}?)\s*/\s*∂\s*([{_IDENT}][{_IDENT}_^{{}}]{{0,12}}?)(?![{_IDENT}])"
)
_DYDX_RE: Final = re.compile(rf"\bd\s*([{_IDENT}])\s*/\s*d\s*([{_IDENT}])(?![{_IDENT}])")
_DDX_RE: Final = re.compile(rf"\bd\s*/\s*d\s*([{_IDENT}])(?![{_IDENT}])")
# Integral differential. Restricted to letters that never form an English word
# with a leading "d", so prose ("do", "day") is untouched.
_DIFFERENTIAL_RE: Final = re.compile(r"\bd([xyztuv])\b")

_BIG_OP_RE: Final = re.compile(
    r"(?P<op>[∑∏∫∮⋃⋂ΣΠ])"
    r"(?:\s*_\s*(?P<lo>\{[^{}]*\}|[^\s^{}]+))?"
    r"(?:\s*\^\s*(?P<hi>\{[^{}]*\}|[^\s_{}]+))?"
)
_LIMIT_RE: Final = re.compile(
    r"\b(?P<name>arg\s*max|arg\s*min|argmax|argmin|max|min|sup|inf|lim)"
    r"\s*_\s*(?P<sub>\{[^{}]*\}|[^\s^{}]+)"
)
_FRAC_RE: Final = re.compile(r"\\[dt]?frac\s*\{([^{}]{0,60})\}\s*\{([^{}]{0,60})\}")
_SLASH_RE: Final = re.compile(
    rf"(?<![{_IDENT}])(√?[{_IDENT}]|\d{{1,4}})\s*/\s*(√?[{_IDENT}]|\d{{1,4}})(?![{_IDENT}])"
)
_SQRT_RE: Final = re.compile(
    r"(?:\\sqrt|√)\s*(\{[^{}]{0,60}\}|\([^()]{0,60}\)|[A-Za-z0-9]+)"
)
_ORDER_RE: Final = re.compile(r"(?<![A-Za-z0-9])(?P<sym>𝒪|O|Θ|Ω|o)\s*\(\s*([^()]{1,40}?)\s*\)")
_KL_RE: Final = re.compile(
    r"\b(?:D\s*_\s*\{?\s*KL\s*\}?|KL)\s*\(\s*([^()‖∥|]{1,30}?)"
    r"\s*(?:‖|∥|\|\|)\s*([^()‖∥|]{1,30}?)\s*\)"
)
_COND_RE: Final = re.compile(
    rf"(?<![{_IDENT}])(?P<f>ℙ|[{_IDENT}])\s*\(\s*([^()|]{{1,30}}?)\s*\|\s*([^()|]{{1,30}}?)\s*\)"
)
_EXPECT_RE: Final = re.compile(
    r"(?:𝔼|\bE)\s*(?:_\s*(?P<sub>\{[^{}]*\}|[^\s\[{]{1,16}))?\s*\[\s*([^\[\]]{1,60}?)\s*\]"
)
_MOMENT_RE: Final = re.compile(r"\b(Var|Cov|Corr)\s*\(\s*([^()]{1,40}?)\s*\)")
_NORM_RE: Final = re.compile(
    r"(?:‖|∥|\|\|)\s*(?P<body>[^‖∥|]{1,40}?)\s*(?:‖|∥|\|\|)"
    r"(?:\s*_\s*(?P<sub>\{[^{}]*\}|[A-Za-z0-9∞]{1,8}))?"
)
_BARS_RE: Final = re.compile(r"\|\s*([^|]{1,30}?)\s*\|")
_FLOOR_RE: Final = re.compile(r"⌊\s*([^⌊⌋]{1,40}?)\s*⌋")
_CEIL_RE: Final = re.compile(r"⌈\s*([^⌈⌉]{1,40}?)\s*⌉")
_ANGLE_RE: Final = re.compile(r"⟨\s*([^⟨⟩]{1,40}?)\s*⟩")
_FUNCTYPE_RE: Final = re.compile(
    rf"(?<![{_IDENT}])([{_IDENT}])\s*:\s*([{_IDENT}ℝℕℤℚℂ][{_IDENT}ℝℕℤℚℂ^_{{}}]{{0,10}})"
    rf"\s*(?:→|↦|->)\s*([{_IDENT}ℝℕℤℚℂ][{_IDENT}ℝℕℤℚℂ^_{{}}]{{0,10}})"
)
_SUP_RE: Final = re.compile(r"\^\s*(\{[^{}]{0,40}\}|-?[A-Za-z0-9]{1,8}|[*†⊤'])")
_SUB_RE: Final = re.compile(rf"_\s*(\{{[^{{}}]{{0,40}}\}}|[{_IDENT}]{{1,8}}|[*])")
_FUNC_RE: Final = re.compile(rf"(?<![{_IDENT}])([{_IDENT}])\s*\(\s*([^()]{{1,18}}?)\s*\)")
_FUNC_BODY_RE: Final = re.compile(rf"[{_IDENT},;\s]+")
_WORD_RE: Final = re.compile(r"[A-Za-z]+")
_INNER_MINUS_RE: Final = re.compile(rf"(?<=[{_IDENT}])\s*-\s*(?=[{_IDENT}])")
_LEADING_MINUS_RE: Final = re.compile(r"^-\s*")
# Operator position = an operand follows. Uppercase Greek is excluded from the
# lookahead: "Σ Φ" is a list of symbols, not a sum over Φ.
_OPERAND_AHEAD: Final = r"A-Za-z0-9(\\α-ω"
_SIGMA_OP_RE: Final = re.compile(rf"(?<![{_IDENT}])Σ(?=\s*[{_OPERAND_AHEAD}∑])")
_PI_OP_RE: Final = re.compile(rf"(?<![{_IDENT}])Π(?=\s*[{_OPERAND_AHEAD}∏])")
_DELTA_OP_RE: Final = re.compile(rf"(?<![{_IDENT}])Δ(?=\s*[{_OPERAND_AHEAD}])")
# Unary minus: only after a relation/opening delimiter, so hyphenated prose
# ("state-of-the-art") and dashed lists are untouched.
_UNARY_MINUS_RE: Final = re.compile(rf"([=(\[{{,≤≥≈≠<>+×⋅→∈])\s*-\s*(?=[{_IDENT}(])")
_CMP_RE: Final = re.compile(r"<=|>=|!=|=<|=>")
_ANGLE_CMP_RE: Final = re.compile(rf"(?<=[{_IDENT}\s])([<>])(?=[\s{_IDENT}])")
_EQ_RE: Final = re.compile(r"(?<![<>=!:])=(?![=])")
_MINUS_RE: Final = re.compile(rf"\b([{_IDENT}])\s*-\s*([{_IDENT}])\b")
_SPACE_BEFORE_PUNCT_RE: Final = re.compile(r"\s+([,.;:!?])")
_TIGHT_COMMA_RE: Final = re.compile(r"(?<=[A-Za-z]),(?=[A-Za-z])")
_PAREN_SPACE_RE: Final = re.compile(r"\(\s+|\s+\)")

_CMP_WORDS: Final[Mapping[str, str]] = {
    "<=": " less than or equal to ", "=<": " less than or equal to ",
    ">=": " greater than or equal to ", "=>": " greater than or equal to ",
    "!=": " not equal to ",
}

_GLYPH_TABLE: Final = str.maketrans(
    {ch: f" {word} " for ch, word in _GLYPH_WORDS.items()}
    | {ch: f" {word} " for ch, word in _GREEK_LOWER.items()}
    | {ch: f" {word} " for ch, word in _GREEK_UPPER.items()}
)
_SET_TABLE: Final = str.maketrans(
    {ch: f" {w} " for ch, w in _SET_WORDS.items()}
    | {ch: f" {w} " for ch, w in _SCRIPT_LETTERS.items()}
)


# --- Match replacers -------------------------------------------------------- #


def _unbrace(raw: str) -> str:
    s = raw.strip()
    return s[1:-1].strip() if s.startswith("{") and s.endswith("}") else s


def _script_content(raw: str) -> str:
    """Verbalise the inside of a super/subscript: `i,j` -> `i j`, `n+1` -> `n plus 1`."""
    s = _unbrace(raw).replace(",", " ").replace("+", " plus ").replace("=", " equals ")
    s = _LEADING_MINUS_RE.sub("minus ", s)
    return _WS_RE.sub(" ", _INNER_MINUS_RE.sub(" minus ", s)).strip()


def _big_op_repl(match: re.Match[str]) -> str:
    op, lo, hi = match.group("op"), match.group("lo"), match.group("hi")
    if op in "ΣΠ" and lo is None and hi is None:
        return match.group(0)  # ambiguous bare capital; left to _speak_ambiguous_capitals
    name = _BIG_OP_NAMES[op]
    if lo is not None and hi is not None:
        return f" the {name} from {_script_content(lo)} to {_script_content(hi)} of "
    if lo is not None:
        return f" the {name} over {_script_content(lo)} of "
    if hi is not None:
        return f" the {name} up to {_script_content(hi)} of "
    return f" the {name} of "


def _limit_repl(match: re.Match[str]) -> str:
    sub = _script_content(match.group("sub"))
    key = _WS_RE.sub(" ", match.group("name").strip())
    if key == "lim":
        return f" the limit as {sub} of "
    return f" {_LIMIT_NAMES.get(key, key)} over {sub} of "


def _order_repl(match: re.Match[str]) -> str:
    return f" {_ORDER_NAMES[match.group('sym')]} of {match.group(2)} "


def _cond_repl(match: re.Match[str]) -> str:
    return f" {match.group('f')} of {match.group(2)} given {match.group(3)} "


def _expect_repl(match: re.Match[str]) -> str:
    sub = match.group("sub")
    under = f" under {_script_content(sub)}" if sub else ""
    return f" the expectation{under} of {match.group(2)} "


def _moment_repl(match: re.Match[str]) -> str:
    operands = " and ".join(p.strip() for p in match.group(2).split(","))
    return f" the {_MOMENT_NAMES[match.group(1)]} of {operands} "


def _norm_repl(match: re.Match[str]) -> str:
    body, sub = match.group("body"), match.group("sub")
    if sub is None:
        return f" the norm of {body} "
    inner = _unbrace(sub)
    return f" the {f'L{inner}' if inner.isdigit() else inner} norm of {body} "


def _bars_repl(match: re.Match[str]) -> str:
    body = match.group(1)
    kind = "cardinality" if len(body) == 1 and body.isupper() else "absolute value"
    return f" the {kind} of {body} "


def _angle_repl(match: re.Match[str]) -> str:
    body = match.group(1)
    if "," not in body:
        return f" the expectation of {body} "
    left, _, right = body.partition(",")
    return f" the inner product of {left.strip()} and {right.strip()} "


def _root_repl(match: re.Match[str]) -> str:
    return f" the square root of {_unbrace(match.group(1).strip('()'))} "


def _sup_repl(match: re.Match[str]) -> str:
    inner = _unbrace(match.group(1))
    word = _SUP_WORDS.get(inner)
    if word is None:
        content = _script_content(inner)
        word = f"to the {content}" if content else ""
    return f" {word} "


def _func_repl(match: re.Match[str]) -> str:
    """`f(x)` -> "f of x" only when the argument reads like an identifier list."""
    body = match.group(2)
    if not any(c.isalpha() for c in body):
        return match.group(0)
    if not _FUNC_BODY_RE.fullmatch(body):
        return match.group(0)
    if any(len(w) > 3 for w in _WORD_RE.findall(body)):
        return match.group(0)
    return f"{match.group(1)} of {body}"


def _cmp_repl(match: re.Match[str]) -> str:
    return " less than " if match.group(1) == "<" else " greater than "


# --- Stage factories -------------------------------------------------------- #

_Repl = str | Callable[[re.Match[str]], str]


def _sub(pattern: re.Pattern[str], repl: _Repl) -> Callable[[str], str]:
    """A stage that is exactly one regex substitution."""
    return lambda text: pattern.sub(repl, text)


def _translate(table: Mapping[int, str]) -> Callable[[str], str]:
    """A stage that is exactly one single-glyph translation table."""
    return lambda text: text.translate(table)


# --- Stages with real branching ---------------------------------------------- #


def _strip_latex(text: str) -> str:
    """Fold LaTeX into the Unicode dialect so later stages need only one path."""
    if "\\" not in text and "$" not in text:
        return text
    out = _ENV_RE.sub(" ", text)
    out = _TEXTLIKE_RE.sub(r"\1", out)
    out = _MATHBB_RE.sub(lambda m: _MATHBB.get(m.group(1), m.group(1)), out)
    out = _DELIM_RE.sub("", out)
    out = _SPACER_RE.sub(" ", out)
    out = _BRACKET_MATH_RE.sub(" ", out)
    # Unwrap $...$ only when the inside looks mathematical, so prose prices
    # ("$5 ... $10") keep their dollar signs.
    out = _DOLLAR_RE.sub(
        lambda m: m.group(1) if _MATHY_INNER_RE.search(m.group(1)) else m.group(0), out
    )
    return _LATEX_CMD_RE.sub(lambda m: _LATEX_TO_GLYPH.get(m.group(0), m.group(0)), out)


def _expand_unicode_scripts(text: str) -> str:
    """`x²` -> `x^{2}`, `xᵢ` -> `x_{i}` so one script parser covers both dialects."""
    out = _SUP_RUN_RE.sub(lambda m: "^{%s}" % "".join(_SUP_GLYPHS[c] for c in m.group(0)), text)
    return _SUB_RUN_RE.sub(lambda m: "_{%s}" % "".join(_SUB_GLYPHS[c] for c in m.group(0)), out)


def _drop_equation_number(text: str) -> str:
    """A right-flush `(3)` is a label, not content — but only on an equation line."""
    stripped = text.rstrip()
    match = _EQ_NUM_RE.search(stripped)
    if match is None:
        return text
    head = stripped[: match.start()].rstrip()
    if not head:
        return f"equation {match.group(1)}"
    return head if looks_like_equation(head) else text


def _speak_derivatives(text: str) -> str:
    """∂L/∂θ, dy/dx, d/dx, and the trailing differential of an integral."""
    out = _PARTIAL_FRAC_RE.sub(r" the partial derivative of \1 with respect to \2 ", text)
    out = _D_FRAC_RE.sub(r" the derivative of \1 with respect to \2 ", out)
    out = _PARTIAL_SLASH_RE.sub(r" the partial derivative of \1 with respect to \2 ", out)
    out = _DYDX_RE.sub(r" the derivative of \1 with respect to \2 ", out)
    out = _DDX_RE.sub(r" the derivative with respect to \1 ", out)
    return _DIFFERENTIAL_RE.sub(r"d \1", out)


def _speak_expectation(text: str) -> str:
    """E[·] / 𝔼[·] and the Var/Cov/Corr family."""
    return _MOMENT_RE.sub(_moment_repl, _EXPECT_RE.sub(_expect_repl, text))


def _speak_fences(text: str) -> str:
    """Paired ⌊⌋ ⌈⌉ ⟨⟩; unpaired leftovers fall through to the glyph table."""
    out = _FLOOR_RE.sub(r" the floor of \1 ", text)
    out = _CEIL_RE.sub(r" the ceiling of \1 ", out)
    return _ANGLE_RE.sub(_angle_repl, out)


def _speak_scripts(text: str) -> str:
    """Generic `^` / `_`, after every structural rule that owns its own scripts."""
    out = _SUP_RE.sub(_sup_repl, text)
    return _SUB_RE.sub(lambda m: f" sub {_script_content(m.group(1))} ", out)


#: `A \\ B` and `A\\{x}` are set difference; `\\{` `\\}` `\\|` are LaTeX escapes, not content.
_BRACE_RE: Final = re.compile(r"[{}]")
_ESCAPED_BRACE_RE: Final = re.compile(r"\\([{}|])")
_SET_MINUS_RE: Final = re.compile(
    r"(?<=[A-Za-z0-9\)\}\u2115\u2124\u211d\u211a\u2102])"
    r"\s*\\\s*"
    r"(?=[0-9(\\{\u2212-]|[A-Za-z](?![A-Za-z]))"   # a lone identifier, never a macro name
)


#: LaTeX typesets ≠ ≮ ≯ as the base relation plus U+0338 COMBINING LONG SOLIDUS OVERLAY,
#: and pdf.js hands both characters over separately. Dropping the mark silently INVERTS
#: the meaning — "z ̸= 1" was being read as "z equals 1".
_NEGATED: Final[Mapping[str, str]] = {"=": "≠", "<": "≮", ">": "≯", "∈": "∉", "≡": "≢"}
_COMBINING_SOLIDUS: Final = "\u0338"
_SOLIDUS_RE: Final = re.compile(r"([=<>\u2208\u2261])\u0338|\u0338\s*([=<>\u2208\u2261])")

#: Computer Modern emits large brackets as Private Use Area pieces (U+F8EE..U+F8FF).
#: They carry no meaning, and left in place they also break matrix-run detection.
_PUA_RE: Final = re.compile(r"[\uE000-\uF8FF]+")


#: Combining marks that carry mathematical meaning. Anything not listed here recomposes
#: unchanged, so accented names and loan words are untouched. Diaeresis and caron are
#: deliberately absent: `naïve` and `Öztürk` are overwhelmingly more common than `ẍ`.
_COMBINING_ACCENTS: Final[dict[str, str]] = {
    "\u0302": " hat",
    "\u0303": " tilde",
    "\u0304": " bar",
    "\u0305": " bar",
    "\u0307": " dot",
    "\u20d7": " vector",
}
#: The same marks as spacing characters, which is how a PDF extractor often leaves them.
_SPACING_ACCENTS: Final[dict[str, str]] = {
    "\u02c6": " hat",
    "\u02dc": " tilde",
    "\u00af": " bar",
    "\u02d9": " dot",
}

def _speak_negations(text: str) -> str:
    """Fold a combining solidus into the negated relation it modifies."""
    if _COMBINING_SOLIDUS not in text:
        return text
    return _SOLIDUS_RE.sub(lambda m: _NEGATED[m.group(1) or m.group(2)], text)


def _strip_private_use(text: str) -> str:
    """Drop decorative glyphs no font outside the PDF can interpret."""
    return _PUA_RE.sub(" ", text)


def _speak_accents(text: str) -> str:
    """`x̂` -> "x hat", `z̄` -> "z bar", `ỹ` -> "y tilde".

    Estimates and predictions are written with an accent in every paper this reader is
    for, and the mark reached the voice raw: `θ̂` was handed to TTS as "theta" followed by
    a bare combining circumflex. Both spellings occur in extracted text -- a combining
    mark (U+0302) and a spacing modifier the extractor left stranded after its letter
    (U+02C6 in `zˆk+1`) -- so both are handled.

    A mark is only spoken when its base letter *starts* a token, which is what a maths
    variable does and what a letter inside a word does not: `x̂` and `ẑt` are read, while
    `naïve` and `Núñez` keep their spelling.
    """
    if any(ch in text for ch in _SPACING_ACCENTS):
        text = "".join(_SPACING_ACCENTS.get(ch, ch) + " " if ch in _SPACING_ACCENTS else ch
                       for ch in text)
    decomposed = unicodedata.normalize("NFD", text)
    if not any(ch in decomposed for ch in _COMBINING_ACCENTS):
        return unicodedata.normalize("NFC", text)
    out: list[str] = []
    for i, ch in enumerate(decomposed):
        word = _COMBINING_ACCENTS.get(ch)
        if word and _starts_a_token(decomposed, i):
            out.append(word + " ")
        else:
            out.append(ch)
    return unicodedata.normalize("NFC", "".join(out))


def _starts_a_token(decomposed: str, mark_index: int) -> bool:
    """Is the letter this mark sits on the first letter of its token?"""
    base = mark_index - 1
    while base >= 0 and unicodedata.combining(decomposed[base]):
        base -= 1
    if base < 0:
        return True
    before = base - 1
    while before >= 0 and unicodedata.combining(decomposed[before]):
        before -= 1          # another letter's accent is not a token boundary (`Núñez`)
    return before < 0 or not decomposed[before].isalpha()


def _speak_set_difference(text: str) -> str:
    r"""`R\{-1}` and `X \ Y` are set difference, not a stray backslash.

    Must run before `_speak_leftover_latex` (which drops backslashes) and before the
    escaped braces are unwrapped, or the backslash is gone before we can read it.
    """
    if "\\" not in text:
        return text
    out = _SET_MINUS_RE.sub(" without ", text)
    return _ESCAPED_BRACE_RE.sub(r"\1", out)


def _speak_leftover_latex(text: str) -> str:
    """Unknown macros: drop the backslash rather than let the TTS say it."""
    return _LATEX_CMD_RE.sub(lambda m: f" {m.group(0)[1:]} ", text) if "\\" in text else text


def _speak_ambiguous_capitals(text: str) -> str:
    """Σ/Π/Δ: an operator when an operand follows, otherwise a named matrix."""
    out = _SIGMA_OP_RE.sub(" the sum of ", text)
    out = _PI_OP_RE.sub(" the product of ", out)
    out = _DELTA_OP_RE.sub(" delta ", out)
    return (
        out.replace("Σ", " capital sigma ")
        .replace("Π", " capital pi ")
        .replace("Δ", " capital delta ")
    )


def _speak_ascii_operators(text: str) -> str:
    """ASCII relations. `-` only between single-token operands, so hyphens survive."""
    out = _CMP_RE.sub(lambda m: _CMP_WORDS[m.group(0)], text)
    out = _ANGLE_CMP_RE.sub(_cmp_repl, out)
    out = _EQ_RE.sub(" equals ", out)
    out = out.replace("+", " plus ")
    return _MINUS_RE.sub(r"\1 minus \2", out)


#: A typeset matrix flattens into a bare run of numbers. Reading "1 0 2 0 1 1 0 0" aloud
#: is strictly worse than silence, but the prose around it must survive, so collapse only
#: the run. "minus" is included because the glyph table has already rewritten the signs.
_MIN_MATRIX_TOKENS: Final = 6
_MIN_MATRIX_DIGITS: Final = 5
_NUMBER_RUN_RE: Final = re.compile(r"(?:(?:\d+(?:\.\d+)?|minus)\s+){%d,}(?:\d+(?:\.\d+)?|minus)"
                                   % (_MIN_MATRIX_TOKENS - 1))


_REPEATED_MATRIX_RE: Final = re.compile(r"\bmatrix(?:[\s,]+matrix)+\b")


def _collapse_matrices(text: str) -> str:
    """Replace a long run of bare numbers with the word "matrix"."""
    def repl(m: re.Match[str]) -> str:
        digits = sum(1 for tok in m.group(0).split() if tok[0].isdigit())
        return " matrix " if digits >= _MIN_MATRIX_DIGITS else m.group(0)
    # One matrix broken across several rows collapses to several "matrix" tokens in a row;
    # say it once.
    return _REPEATED_MATRIX_RE.sub("matrix", _NUMBER_RUN_RE.sub(repl, text))


def _tidy_spacing(text: str) -> str:
    """Collapse the whitespace every insertion above deliberately over-produced."""
    out = _WS_RE.sub(" ", text).strip()
    out = _PAREN_SPACE_RE.sub(lambda m: m.group(0).strip(), out)
    out = _TIGHT_COMMA_RE.sub(", ", out)
    out = _BRACE_RE.sub(" ", out)
    out = _WS_RE.sub(" ", out).strip()
    return _SPACE_BEFORE_PUNCT_RE.sub(r"\1", out)


# --- The pipeline ------------------------------------------------------------ #
#
# ORDER IS LOAD-BEARING. Structural, multi-character patterns must consume their
# own `^`, `_`, `|`, `/` and parens *before* the generic parsers and the
# single-glyph table run, or `\sum_{i=1}^{n}` is shredded into "the sum of sub i
# equals 1 to the n". Each comment below states what breaks if the stage moves.

_STAGES: Final[tuple[Callable[[str], str], ...]] = (
    _strip_private_use,                              # before anything reads the character stream
    _speak_accents,                                  # while the mark is still next to its letter
    _speak_negations,                                # before the glyph table sees a bare '='
    _strip_latex,                                    # LaTeX -> Unicode; everything downstream assumes glyphs
    _expand_unicode_scripts,                         # x² -> x^{2}; one script parser for both dialects
    _drop_equation_number,                           # before f(x) claims the trailing "(3)"
    _sub(_DEFINED_RE, " is defined as "),            # before bare `=` and `f: A → B` split `:=`
    _speak_derivatives,                              # before fractions: "∂L over ∂θ" is wrong
    _sub(_BIG_OP_RE, _big_op_repl),                  # owns the `_`/`^` limits of ∑ ∏ ∫
    _sub(_LIMIT_RE, _limit_repl),                    # owns the `_` of argmax / min / lim
    _sub(_FRAC_RE, r" \1 over \2 "),                 # \frac only; ASCII a/b waits for _SLASH_RE
    _sub(_ORDER_RE, _order_repl),                    # before Greek, or Θ/Ω become theta/omega
    _sub(_KL_RE, r" the KL divergence from \1 to \2 "),  # ‖ is a separator here, not a norm
    _sub(_COND_RE, _cond_repl),                      # before |…|, or p(y|x) reads as absolute value
    _speak_expectation,                              # before generic function application
    _sub(_NORM_RE, _norm_repl),                      # doubled bars before single bars
    _sub(_BARS_RE, _bars_repl),                      # |x| / |S|
    _speak_fences,                                   # paired ⌊⌋ ⌈⌉ ⟨⟩
    _sub(_FUNCTYPE_RE, r" \1 from \2 to \3 "),       # before `→` becomes "goes to"
    _speak_scripts,                                  # generic ^ and _
    _sub(_FUNC_RE, _func_repl),                      # f(x) -> f of x
    _sub(_SLASH_RE, r"\1 over \2"),                  # after f(x): p(z)/p(x) needs the parens gone
    _sub(_SQRT_RE, _root_repl),                      # before √ hits the glyph table
    _speak_set_difference,                           # before macro cleanup eats the backslash
    _speak_leftover_latex,                           # after every macro-aware stage
    _translate(_SET_TABLE),                          # after scripts, so ℝ^d is already "ℝ to the d"
    _speak_ambiguous_capitals,                       # Σ/Π/Δ need their operand still visible
    _sub(_UNARY_MINUS_RE, r"\1 minus "),             # while relation glyphs are still glyphs
    _translate(_GLYPH_TABLE),                        # single-glyph fallback, pre-empts nothing
    _speak_ascii_operators,                          # = + - < >
    _collapse_matrices,                             # after signs are words, before spacing
    _tidy_spacing,                                   # collapse the padding every stage emitted
)


# --- Public API ---------------------------------------------------------------- #


def speak(text: str) -> str:
    """Rewrite math notation as spoken English. Idempotent on plain prose."""
    if not text or not text.strip():
        return text
    out = text
    for stage in _STAGES:
        out = stage(out)
    return out


# --- Density / classification -------------------------------------------------- #

_MATH_CHARS: Final[frozenset[str]] = frozenset(
    set(_GLYPH_WORDS) | set(_GREEK_LOWER) | set(_GREEK_UPPER) | set(_SET_WORDS)
    | set(_SUP_GLYPHS) | set(_SUB_GLYPHS) | {"Σ", "Π", "Δ", "𝒪", "‖", "∥"}
)

# ASCII notation that is mathematical only in context; weight is per character
# of the match, so `\sum` counts more than a lone `=`.
_ASCII_MATH: Final[tuple[tuple[re.Pattern[str], float], ...]] = (
    (re.compile(rf"\^\s*(?:\{{[^{{}}]*\}}|-?[{_IDENT}]+|\*)"), 1.5),
    (re.compile(rf"(?<=[{_IDENT}])_\s*(?:\{{[^{{}}]*\}}|[{_IDENT}]+)"), 1.5),
    (re.compile(r"<=|>=|!=|:="), 3.0),
    (re.compile(r"(?<![<>=!:])=(?![=])"), 3.0),
    (re.compile(r"\\[A-Za-z]+"), 1.0),
    (re.compile(rf"(?<=[{_IDENT}])\s*[+*/]\s*(?=[{_IDENT}])"), 2.0),
    # Function application is weak evidence on its own: prose sentences quote
    # f(x) too, so the body must look like an identifier list and the weight is
    # low enough that a lone f(x) cannot carry a sentence over the threshold.
    (re.compile(rf"(?<![{_IDENT}])[A-Za-z]\([{_IDENT},\s]{{1,8}}\)"), 1.0),
)

_RELATION_RE: Final = re.compile(r"[=≤≥≈≡≠<>∝∼]")
_TOKEN_RE: Final = re.compile(r"[A-Za-z]{2,}")

_EQUATION_DENSITY: Final = 0.25
# Three or more function words means a sentence carrying inline math, not a
# display equation, however dense the notation is.
_MAX_EQUATION_STOPWORDS: Final = 2
_SHORT_EQUATION_CHARS: Final = 48
_SHORT_EQUATION_DENSITY: Final = 0.12


def math_density(text: str) -> float:
    """0..1 — fraction of characters that are mathematical. Used to route to the LLM."""
    dense = [c for c in text if not c.isspace()]
    if not dense:
        return 0.0
    score = float(sum(1 for c in dense if c in _MATH_CHARS))
    for pattern, weight in _ASCII_MATH:
        score += weight * sum(len(m.group(0)) for m in pattern.finditer(text))
    return min(1.0, score / len(dense))


def _stopword_count(tokens: list[str]) -> int:
    return sum(1 for t in tokens if t.lower() in _STOPWORDS)


def reads_as_sentence(text: str) -> bool:
    """True when `text` carries enough function words to be prose, whatever its notation.

    An all-caps token is an operator or an acronym, not a function word: `OF(x_t)` is optical flow.
    """
    words = [t for t in _TOKEN_RE.findall(text) if not t.isupper()]
    return _stopword_count(words) > _MAX_EQUATION_STOPWORDS


def looks_like_equation(text: str) -> bool:
    """True for display/inline math; False for prose that merely contains a number."""
    stripped = text.strip()
    if not stripped:
        return False
    density = math_density(stripped)
    tokens = _TOKEN_RE.findall(stripped)
    stopwords = _stopword_count(tokens)
    if stopwords > _MAX_EQUATION_STOPWORDS:
        return False
    if density >= _EQUATION_DENSITY:
        return True
    if _RELATION_RE.search(stripped) and stopwords == 0 and len(tokens) <= 3:
        return True
    return (
        len(stripped) <= _SHORT_EQUATION_CHARS
        and density >= _SHORT_EQUATION_DENSITY
        and stopwords == 0
    )
