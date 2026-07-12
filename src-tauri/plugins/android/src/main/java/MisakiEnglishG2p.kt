package com.folio.reader.mobile

import android.content.Context
import android.util.Log
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.zip.GZIPInputStream

internal data class MisakiG2pTelemetry(
    val strategy: String,
    val dialect: String,
    val fallbackWords: List<String>,
) {
    val fallbackCount: Int get() = fallbackWords.size
}

internal data class MisakiG2pResult(
    val phonemes: String,
    val telemetry: MisakiG2pTelemetry,
)

internal data class MisakiG2pReadiness(
    val ready: Boolean,
    val error: String? = null,
)

internal data class MisakiLexiconEntry(
    val rating: Int,
    val value: String?,
    val variants: Map<String, String?>,
) {
    fun resolve(tag: String?, futureVowel: Boolean?): String? {
        value?.let { return it }
        if (futureVowel == null && variants.containsKey("None")) return variants["None"]
        if (tag != null && variants.containsKey(tag)) return variants[tag]
        val parent = when {
            tag == null -> null
            tag.startsWith("VB") -> "VERB"
            tag.startsWith("NN") -> "NOUN"
            tag.startsWith("RB") || tag.startsWith("ADV") -> "ADV"
            tag.startsWith("JJ") || tag.startsWith("ADJ") -> "ADJ"
            else -> tag
        }
        if (parent != null && variants.containsKey(parent)) return variants[parent]
        return variants["DEFAULT"]
    }
}

/** A compact, line-indexed view of the pinned Misaki dictionaries. */
internal class MisakiEnglishLexicon private constructor(
    private val data: ByteArray,
    private val starts: IntArray,
    val dialect: String,
) {
    fun lookup(word: String): MisakiLexiconEntry? {
        var low = 0
        var high = starts.size - 1
        while (low <= high) {
            val middle = (low + high).ushr(1)
            val start = starts[middle]
            val keyEnd = indexOf(TAB, start)
            if (keyEnd < 0) throw IllegalStateException("Misaki lexicon record is malformed")
            val key = String(data, start, keyEnd - start, StandardCharsets.UTF_8)
            val comparison = key.compareTo(word)
            when {
                comparison < 0 -> low = middle + 1
                comparison > 0 -> high = middle - 1
                else -> return decodeRecord(start)
            }
        }
        return null
    }

    private fun decodeRecord(start: Int): MisakiLexiconEntry {
        val end = indexOf(NEWLINE, start).let { if (it < 0) data.size else it }
        val fields = String(data, start, end - start, StandardCharsets.UTF_8).split('\t')
        if (fields.size < 4) throw IllegalStateException("Misaki lexicon record is truncated")
        val rating = fields[1].toIntOrNull()
            ?: throw IllegalStateException("Misaki lexicon record has an invalid rating")
        return when (fields[2]) {
            "S" -> MisakiLexiconEntry(rating, unescape(fields[3]), emptyMap())
            "M" -> {
                val variants = linkedMapOf<String, String?>()
                fields.drop(3).forEach { field ->
                    val separator = field.indexOf('=')
                    if (separator <= 0) throw IllegalStateException("Misaki lexicon variant is malformed")
                    val tag = unescape(field.substring(0, separator))
                    val encoded = field.substring(separator + 1)
                    variants[tag] = if (encoded == "~") null else unescape(encoded)
                }
                if (!variants.containsKey("DEFAULT")) {
                    throw IllegalStateException("Misaki lexicon variant is missing DEFAULT")
                }
                MisakiLexiconEntry(rating, null, variants)
            }
            else -> throw IllegalStateException("Misaki lexicon record uses an unknown value kind")
        }
    }

    private fun indexOf(value: Byte, start: Int): Int {
        for (index in start until data.size) if (data[index] == value) return index
        return -1
    }

    companion object {
        fun load(input: InputStream, expectedDialect: String): MisakiEnglishLexicon {
            val buffered = if (input is BufferedInputStream) input else BufferedInputStream(input)
            buffered.mark(2)
            val first = buffered.read()
            val second = buffered.read()
            buffered.reset()
            // Android's asset packager transparently expands *.gz inputs and
            // removes the suffix. JVM/backend resources retain the gzip bytes.
            val decoded = if (first == 0x1f && second == 0x8b) GZIPInputStream(buffered) else buffered
            val raw = decoded.use { compressed ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = compressed.read(buffer)
                    if (count < 0) break
                    if (count == 0) continue
                    if (output.size() + count > MAX_UNCOMPRESSED_BYTES) {
                        throw IllegalStateException("Misaki lexicon is unexpectedly large")
                    }
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            val headerEnd = raw.indexOf(NEWLINE)
            if (headerEnd <= 0) throw IllegalStateException("Misaki lexicon header is missing")
            val header = String(raw, 0, headerEnd, StandardCharsets.UTF_8).split('\t')
            if (
                header.size != 5 || header[0] != MAGIC || header[1] != FORMAT_VERSION ||
                header[2] != REVISION || header[3] != expectedDialect
            ) {
                throw IllegalStateException("Misaki lexicon revision or dialect is incompatible")
            }
            val expectedCount = header[4].toIntOrNull()
                ?: throw IllegalStateException("Misaki lexicon entry count is invalid")
            val offsets = IntArray(expectedCount)
            var count = 0
            var start = headerEnd + 1
            while (start < raw.size) {
                if (raw[start] != NEWLINE) {
                    if (count >= offsets.size) throw IllegalStateException("Misaki lexicon has extra records")
                    offsets[count++] = start
                }
                var end = start
                while (end < raw.size && raw[end] != NEWLINE) end++
                if (end < 0) break
                start = end + 1
            }
            if (count != expectedCount) throw IllegalStateException("Misaki lexicon is truncated")
            return MisakiEnglishLexicon(raw, offsets, expectedDialect)
        }

        private fun unescape(value: String): String {
            if ('\\' !in value) return value
            val result = StringBuilder(value.length)
            var index = 0
            while (index < value.length) {
                val character = value[index++]
                if (character != '\\' || index >= value.length) {
                    result.append(character)
                    continue
                }
                result.append(
                    when (val escaped = value[index++]) {
                        't' -> '\t'
                        'r' -> '\r'
                        'n' -> '\n'
                        '\\' -> '\\'
                        else -> escaped
                    },
                )
            }
            return result.toString()
        }

        private const val MAGIC = "FOLIO-MISAKI-LEXICON"
        private const val FORMAT_VERSION = "1"
        const val REVISION = "fba1236595f2d2bf21d414ba6e57d25256afada3"
        const val STRATEGY = "misaki-en@$REVISION + espeak-ng-ood"
        private const val MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
        private const val TAB: Byte = 9
        private const val NEWLINE: Byte = 10
    }
}

/**
 * Lightweight English G2P for Kokoro. Misaki's pinned lexicons and context
 * rules are primary; eSpeak NG is invoked only for words outside the lexicon.
 */
internal class MisakiEnglishG2p internal constructor(
    private val assetLoader: (String) -> InputStream,
    private val espeakFallback: (String, String) -> String,
) {
    constructor(context: Context, phonemizer: EspeakPhonemizer) : this(
        assetLoader = { path ->
            val assets = context.applicationContext.assets
            try {
                assets.open(path)
            } catch (error: java.io.IOException) {
                if (!path.endsWith(".gz")) throw error
                assets.open(path.removeSuffix(".gz"))
            }
        },
        espeakFallback = phonemizer::phonemize,
    )

    private data class Token(
        val text: String,
        val whitespace: String,
        val kind: Kind,
        var phonemes: String? = null,
    )

    private enum class Kind { WORD, NUMBER, PUNCTUATION, SYMBOL }

    private data class G2pContext(val futureVowel: Boolean? = null, val futureTo: Boolean = false)

    private val lexicons = mutableMapOf<String, MisakiEnglishLexicon>()

    @Volatile
    private var lastTelemetry = MisakiG2pTelemetry(MisakiEnglishLexicon.STRATEGY, "us", emptyList())

    fun telemetry(): MisakiG2pTelemetry = lastTelemetry

    fun readiness(): MisakiG2pReadiness = try {
        for (dialect in listOf("us", "gb")) {
            val lexicon = lexicon(dialect)
            if (lexicon.lookup("hello") == null || lexicon.lookup("folio") == null) {
                throw IllegalStateException("Misaki $dialect lexicon is missing its smoke-test entries")
            }
        }
        MisakiG2pReadiness(true)
    } catch (error: Throwable) {
        MisakiG2pReadiness(false, error.message?.take(240) ?: "Misaki English G2P assets are unavailable")
    }

    fun phonemize(text: String, british: Boolean): MisakiG2pResult {
        val dialect = if (british) "gb" else "us"
        val language = if (british) "en-gb" else "en-us"
        val lexicon = lexicon(dialect)
        val tokens = tokenize(text)
        if (tokens.isEmpty()) throw IllegalArgumentException("Text is required for phonemization")
        val fallbackWords = mutableListOf<String>()
        var context = G2pContext()
        for (index in tokens.indices.reversed()) {
            val token = tokens[index]
            val previousWord = previousWord(tokens, index)
            val nextWord = nextWord(tokens, index)
            token.phonemes = when (token.kind) {
                Kind.PUNCTUATION -> punctuation(token.text)
                Kind.SYMBOL -> if (token.text in CURRENCY_UNITS && nextToken(tokens, index)?.kind == Kind.NUMBER) {
                    ""
                } else {
                    symbol(token.text, lexicon)
                }
                Kind.NUMBER -> number(
                    token.text,
                    lexicon,
                    previousToken(tokens, index)?.text?.takeIf { it in CURRENCY_UNITS },
                )
                Kind.WORD -> word(token.text, previousWord, nextWord, context, lexicon, british)
                    ?: run {
                        fallbackWords += token.text
                        convertEspeak(espeakFallback(token.text, language), british)
                    }
            }
            context = updateContext(context, token.phonemes.orEmpty(), token)
        }
        val phonemes = buildString {
            tokens.forEach { token ->
                append(token.phonemes.orEmpty())
                append(token.whitespace)
            }
        }.trimEnd().replace('ɾ', 'T').replace('ʔ', 't')
        if (phonemes.isBlank()) throw IllegalStateException("Misaki phonemization produced no usable text")
        val telemetry = MisakiG2pTelemetry(MisakiEnglishLexicon.STRATEGY, dialect, fallbackWords.toList())
        lastTelemetry = telemetry
        if (fallbackWords.isNotEmpty()) {
            runCatching {
                Log.i(TAG, "Misaki $dialect used eSpeak NG fallback for ${fallbackWords.size} word(s): ${fallbackWords.joinToString()}")
            }
        }
        return MisakiG2pResult(phonemes, telemetry)
    }

    private fun lexicon(dialect: String): MisakiEnglishLexicon = synchronized(lexicons) {
        lexicons.getOrPut(dialect) {
            assetLoader("misaki-en/$dialect.lex.gz").use { MisakiEnglishLexicon.load(it, dialect) }
        }
    }

    private fun word(
        original: String,
        previousWord: String?,
        nextWord: String?,
        context: G2pContext,
        lexicon: MisakiEnglishLexicon,
        british: Boolean,
    ): String? {
        val normalized = original.replace('‘', '\'').replace('’', '\'')
        val lower = normalized.lowercase(Locale.US)
        if ('.' in normalized.trim('.') && normalized.split('.').filter(String::isNotEmpty).all { it.length < 3 }) {
            val letters = normalized.filter(Char::isLetter)
            val spelled = buildString {
                letters.forEach { letter ->
                    append(lookupPronunciation(letter.uppercaseChar().toString(), null, null, lexicon) ?: return null)
                }
            }.replace('ˈ', 'ˌ')
            val lastStress = spelled.lastIndexOf('ˌ')
            return if (lastStress < 0) spelled else spelled.substring(0, lastStress) + 'ˈ' + spelled.substring(lastStress + 1)
        }
        when (lower) {
            "a" -> return "ɐ"
            "an" -> return "ɐn"
            "i" -> if (normalized == "I") return "ˌI"
            "am" -> if (normalized == "am" && context.futureVowel != null) return "ɐm"
            "to" -> return when (context.futureVowel) {
                null -> lookupPronunciation("to", null, null, lexicon)
                true -> "tʊ"
                false -> "tə"
            }
            "in" -> return "ɪn"
            "the" -> return if (context.futureVowel == true) "ði" else "ðə"
            "used" -> if (context.futureTo) {
                return lookupPronunciation("used", "VBD", context.futureVowel, lexicon)
            }
            "vs", "vs." -> return lookupPronunciation("versus", null, context.futureVowel, lexicon)
        }

        val entry = lookupEntry(normalized, lexicon)
        if (entry != null) {
            val tag = heuristicTag(lower, previousWord, nextWord, entry)
            val pronunciation = entry.resolve(tag, context.futureVowel)
            if (pronunciation != null) return applyCapitalStress(pronunciation, normalized)
        }
        return morphology(lower, context, lexicon, british)?.let { applyCapitalStress(it, normalized) }
    }

    private fun lookupEntry(word: String, lexicon: MisakiEnglishLexicon): MisakiLexiconEntry? =
        lexicon.lookup(word) ?: lexicon.lookup(word.lowercase(Locale.US))

    private fun lookupPronunciation(
        word: String,
        tag: String?,
        futureVowel: Boolean?,
        lexicon: MisakiEnglishLexicon,
    ): String? = lookupEntry(word, lexicon)?.resolve(tag, futureVowel)

    private fun heuristicTag(
        word: String,
        previousWord: String?,
        nextWord: String?,
        entry: MisakiLexiconEntry,
    ): String? {
        val previous = previousWord?.lowercase(Locale.US)
        val next = nextWord?.lowercase(Locale.US)
        if (word == "read") {
            if (previous == "to" || previous in MODALS) return "VB"
            if (previous in PRONOUNS) return "VBP"
        }
        if (word == "used" && next == "to") return "VBD"
        if (previous in DETERMINERS) {
            if (entry.variants.containsKey("NOUN")) return "NOUN"
            if (entry.variants.containsKey("NN")) return "NN"
            if (entry.variants.containsKey("ADJ") && next != null) return "ADJ"
        }
        val verbContext = previous in PRONOUNS || previous in MODALS || previous in AUXILIARIES ||
            previous == "to" || previous == "please" || previous == null && next in DETERMINERS
        if (verbContext) {
            for (tag in listOf("VERB", "VBP", "VB")) if (entry.variants.containsKey(tag)) return tag
        }
        if (entry.variants.containsKey("DEFAULT")) return "DEFAULT"
        return null
    }

    private fun morphology(
        word: String,
        context: G2pContext,
        lexicon: MisakiEnglishLexicon,
        british: Boolean,
    ): String? {
        if (word.length >= 3 && word.endsWith('s') && !word.endsWith("ss")) {
            val candidates = buildList {
                add(word.dropLast(1))
                if (word.endsWith("ies") && word.length > 4) add(word.dropLast(3) + "y")
                if (word.endsWith("es") && word.length > 4) add(word.dropLast(2))
            }
            candidates.forEach { stem ->
                lookupPronunciation(stem, null, context.futureVowel, lexicon)?.let { return plural(it, british) }
            }
        }
        if (word.length >= 4 && word.endsWith("ed")) {
            listOf(word.dropLast(1), word.dropLast(2)).forEach { stem ->
                lookupPronunciation(stem, "VERB", context.futureVowel, lexicon)?.let { return past(it, british) }
            }
        }
        if (word.length >= 5 && word.endsWith("ing")) {
            listOf(word.dropLast(3), word.dropLast(3) + "e").forEach { stem ->
                lookupPronunciation(stem, "VERB", context.futureVowel, lexicon)?.let { return gerund(it, british) }
            }
        }
        return null
    }

    private fun plural(stem: String, british: Boolean): String {
        if (stem.isEmpty()) return stem
        return when (stem.last()) {
            in "ptkfθ" -> stem + "s"
            in "szʃʒʧʤ" -> stem + (if (british) "ɪ" else "ᵻ") + "z"
            else -> stem + "z"
        }
    }

    private fun past(stem: String, british: Boolean): String {
        if (stem.isEmpty()) return stem
        return when (stem.last()) {
            in "pkfθʃsʧ" -> stem + "t"
            'd', 't' -> stem + (if (british) "ɪ" else "ᵻ") + "d"
            else -> stem + "d"
        }
    }

    private fun gerund(stem: String, british: Boolean): String? {
        if (stem.isEmpty() || british && stem.last() in "əː") return null
        return stem + "ɪŋ"
    }

    private fun number(value: String, lexicon: MisakiEnglishLexicon, currency: String?): String? {
        val normalized = value.replace(",", "")
        if (currency != null) return currencyNumber(normalized, currency, lexicon)
        val ordinal = Regex("^(\\d+)(st|nd|rd|th)$", RegexOption.IGNORE_CASE).matchEntire(normalized)
        val words = when {
            ordinal != null -> ordinalWords(ordinal.groupValues[1].toLongOrNull() ?: return null)
            normalized.matches(Regex("\\d{4}")) -> yearWords(normalized.toInt())
            normalized.matches(Regex("\\d+")) -> cardinalWords(normalized.toLong())
            normalized.matches(Regex("\\d*\\.\\d+")) -> {
                val parts = normalized.split('.', limit = 2)
                val prefix = if (parts[0].isEmpty()) listOf("point") else cardinalWords(parts[0].toLong()) + "point"
                prefix + parts[1].map { DIGIT_WORDS[it - '0'] }
            }
            else -> return null
        }
        val pronunciations = mutableListOf<String>()
        words.forEach { word ->
            val pronunciation = lookupPronunciation(word, null, null, lexicon) ?: return null
            pronunciations += pronunciation
        }
        return pronunciations.joinToString(" ")
    }

    private fun currencyNumber(value: String, currency: String, lexicon: MisakiEnglishLexicon): String? {
        if (!value.matches(Regex("\\d+(?:\\.\\d{1,2})?"))) return null
        val (majorUnit, minorUnit) = CURRENCY_UNITS[currency] ?: return null
        val pieces = value.split('.', limit = 2)
        val major = pieces[0].toLongOrNull() ?: return null
        val minor = pieces.getOrNull(1)?.padEnd(2, '0')?.toLongOrNull() ?: 0L
        val words = mutableListOf<String>()
        if (major > 0 || minor == 0L) {
            words += cardinalWords(major)
            words += if (major == 1L) majorUnit else pluralUnit(majorUnit)
        }
        if (minor > 0) {
            if (words.isNotEmpty()) words += "and"
            words += cardinalWords(minor)
            words += if (minor == 1L || minorUnit == "pence") minorUnit else pluralUnit(minorUnit)
        }
        val pronunciations = mutableListOf<String>()
        words.forEach { word ->
            pronunciations += lookupPronunciation(word, null, null, lexicon) ?: return null
        }
        return pronunciations.joinToString(" ")
    }

    private fun pluralUnit(unit: String): String = when (unit) {
        "penny" -> "pence"
        else -> unit + "s"
    }

    private fun cardinalWords(value: Long): List<String> {
        require(value >= 0)
        if (value < 20) return listOf(SMALL_NUMBERS[value.toInt()])
        if (value < 100) {
            val tens = TENS[(value / 10).toInt()]
            return if (value % 10 == 0L) listOf(tens) else listOf(tens, SMALL_NUMBERS[(value % 10).toInt()])
        }
        for ((unit, name) in LARGE_UNITS) {
            if (value >= unit) {
                val result = cardinalWords(value / unit) + name
                return if (value % unit == 0L) result else result + cardinalWords(value % unit)
            }
        }
        return emptyList()
    }

    private fun yearWords(value: Int): List<String> {
        if (value in 1000..2999) {
            val high = value / 100
            val low = value % 100
            return cardinalWords(high.toLong()) + if (low == 0) listOf("hundred") else cardinalWords(low.toLong())
        }
        return cardinalWords(value.toLong())
    }

    private fun ordinalWords(value: Long): List<String> {
        val direct = ORDINALS[value]
        if (direct != null) return listOf(direct)
        val cardinal = cardinalWords(value).toMutableList()
        if (cardinal.isEmpty()) return cardinal
        cardinal[cardinal.lastIndex] = ORDINAL_WORD_FOR_CARDINAL[cardinal.last()] ?: cardinal.last() + "th"
        return cardinal
    }

    private fun symbol(value: String, lexicon: MisakiEnglishLexicon): String? =
        SYMBOL_WORDS[value]?.let { lookupPronunciation(it, null, null, lexicon) }

    private fun punctuation(value: String): String = when (value) {
        "-", "–" -> "—"
        else -> value.filter { it in PUNCTUATION }
    }

    private fun updateContext(current: G2pContext, phonemes: String, token: Token): G2pContext {
        var vowel = current.futureVowel
        for (character in phonemes) {
            when {
                character in NON_QUOTE_PUNCTUATION -> {
                    vowel = null
                    break
                }
                character in VOWELS -> {
                    vowel = true
                    break
                }
                character in CONSONANTS -> {
                    vowel = false
                    break
                }
            }
        }
        return G2pContext(vowel, token.kind == Kind.WORD && token.text.equals("to", ignoreCase = true))
    }

    private fun applyCapitalStress(phonemes: String, word: String): String {
        if (word == word.lowercase(Locale.US)) return phonemes
        val stress = if (word == word.uppercase(Locale.US)) 2.0 else 0.5
        if ('ˈ' in phonemes) return phonemes
        if (stress >= 1 && 'ˌ' in phonemes) return phonemes.replace('ˌ', 'ˈ')
        if (phonemes.none { it in VOWELS }) return phonemes
        val index = phonemes.indexOfFirst { it in VOWELS }
        val marker = if (stress > 1) 'ˈ' else 'ˌ'
        return phonemes.substring(0, index) + marker + phonemes.substring(index)
    }

    private fun convertEspeak(raw: String, british: Boolean): String {
        var phonemes = raw.trim()
        ESPEAK_TO_MISAKI.forEach { (old, new) -> phonemes = phonemes.replace(old, new) }
        phonemes = Regex("(\\S)\\u0329").replace(phonemes) { "ᵊ${it.groupValues[1]}" }
            .replace("\u0329", "")
        phonemes = if (british) {
            phonemes.replace("e^ə", "ɛː").replace("e͡ə", "ɛː")
                .replace("iə", "ɪə").replace("ə^ʊ", "Q").replace("ə͡ʊ", "Q")
        } else {
            phonemes.replace("o^ʊ", "O").replace("o͡ʊ", "O")
                .replace("ɜːɹ", "ɜɹ").replace("ɜː", "ɜɹ")
                .replace("ɪə", "iə").replace("ː", "")
        }
        return phonemes.replace('o', 'ɔ').replace('ɾ', 'T').replace('ʔ', 't')
            .replace("^", "").replace("͡", "")
    }

    private fun previousWord(tokens: List<Token>, index: Int): String? =
        (index - 1 downTo 0).firstNotNullOfOrNull { candidate ->
            tokens[candidate].text.takeIf { tokens[candidate].kind == Kind.WORD }
        }

    private fun nextWord(tokens: List<Token>, index: Int): String? =
        (index + 1 until tokens.size).firstNotNullOfOrNull { candidate ->
            tokens[candidate].text.takeIf { tokens[candidate].kind == Kind.WORD }
        }

    private fun previousToken(tokens: List<Token>, index: Int): Token? = tokens.getOrNull(index - 1)

    private fun nextToken(tokens: List<Token>, index: Int): Token? = tokens.getOrNull(index + 1)

    private fun tokenize(text: String): List<Token> {
        val source = text.trimStart()
        val result = mutableListOf<Token>()
        var index = 0
        while (index < source.length) {
            if (source[index].isWhitespace()) {
                index++
                continue
            }
            val start = index
            val kind = when {
                source[index].isLetter() || source[index] in APOSTROPHES -> {
                    index++
                    while (index < source.length && (source[index].isLetter() || source[index] in APOSTROPHES)) index++
                    Kind.WORD
                }
                source[index].isDigit() -> {
                    index++
                    while (index < source.length) {
                        val character = source[index]
                        val numericSeparator = character in ",." && index + 1 < source.length && source[index + 1].isDigit()
                        if (!character.isDigit() && !numericSeparator) break
                        index++
                    }
                    val suffixStart = index
                    while (index < source.length && source[index].isLetter()) index++
                    if (index - suffixStart !in setOf(0, 2, 3)) index = suffixStart
                    Kind.NUMBER
                }
                source[index] in PUNCTUATION || source[index] in "-–" -> {
                    index++
                    Kind.PUNCTUATION
                }
                else -> {
                    index++
                    Kind.SYMBOL
                }
            }
            val tokenText = source.substring(start, index)
            val whitespaceStart = index
            while (index < source.length && source[index].isWhitespace()) index++
            result += Token(tokenText, source.substring(whitespaceStart, index), kind)
        }
        return mergeAbbreviations(result)
    }

    private fun mergeAbbreviations(tokens: List<Token>): List<Token> {
        val result = mutableListOf<Token>()
        var index = 0
        while (index < tokens.size) {
            val current = tokens[index]
            if (
                current.kind == Kind.WORD && current.whitespace.isEmpty() && current.text in TITLES &&
                tokens.getOrNull(index + 1)?.let { it.kind == Kind.PUNCTUATION && it.text == "." } == true
            ) {
                val period = tokens[index + 1]
                result += Token(current.text + ".", period.whitespace, Kind.WORD)
                index += 2
                continue
            }
            if (
                current.kind == Kind.WORD && current.text.length == 1 && current.whitespace.isEmpty() &&
                tokens.getOrNull(index + 1)?.let { it.kind == Kind.PUNCTUATION && it.text == "." && it.whitespace.isEmpty() } == true
            ) {
                var cursor = index
                val text = StringBuilder()
                var whitespace = ""
                var pairs = 0
                while (
                    cursor + 1 < tokens.size && tokens[cursor].kind == Kind.WORD &&
                    tokens[cursor].text.length == 1 && tokens[cursor].whitespace.isEmpty() &&
                    tokens[cursor + 1].kind == Kind.PUNCTUATION && tokens[cursor + 1].text == "."
                ) {
                    text.append(tokens[cursor].text).append('.')
                    whitespace = tokens[cursor + 1].whitespace
                    pairs++
                    cursor += 2
                    if (whitespace.isNotEmpty()) break
                }
                if (pairs >= 2) {
                    result += Token(text.toString(), whitespace, Kind.WORD)
                    index = cursor
                    continue
                }
            }
            result += current
            index++
        }
        return result
    }

    companion object {
        private const val TAG = "FolioMisaki"
        private const val PUNCTUATION = ";:,.!?—…\"“”()"
        private const val NON_QUOTE_PUNCTUATION = ";:,.!?—…"
        private const val APOSTROPHES = "'‘’"
        private const val VOWELS = "AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ"
        private const val CONSONANTS = "bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ"

        private val PRONOUNS = setOf("i", "you", "we", "they", "he", "she", "it")
        private val DETERMINERS = setOf("a", "an", "the", "this", "that", "these", "those", "my", "your", "his", "her", "our", "their")
        private val MODALS = setOf("can", "could", "may", "might", "must", "shall", "should", "will", "would")
        private val AUXILIARIES = setOf("do", "does", "did", "have", "has", "had", "am", "are", "is", "was", "were")
        private val SYMBOL_WORDS = mapOf("%" to "percent", "&" to "and", "+" to "plus", "@" to "at", "/" to "slash", "." to "dot")
        private val CURRENCY_UNITS = mapOf("$" to ("dollar" to "cent"), "£" to ("pound" to "pence"), "€" to ("euro" to "cent"))
        private val TITLES = setOf("Dr", "Mr", "Mrs", "Ms", "Prof", "Sr", "Jr", "St")
        private val SMALL_NUMBERS = listOf(
            "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
            "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
        )
        private val DIGIT_WORDS = SMALL_NUMBERS.take(10)
        private val TENS = listOf("", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety")
        private val LARGE_UNITS = listOf(1_000_000_000L to "billion", 1_000_000L to "million", 1_000L to "thousand", 100L to "hundred")
        private val ORDINALS = mapOf(
            1L to "first", 2L to "second", 3L to "third", 4L to "fourth", 5L to "fifth",
            6L to "sixth", 7L to "seventh", 8L to "eighth", 9L to "ninth", 10L to "tenth",
            11L to "eleventh", 12L to "twelfth", 13L to "thirteenth", 20L to "twentieth",
        )
        private val ORDINAL_WORD_FOR_CARDINAL = mapOf(
            "one" to "first", "two" to "second", "three" to "third", "four" to "fourth",
            "five" to "fifth", "six" to "sixth", "seven" to "seventh", "eight" to "eighth",
            "nine" to "ninth", "ten" to "tenth", "twelve" to "twelfth", "twenty" to "twentieth",
            "thirty" to "thirtieth", "forty" to "fortieth", "fifty" to "fiftieth",
        )
        private val ESPEAK_TO_MISAKI = listOf(
            "ʔˌn̩" to "ʔn", "ʔn̩" to "ʔn", "a^ɪ" to "I", "a͡ɪ" to "I", "aɪ" to "I",
            "a^ʊ" to "W", "a͡ʊ" to "W", "aʊ" to "W", "d^ʒ" to "ʤ", "d͡ʒ" to "ʤ", "dʒ" to "ʤ",
            "e^ɪ" to "A", "e͡ɪ" to "A", "eɪ" to "A", "t^ʃ" to "ʧ", "t͡ʃ" to "ʧ", "tʃ" to "ʧ",
            "ɔ^ɪ" to "Y", "ɔ͡ɪ" to "Y", "ɔɪ" to "Y", "ə^l" to "ᵊl", "ə͡l" to "ᵊl",
            "ʲo" to "jo", "ʲə" to "jə", "ʲ" to "", "ɚ" to "əɹ", "r" to "ɹ", "x" to "k",
            "ç" to "k", "ɐ" to "ə", "ɬ" to "l", "̃" to "", "e" to "A",
        ).sortedByDescending { it.first.length }
    }
}
