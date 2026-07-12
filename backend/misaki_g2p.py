"""Dependency-light Misaki-compatible English G2P for Folio's Kokoro model.

The packaged runtime uses pinned, mechanically compacted Misaki dictionaries
as its primary path. eSpeak NG is initialized lazily and called only for a
word that cannot be resolved by the lexicon/context/morphology rules.
"""

from __future__ import annotations

import gzip
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


REVISION = "fba1236595f2d2bf21d414ba6e57d25256afada3"
STRATEGY = f"misaki-en@{REVISION} + espeak-ng-ood"
DATA_DIR = Path(__file__).resolve().parent / "misaki_data"

PUNCTUATION = ';:,.!?—…"“”()'
NON_QUOTE_PUNCTUATION = ";:,.!?—…"
APOSTROPHES = "'‘’"
VOWELS = frozenset("AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ")
CONSONANTS = frozenset("bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ")
PRONOUNS = {"i", "you", "we", "they", "he", "she", "it"}
DETERMINERS = {"a", "an", "the", "this", "that", "these", "those", "my", "your", "his", "her", "our", "their"}
MODALS = {"can", "could", "may", "might", "must", "shall", "should", "will", "would"}
AUXILIARIES = {"do", "does", "did", "have", "has", "had", "am", "are", "is", "was", "were"}
SYMBOL_WORDS = {"%": "percent", "&": "and", "+": "plus", "@": "at", "/": "slash", ".": "dot"}
CURRENCY_UNITS = {"$": ("dollar", "cent"), "£": ("pound", "pence"), "€": ("euro", "cent")}
TITLES = {"Dr", "Mr", "Mrs", "Ms", "Prof", "Sr", "Jr", "St"}
SMALL_NUMBERS = (
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
)
TENS = ("", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety")
LARGE_UNITS = ((1_000_000_000, "billion"), (1_000_000, "million"), (1_000, "thousand"), (100, "hundred"))
ORDINALS = {
    1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth",
    7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth", 11: "eleventh",
    12: "twelfth", 13: "thirteenth", 20: "twentieth",
}
ORDINAL_WORD_FOR_CARDINAL = {
    "one": "first", "two": "second", "three": "third", "four": "fourth",
    "five": "fifth", "six": "sixth", "seven": "seventh", "eight": "eighth",
    "nine": "ninth", "ten": "tenth", "twelve": "twelfth", "twenty": "twentieth",
    "thirty": "thirtieth", "forty": "fortieth", "fifty": "fiftieth",
}
ESPEAK_TO_MISAKI = sorted(
    {
        "ʔˌn̩": "ʔn", "ʔn̩": "ʔn", "a^ɪ": "I", "a͡ɪ": "I", "aɪ": "I",
        "a^ʊ": "W", "a͡ʊ": "W", "aʊ": "W", "d^ʒ": "ʤ", "d͡ʒ": "ʤ", "dʒ": "ʤ",
        "e^ɪ": "A", "e͡ɪ": "A", "eɪ": "A", "t^ʃ": "ʧ", "t͡ʃ": "ʧ", "tʃ": "ʧ",
        "ɔ^ɪ": "Y", "ɔ͡ɪ": "Y", "ɔɪ": "Y", "ə^l": "ᵊl", "ə͡l": "ᵊl",
        "ʲo": "jo", "ʲə": "jə", "ʲ": "", "ɚ": "əɹ", "r": "ɹ", "x": "k",
        "ç": "k", "ɐ": "ə", "ɬ": "l", "\u0303": "", "e": "A",
    }.items(),
    key=lambda item: -len(item[0]),
)


def _unescape(value: str) -> str:
    if "\\" not in value:
        return value
    result: list[str] = []
    index = 0
    while index < len(value):
        character = value[index]
        index += 1
        if character != "\\" or index >= len(value):
            result.append(character)
            continue
        escaped = value[index]
        index += 1
        result.append({"t": "\t", "r": "\r", "n": "\n", "\\": "\\"}.get(escaped, escaped))
    return "".join(result)


@dataclass(frozen=True)
class LexiconEntry:
    rating: int
    value: str | None
    variants: dict[str, str | None]

    def resolve(self, tag: str | None, future_vowel: bool | None) -> str | None:
        if self.value is not None:
            return self.value
        if future_vowel is None and "None" in self.variants:
            return self.variants["None"]
        if tag is not None and tag in self.variants:
            return self.variants[tag]
        if tag and tag.startswith("VB"):
            parent = "VERB"
        elif tag and tag.startswith("NN"):
            parent = "NOUN"
        elif tag and (tag.startswith("RB") or tag.startswith("ADV")):
            parent = "ADV"
        elif tag and (tag.startswith("JJ") or tag.startswith("ADJ")):
            parent = "ADJ"
        else:
            parent = tag
        return self.variants.get(parent, self.variants.get("DEFAULT"))


class EnglishLexicon:
    def __init__(self, path: Path, expected_dialect: str):
        raw = gzip.decompress(path.read_bytes())
        if len(raw) > 32 * 1024 * 1024:
            raise RuntimeError("Misaki lexicon is unexpectedly large")
        header_end = raw.find(b"\n")
        if header_end <= 0:
            raise RuntimeError("Misaki lexicon header is missing")
        header = raw[:header_end].decode("utf-8").split("\t")
        if header[:4] != ["FOLIO-MISAKI-LEXICON", "1", REVISION, expected_dialect] or len(header) != 5:
            raise RuntimeError("Misaki lexicon revision or dialect is incompatible")
        expected_count = int(header[4])
        starts: list[int] = []
        start = header_end + 1
        while start < len(raw):
            if raw[start] != 10:
                starts.append(start)
            end = raw.find(b"\n", start)
            if end < 0:
                break
            start = end + 1
        if len(starts) != expected_count:
            raise RuntimeError("Misaki lexicon is truncated")
        self.raw = raw
        self.starts = tuple(starts)
        self.dialect = expected_dialect
        self._cache: dict[str, LexiconEntry | None] = {}

    def lookup(self, word: str) -> LexiconEntry | None:
        if word in self._cache:
            return self._cache[word]
        target = word.encode("utf-8")
        low, high = 0, len(self.starts) - 1
        while low <= high:
            middle = (low + high) // 2
            start = self.starts[middle]
            key_end = self.raw.find(b"\t", start)
            key = self.raw[start:key_end]
            if key < target:
                low = middle + 1
            elif key > target:
                high = middle - 1
            else:
                entry = self._decode(start)
                self._cache[word] = entry
                return entry
        self._cache[word] = None
        return None

    def _decode(self, start: int) -> LexiconEntry:
        end = self.raw.find(b"\n", start)
        if end < 0:
            end = len(self.raw)
        fields = self.raw[start:end].decode("utf-8").split("\t")
        if len(fields) < 4:
            raise RuntimeError("Misaki lexicon record is truncated")
        rating = int(fields[1])
        if fields[2] == "S":
            return LexiconEntry(rating, _unescape(fields[3]), {})
        if fields[2] != "M":
            raise RuntimeError("Misaki lexicon record uses an unknown value kind")
        variants: dict[str, str | None] = {}
        for field in fields[3:]:
            tag, separator, encoded = field.partition("=")
            if not separator:
                raise RuntimeError("Misaki lexicon variant is malformed")
            variants[_unescape(tag)] = None if encoded == "~" else _unescape(encoded)
        if "DEFAULT" not in variants:
            raise RuntimeError("Misaki lexicon variant is missing DEFAULT")
        return LexiconEntry(rating, None, variants)


@dataclass(frozen=True)
class G2PTelemetry:
    strategy: str
    dialect: str
    fallback_words: tuple[str, ...]

    @property
    def fallback_count(self) -> int:
        return len(self.fallback_words)


@dataclass(frozen=True)
class G2PResult:
    phonemes: str
    telemetry: G2PTelemetry


@dataclass
class _Token:
    text: str
    whitespace: str
    kind: str
    phonemes: str | None = None


@dataclass(frozen=True)
class _Context:
    future_vowel: bool | None = None
    future_to: bool = False


class _EspeakFallback:
    def __init__(self):
        self.backends: dict[str, object] = {}
        self.lock = threading.Lock()

    def __call__(self, word: str, language: str) -> str:
        with self.lock:
            backend = self.backends.get(language)
            if backend is None:
                import espeakng_loader
                import phonemizer
                from phonemizer.backend.espeak.wrapper import EspeakWrapper

                EspeakWrapper.set_library(espeakng_loader.get_library_path())
                EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
                backend = phonemizer.backend.EspeakBackend(
                    language=language,
                    preserve_punctuation=True,
                    with_stress=True,
                    tie="^",
                )
                self.backends[language] = backend
            values = backend.phonemize([word])
        if not values or not values[0].strip():
            raise RuntimeError(f"eSpeak NG returned no phonemes for {word!r}")
        return values[0].strip()


class MisakiEnglishG2P:
    def __init__(
        self,
        data_dir: Path | str = DATA_DIR,
        fallback: Callable[[str, str], str] | None = None,
    ):
        self.data_dir = Path(data_dir)
        self.fallback = fallback or _EspeakFallback()
        self.lexicons: dict[str, EnglishLexicon] = {}
        self.lock = threading.RLock()
        self.last_telemetry = G2PTelemetry(STRATEGY, "us", ())

    def phonemize(self, text: str, british: bool = False) -> G2PResult:
        dialect = "gb" if british else "us"
        language = "en-gb" if british else "en-us"
        with self.lock:
            lexicon = self.lexicons.get(dialect)
            if lexicon is None:
                lexicon = EnglishLexicon(self.data_dir / f"{dialect}.lex.gz", dialect)
                self.lexicons[dialect] = lexicon
            tokens = self._tokenize(text)
            if not tokens:
                raise ValueError("Text is required for phonemization")
            fallback_words: list[str] = []
            context = _Context()
            for index in range(len(tokens) - 1, -1, -1):
                token = tokens[index]
                if token.kind == "punctuation":
                    token.phonemes = "—" if token.text in {"-", "–"} else "".join(c for c in token.text if c in PUNCTUATION)
                elif token.kind == "symbol":
                    if token.text in CURRENCY_UNITS and self._next_token(tokens, index, "number"):
                        token.phonemes = ""
                    else:
                        word = SYMBOL_WORDS.get(token.text)
                        token.phonemes = self._lookup_pronunciation(word, None, None, lexicon) if word else ""
                elif token.kind == "number":
                    previous = tokens[index - 1].text if index > 0 and tokens[index - 1].text in CURRENCY_UNITS else None
                    token.phonemes = self._number(token.text, lexicon, previous)
                else:
                    token.phonemes = self._word(
                        token.text,
                        self._previous_word(tokens, index),
                        self._next_word(tokens, index),
                        context,
                        lexicon,
                        british,
                    )
                    if token.phonemes is None:
                        fallback_words.append(token.text)
                        token.phonemes = self._convert_espeak(self.fallback(token.text, language), british)
                context = self._update_context(context, token.phonemes or "", token)
            phonemes = "".join((token.phonemes or "") + token.whitespace for token in tokens).rstrip()
            phonemes = phonemes.replace("ɾ", "T").replace("ʔ", "t")
            if not phonemes.strip():
                raise RuntimeError("Misaki phonemization produced no usable text")
            telemetry = G2PTelemetry(STRATEGY, dialect, tuple(fallback_words))
            self.last_telemetry = telemetry
            if fallback_words:
                print(f"Misaki {dialect} used eSpeak NG fallback for {len(fallback_words)} word(s): {', '.join(fallback_words)}")
            return G2PResult(phonemes, telemetry)

    def _lookup_entry(self, word: str, lexicon: EnglishLexicon) -> LexiconEntry | None:
        return lexicon.lookup(word) or lexicon.lookup(word.lower())

    def _lookup_pronunciation(
        self, word: str | None, tag: str | None, future_vowel: bool | None, lexicon: EnglishLexicon
    ) -> str | None:
        if word is None:
            return None
        entry = self._lookup_entry(word, lexicon)
        return entry.resolve(tag, future_vowel) if entry else None

    def _word(
        self,
        original: str,
        previous_word: str | None,
        next_word: str | None,
        context: _Context,
        lexicon: EnglishLexicon,
        british: bool,
    ) -> str | None:
        normalized = original.replace("‘", "'").replace("’", "'")
        lower = normalized.lower()
        parts = [part for part in normalized.strip(".").split(".") if part]
        if "." in normalized.strip(".") and all(len(part) < 3 for part in parts):
            pronounced: list[str] = []
            for letter in (c for c in normalized if c.isalpha()):
                value = self._lookup_pronunciation(letter.upper(), None, None, lexicon)
                if value is None:
                    return None
                pronounced.append(value)
            spelled = "".join(pronounced).replace("ˈ", "ˌ")
            last = spelled.rfind("ˌ")
            return spelled if last < 0 else spelled[:last] + "ˈ" + spelled[last + 1 :]
        if lower == "a":
            return "ɐ"
        if lower == "an":
            return "ɐn"
        if lower == "i" and normalized == "I":
            return "ˌI"
        if lower == "am" and normalized == "am" and context.future_vowel is not None:
            return "ɐm"
        if lower == "to":
            if context.future_vowel is None:
                return self._lookup_pronunciation("to", None, None, lexicon)
            return "tʊ" if context.future_vowel else "tə"
        if lower == "in":
            return "ɪn"
        if lower == "the":
            return "ði" if context.future_vowel is True else "ðə"
        if lower == "used" and context.future_to:
            return self._lookup_pronunciation("used", "VBD", context.future_vowel, lexicon)
        if lower in {"vs", "vs."}:
            return self._lookup_pronunciation("versus", None, context.future_vowel, lexicon)

        entry = self._lookup_entry(normalized, lexicon)
        if entry:
            tag = self._heuristic_tag(lower, previous_word, next_word, entry)
            pronunciation = entry.resolve(tag, context.future_vowel)
            if pronunciation is not None:
                return self._capital_stress(pronunciation, normalized)
        morphology = self._morphology(lower, context, lexicon, british)
        return self._capital_stress(morphology, normalized) if morphology else None

    def _heuristic_tag(
        self, word: str, previous_word: str | None, next_word: str | None, entry: LexiconEntry
    ) -> str | None:
        previous = previous_word.lower() if previous_word else None
        next_value = next_word.lower() if next_word else None
        if word == "read":
            if previous == "to" or previous in MODALS:
                return "VB"
            if previous in PRONOUNS:
                return "VBP"
        if word == "used" and next_value == "to":
            return "VBD"
        if previous in DETERMINERS:
            if "NOUN" in entry.variants:
                return "NOUN"
            if "NN" in entry.variants:
                return "NN"
            if "ADJ" in entry.variants and next_value is not None:
                return "ADJ"
        verb_context = (
            previous in PRONOUNS or previous in MODALS or previous in AUXILIARIES or
            previous in {"to", "please"} or (previous is None and next_value in DETERMINERS)
        )
        if verb_context:
            for tag in ("VERB", "VBP", "VB"):
                if tag in entry.variants:
                    return tag
        return "DEFAULT" if "DEFAULT" in entry.variants else None

    def _morphology(self, word: str, context: _Context, lexicon: EnglishLexicon, british: bool) -> str | None:
        if len(word) >= 3 and word.endswith("s") and not word.endswith("ss"):
            stems = [word[:-1]]
            if len(word) > 4 and word.endswith("ies"):
                stems.append(word[:-3] + "y")
            if len(word) > 4 and word.endswith("es"):
                stems.append(word[:-2])
            for stem in stems:
                pronunciation = self._lookup_pronunciation(stem, None, context.future_vowel, lexicon)
                if pronunciation:
                    return self._plural(pronunciation, british)
        if len(word) >= 4 and word.endswith("ed"):
            for stem in (word[:-1], word[:-2]):
                pronunciation = self._lookup_pronunciation(stem, "VERB", context.future_vowel, lexicon)
                if pronunciation:
                    return self._past(pronunciation, british)
        if len(word) >= 5 and word.endswith("ing"):
            for stem in (word[:-3], word[:-3] + "e"):
                pronunciation = self._lookup_pronunciation(stem, "VERB", context.future_vowel, lexicon)
                if pronunciation and not (british and pronunciation[-1] in "əː"):
                    return pronunciation + "ɪŋ"
        return None

    @staticmethod
    def _plural(stem: str, british: bool) -> str:
        if stem[-1] in "ptkfθ":
            return stem + "s"
        if stem[-1] in "szʃʒʧʤ":
            return stem + ("ɪ" if british else "ᵻ") + "z"
        return stem + "z"

    @staticmethod
    def _past(stem: str, british: bool) -> str:
        if stem[-1] in "pkfθʃsʧ":
            return stem + "t"
        if stem[-1] in "dt":
            return stem + ("ɪ" if british else "ᵻ") + "d"
        return stem + "d"

    def _number(self, value: str, lexicon: EnglishLexicon, currency: str | None) -> str | None:
        normalized = value.replace(",", "")
        if currency:
            return self._currency_number(normalized, currency, lexicon)
        ordinal = re.fullmatch(r"(\d+)(st|nd|rd|th)", normalized, flags=re.IGNORECASE)
        if ordinal:
            words = self._ordinal_words(int(ordinal.group(1)))
        elif re.fullmatch(r"\d{4}", normalized):
            words = self._year_words(int(normalized))
        elif normalized.isdigit():
            words = self._cardinal_words(int(normalized))
        elif re.fullmatch(r"\d*\.\d+", normalized):
            whole, fraction = normalized.split(".", 1)
            words = (["point"] if not whole else self._cardinal_words(int(whole)) + ["point"])
            words += [SMALL_NUMBERS[int(digit)] for digit in fraction]
        else:
            return None
        return self._words_to_phonemes(words, lexicon)

    def _currency_number(self, value: str, currency: str, lexicon: EnglishLexicon) -> str | None:
        if not re.fullmatch(r"\d+(?:\.\d{1,2})?", value):
            return None
        major_unit, minor_unit = CURRENCY_UNITS[currency]
        parts = value.split(".", 1)
        major = int(parts[0])
        minor = int(parts[1].ljust(2, "0")) if len(parts) > 1 else 0
        words: list[str] = []
        if major > 0 or minor == 0:
            words += self._cardinal_words(major)
            words.append(major_unit if major == 1 else self._plural_unit(major_unit))
        if minor > 0:
            if words:
                words.append("and")
            words += self._cardinal_words(minor)
            words.append(minor_unit if minor == 1 or minor_unit == "pence" else self._plural_unit(minor_unit))
        return self._words_to_phonemes(words, lexicon)

    def _words_to_phonemes(self, words: list[str], lexicon: EnglishLexicon) -> str | None:
        result: list[str] = []
        for word in words:
            pronunciation = self._lookup_pronunciation(word, None, None, lexicon)
            if pronunciation is None:
                return None
            result.append(pronunciation)
        return " ".join(result)

    def _cardinal_words(self, value: int) -> list[str]:
        if value < 20:
            return [SMALL_NUMBERS[value]]
        if value < 100:
            tens = TENS[value // 10]
            return [tens] if value % 10 == 0 else [tens, SMALL_NUMBERS[value % 10]]
        for unit, name in LARGE_UNITS:
            if value >= unit:
                result = self._cardinal_words(value // unit) + [name]
                return result if value % unit == 0 else result + self._cardinal_words(value % unit)
        return []

    def _year_words(self, value: int) -> list[str]:
        if 1000 <= value <= 2999:
            high, low = divmod(value, 100)
            return self._cardinal_words(high) + (["hundred"] if low == 0 else self._cardinal_words(low))
        return self._cardinal_words(value)

    def _ordinal_words(self, value: int) -> list[str]:
        if value in ORDINALS:
            return [ORDINALS[value]]
        words = self._cardinal_words(value)
        if words:
            words[-1] = ORDINAL_WORD_FOR_CARDINAL.get(words[-1], words[-1] + "th")
        return words

    @staticmethod
    def _plural_unit(unit: str) -> str:
        return "pence" if unit == "penny" else unit + "s"

    @staticmethod
    def _capital_stress(phonemes: str, word: str) -> str:
        if word == word.lower() or "ˈ" in phonemes:
            return phonemes
        all_caps = word == word.upper()
        if all_caps and "ˌ" in phonemes:
            return phonemes.replace("ˌ", "ˈ")
        index = next((i for i, value in enumerate(phonemes) if value in VOWELS), -1)
        if index < 0:
            return phonemes
        return phonemes[:index] + ("ˈ" if all_caps else "ˌ") + phonemes[index:]

    @staticmethod
    def _convert_espeak(raw: str, british: bool) -> str:
        phonemes = raw.strip()
        for old, new in ESPEAK_TO_MISAKI:
            phonemes = phonemes.replace(old, new)
        phonemes = re.sub(r"(\S)\u0329", r"ᵊ\1", phonemes).replace("\u0329", "")
        if british:
            phonemes = phonemes.replace("e^ə", "ɛː").replace("e͡ə", "ɛː")
            phonemes = phonemes.replace("iə", "ɪə").replace("ə^ʊ", "Q").replace("ə͡ʊ", "Q")
        else:
            phonemes = phonemes.replace("o^ʊ", "O").replace("o͡ʊ", "O")
            phonemes = phonemes.replace("ɜːɹ", "ɜɹ").replace("ɜː", "ɜɹ")
            phonemes = phonemes.replace("ɪə", "iə").replace("ː", "")
        return phonemes.replace("o", "ɔ").replace("ɾ", "T").replace("ʔ", "t").replace("^", "").replace("͡", "")

    @staticmethod
    def _update_context(current: _Context, phonemes: str, token: _Token) -> _Context:
        vowel = current.future_vowel
        for character in phonemes:
            if character in NON_QUOTE_PUNCTUATION:
                vowel = None
                break
            if character in VOWELS:
                vowel = True
                break
            if character in CONSONANTS:
                vowel = False
                break
        return _Context(vowel, token.kind == "word" and token.text.lower() == "to")

    @staticmethod
    def _previous_word(tokens: list[_Token], index: int) -> str | None:
        return next((tokens[i].text for i in range(index - 1, -1, -1) if tokens[i].kind == "word"), None)

    @staticmethod
    def _next_word(tokens: list[_Token], index: int) -> str | None:
        return next((tokens[i].text for i in range(index + 1, len(tokens)) if tokens[i].kind == "word"), None)

    @staticmethod
    def _next_token(tokens: list[_Token], index: int, kind: str) -> bool:
        return index + 1 < len(tokens) and tokens[index + 1].kind == kind

    def _tokenize(self, text: str) -> list[_Token]:
        source = text.lstrip()
        result: list[_Token] = []
        index = 0
        while index < len(source):
            if source[index].isspace():
                index += 1
                continue
            start = index
            if source[index].isalpha() or source[index] in APOSTROPHES:
                index += 1
                while index < len(source) and (source[index].isalpha() or source[index] in APOSTROPHES):
                    index += 1
                kind = "word"
            elif source[index].isdigit():
                index += 1
                while index < len(source):
                    separator = source[index] in ",." and index + 1 < len(source) and source[index + 1].isdigit()
                    if not source[index].isdigit() and not separator:
                        break
                    index += 1
                suffix_start = index
                while index < len(source) and source[index].isalpha():
                    index += 1
                if index - suffix_start not in {0, 2, 3}:
                    index = suffix_start
                kind = "number"
            elif source[index] in PUNCTUATION or source[index] in "-–":
                index += 1
                kind = "punctuation"
            else:
                index += 1
                kind = "symbol"
            token_text = source[start:index]
            whitespace_start = index
            while index < len(source) and source[index].isspace():
                index += 1
            result.append(_Token(token_text, source[whitespace_start:index], kind))
        return self._merge_abbreviations(result)

    @staticmethod
    def _merge_abbreviations(tokens: list[_Token]) -> list[_Token]:
        result: list[_Token] = []
        index = 0
        while index < len(tokens):
            current = tokens[index]
            if (
                current.kind == "word" and not current.whitespace and current.text in TITLES and
                index + 1 < len(tokens) and tokens[index + 1].kind == "punctuation" and tokens[index + 1].text == "."
            ):
                period = tokens[index + 1]
                result.append(_Token(current.text + ".", period.whitespace, "word"))
                index += 2
                continue
            if (
                current.kind == "word" and len(current.text) == 1 and not current.whitespace and
                index + 1 < len(tokens) and tokens[index + 1].kind == "punctuation" and
                tokens[index + 1].text == "." and not tokens[index + 1].whitespace
            ):
                cursor = index
                text: list[str] = []
                whitespace = ""
                while (
                    cursor + 1 < len(tokens) and tokens[cursor].kind == "word" and
                    len(tokens[cursor].text) == 1 and not tokens[cursor].whitespace and
                    tokens[cursor + 1].kind == "punctuation" and tokens[cursor + 1].text == "."
                ):
                    text.extend((tokens[cursor].text, "."))
                    whitespace = tokens[cursor + 1].whitespace
                    cursor += 2
                    if whitespace:
                        break
                if len(text) >= 4:
                    result.append(_Token("".join(text), whitespace, "word"))
                    index = cursor
                    continue
            result.append(current)
            index += 1
        return result
