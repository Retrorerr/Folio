package com.folio.reader.mobile

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.charset.StandardCharsets
import java.util.LinkedHashMap
import java.util.zip.ZipFile
import kotlin.math.pow
import kotlin.math.sqrt

internal object KokoroSupport {
    private val VOICE_PATTERN = Regex("^[a-z]{2}_[a-z0-9_]{1,48}$")

    fun requireVoice(value: String): String {
        val voice = value.ifBlank { "af_heart" }
        if (!VOICE_PATTERN.matches(voice)) throw IllegalArgumentException("Invalid Kokoro voice: $value")
        return voice
    }

    fun languageForVoice(voice: String): String =
        if (requireVoice(voice).startsWith("b")) "en-gb" else "en-us"

    /** Mirrors kokoro_onnx's default 60 dB, 2048/512 frame trim. */
    fun trimSilence(
        samples: FloatArray,
        topDb: Double = 60.0,
        frameLength: Int = 2_048,
        hopLength: Int = 512,
    ): FloatArray {
        if (samples.isEmpty()) return samples
        require(topDb >= 0.0 && frameLength > 0 && hopLength > 0)
        val frameCount = 1 + samples.size / hopLength
        val rms = DoubleArray(frameCount)
        var peak = 0.0
        for (frameIndex in 0 until frameCount) {
            val centeredStart = frameIndex * hopLength - frameLength / 2
            var sum = 0.0
            for (offset in 0 until frameLength) {
                val sampleIndex = centeredStart + offset
                if (sampleIndex in samples.indices) {
                    val value = samples[sampleIndex].toDouble()
                    sum += value * value
                }
            }
            val value = sqrt(sum / frameLength)
            rms[frameIndex] = value
            if (value > peak) peak = value
        }
        if (peak <= 0.0) return samples
        val threshold = peak * 10.0.pow(-topDb / 20.0)
        val first = rms.indexOfFirst { it > threshold }
        val last = rms.indexOfLast { it > threshold }
        if (first < 0 || last < first) return samples
        val start = (first * hopLength).coerceIn(0, samples.size)
        val end = ((last + 1) * hopLength).coerceIn(start, samples.size)
        return if (start == 0 && end == samples.size) samples else samples.copyOfRange(start, end)
    }
}

internal data class NpyFloatLayout(val dataOffset: Int, val rows: Int, val rowWidth: Int)

internal object KokoroModelAssets {
    val requiredVoices = listOf("af_heart", "af_bella", "af_nicole", "bf_emma", "af_sarah", "af_aoede")

    fun validate(root: File) {
        val archiveFile = File(root, "voices-v1.0.bin")
        ZipFile(archiveFile).use { archive ->
            requiredVoices.forEach { voice -> parseNpy(readVoice(archive, voice)) }
        }
    }

    fun readVoice(root: File, voice: String): ByteArray =
        ZipFile(File(root, "voices-v1.0.bin")).use { readVoice(it, voice) }

    fun parseNpy(bytes: ByteArray): NpyFloatLayout {
        if (bytes.size < 12 || !bytes.copyOfRange(0, NPY_MAGIC.size).contentEquals(NPY_MAGIC)) {
            throw IllegalStateException("Kokoro voice entry has an invalid NPY header")
        }
        val major = bytes[6].toInt() and 0xff
        val minor = bytes[7].toInt() and 0xff
        if (minor != 0 || major !in 1..3) throw IllegalStateException("Unsupported Kokoro NPY version $major.$minor")
        val headerLength: Int
        val headerOffset: Int
        if (major == 1) {
            headerLength = unsignedShort(bytes, 8)
            headerOffset = 10
        } else {
            val value = unsignedInt(bytes, 8)
            if (value > Int.MAX_VALUE) throw IllegalStateException("Kokoro NPY header is too large")
            headerLength = value.toInt()
            headerOffset = 12
        }
        val dataOffset = Math.addExact(headerOffset, headerLength)
        if (headerLength <= 0 || dataOffset > bytes.size) {
            throw IllegalStateException("Kokoro voice entry has a truncated NPY header")
        }
        val charset = if (major == 3) StandardCharsets.UTF_8 else StandardCharsets.US_ASCII
        val header = String(bytes, headerOffset, headerLength, charset)
        val descriptor = Regex("['\"]descr['\"]\\s*:\\s*['\"]([^'\"]+)['\"]")
            .find(header)?.groupValues?.get(1)
        if (descriptor != "<f4") throw IllegalStateException("Kokoro voice entry must contain little-endian float32 data")
        val fortran = Regex("['\"]fortran_order['\"]\\s*:\\s*(True|False)")
            .find(header)?.groupValues?.get(1)
        if (fortran != "False") throw IllegalStateException("Kokoro voice entry must use C-order data")
        val shapeText = Regex("['\"]shape['\"]\\s*:\\s*\\(([^)]*)\\)")
            .find(header)?.groupValues?.get(1)
            ?: throw IllegalStateException("Kokoro voice entry is missing its shape")
        val shape = shapeText.split(',').mapNotNull { item ->
            item.trim().takeIf(String::isNotEmpty)?.toIntOrNull()
        }
        if (shape != listOf(510, 1, 256)) {
            throw IllegalStateException("Kokoro voice entry has incompatible shape $shape")
        }
        val payloadBytes = Math.multiplyExact(Math.multiplyExact(shape[0], shape[1]), Math.multiplyExact(shape[2], 4))
        if (dataOffset + payloadBytes != bytes.size) {
            throw IllegalStateException("Kokoro voice entry payload is truncated or oversized")
        }
        return NpyFloatLayout(dataOffset, shape[0], shape[1] * shape[2])
    }

    private fun readVoice(archive: ZipFile, voice: String): ByteArray {
        val selected = KokoroSupport.requireVoice(voice)
        val entry = archive.getEntry("$selected.npy")
            ?: throw IllegalStateException("Kokoro voice $selected is not installed")
        if (entry.isDirectory || entry.size <= 0 || entry.size > MAX_VOICE_ENTRY_BYTES) {
            throw IllegalStateException("Kokoro voice $selected has an invalid archive entry")
        }
        archive.getInputStream(entry).use { input ->
            val output = ByteArrayOutputStream(entry.size.toInt())
            val buffer = ByteArray(64 * 1024)
            var total = 0
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count == 0) continue
                total = Math.addExact(total, count)
                if (total > MAX_VOICE_ENTRY_BYTES) {
                    throw IllegalStateException("Kokoro voice $selected is too large")
                }
                output.write(buffer, 0, count)
            }
            if (entry.size >= 0 && total.toLong() != entry.size) {
                throw IllegalStateException("Kokoro voice $selected is truncated")
            }
            return output.toByteArray()
        }
    }

    private fun unsignedShort(bytes: ByteArray, offset: Int): Int =
        (bytes[offset].toInt() and 0xff) or ((bytes[offset + 1].toInt() and 0xff) shl 8)

    private fun unsignedInt(bytes: ByteArray, offset: Int): Long =
        (bytes[offset].toLong() and 0xff) or
            ((bytes[offset + 1].toLong() and 0xff) shl 8) or
            ((bytes[offset + 2].toLong() and 0xff) shl 16) or
            ((bytes[offset + 3].toLong() and 0xff) shl 24)

    private val NPY_MAGIC = byteArrayOf(0x93.toByte(), 'N'.code.toByte(), 'U'.code.toByte(), 'M'.code.toByte(), 'P'.code.toByte(), 'Y'.code.toByte())
    private const val MAX_VOICE_ENTRY_BYTES = 4 * 1024 * 1024
}

/** Kotlin/ONNX Runtime implementation of the Kokoro v1.0 model used on desktop. */
class KokoroRuntime(private val modelManager: OnDeviceModelManager) {
    private data class CachedVoice(val bytes: ByteArray, val layout: NpyFloatLayout)

    private val environment = OrtEnvironment.getEnvironment()
    private val voiceCache = object : LinkedHashMap<String, CachedVoice>(3, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CachedVoice>?): Boolean = size > 2
    }
    private var loadedGeneration = Long.MIN_VALUE

    data class GeneratedAudio(val samples: FloatArray, val sampleRate: Int)

    fun synthesize(text: String, voice: String, speed: Float): GeneratedAudio =
        modelManager.withSessions("kokoro") { sessions, root, generation ->
            if (sessions.size != 1) throw IllegalStateException("Kokoro requires one ONNX session")
            if (!speed.isFinite() || speed !in 0.5f..2.0f) {
                throw IllegalArgumentException("Kokoro speed must be between 0.5 and 2.0")
            }
            val selectedVoice = KokoroSupport.requireVoice(voice)
            if (generation != loadedGeneration) {
                voiceCache.clear()
                loadedGeneration = generation
            }
            val g2p = modelManager.kokoroG2p.phonemize(
                text = text,
                british = KokoroSupport.languageForVoice(selectedVoice) == "en-gb",
            )
            val phonemes = g2p.phonemes
            val batches = splitPhonemes(phonemes)
            if (batches.isEmpty()) throw IllegalStateException("Kokoro phonemization produced no usable text")

            val parts = batches.map { runBatch(sessions[0], root, it, selectedVoice, speed) }
            val totalSamples = parts.fold(0) { total, part -> Math.addExact(total, part.size) }
            if (totalSamples <= 0) throw IllegalStateException("Kokoro produced no audio")
            val output = FloatArray(totalSamples)
            var offset = 0
            parts.forEach { part ->
                part.copyInto(output, offset)
                offset += part.size
            }
            GeneratedAudio(output, SAMPLE_RATE)
        }

    private fun runBatch(
        session: OrtSession,
        root: File,
        phonemes: String,
        voice: String,
        speed: Float,
    ): FloatArray {
        val tokenValues = KokoroVocab.tokenize(phonemes)
        if (tokenValues.isEmpty()) throw IllegalStateException("Kokoro batch contains no supported phonemes")
        if (tokenValues.size > MAX_BATCH_TOKENS) throw IllegalStateException("Kokoro phoneme batch is too long")
        val tokens = LongArray(tokenValues.size + 2)
        tokenValues.copyInto(tokens, 1)
        val style = readVoiceRow(root, voice, tokenValues.size)
        val tokensTensor = OnnxTensor.createTensor(environment, arrayOf(tokens))
        val styleTensor = OnnxTensor.createTensor(environment, arrayOf(style))
        val speedTensor = OnnxTensor.createTensor(environment, FloatBuffer.wrap(floatArrayOf(speed)), longArrayOf(1))
        try {
            session.run(mapOf("tokens" to tokensTensor, "style" to styleTensor, "speed" to speedTensor)).use { result ->
                val output = result[0]
                val info = output.info as? TensorInfo
                    ?: throw IllegalStateException("Kokoro returned invalid tensor metadata")
                val samples = flatten(output.value, info.shape)
                if (samples.isEmpty() || samples.any { !it.isFinite() }) {
                    throw IllegalStateException("Kokoro produced invalid audio")
                }
                return KokoroSupport.trimSilence(samples)
            }
        } finally {
            tokensTensor.close()
            styleTensor.close()
            speedTensor.close()
        }
    }

    private fun splitPhonemes(value: String): List<String> {
        val clean = value.trim()
        if (clean.isEmpty()) return emptyList()
        if (clean.length <= MAX_BATCH_TOKENS) return listOf(clean)
        val result = mutableListOf<String>()
        var start = 0
        while (start < clean.length) {
            var end = (start + MAX_BATCH_TOKENS).coerceAtMost(clean.length)
            if (end < clean.length) {
                val preferred = clean.lastIndexOfAny(charArrayOf('.', ',', '!', '?', ';'), end - 1)
                if (preferred > start + MIN_PREFERRED_SPLIT) end = preferred + 1
            }
            val part = clean.substring(start, end).trim()
            if (part.isNotEmpty()) result += part
            start = end
        }
        return result
    }

    private fun readVoiceRow(root: File, voice: String, row: Int): FloatArray {
        val cached = voiceCache[voice] ?: KokoroModelAssets.readVoice(root, voice).let { bytes ->
            CachedVoice(bytes, KokoroModelAssets.parseNpy(bytes)).also { voiceCache[voice] = it }
        }
        if (row !in 0 until cached.layout.rows) throw IllegalStateException("Kokoro voice row is out of range")
        val rowOffset = cached.layout.dataOffset + row * cached.layout.rowWidth * 4
        if (rowOffset + cached.layout.rowWidth * 4 > cached.bytes.size) {
            throw IllegalStateException("Kokoro voice row is truncated")
        }
        val result = FloatArray(cached.layout.rowWidth)
        val buffer = ByteBuffer.wrap(cached.bytes).order(ByteOrder.LITTLE_ENDIAN)
        for (index in result.indices) result[index] = buffer.getFloat(rowOffset + index * 4)
        if (result.any { !it.isFinite() }) throw IllegalStateException("Kokoro voice row contains invalid values")
        return result
    }

    private fun flatten(value: Any?, shape: LongArray): FloatArray {
        val count = shape.fold(1L) { total, dimension -> Math.multiplyExact(total, dimension) }
        if (count <= 0 || count > Int.MAX_VALUE) throw IllegalStateException("Kokoro output tensor is too large")
        val result = FloatArray(count.toInt())
        val written = appendOutput(value, result, 0)
        if (written != result.size) throw IllegalStateException("Kokoro output tensor has an unexpected shape")
        return result
    }

    private fun appendOutput(value: Any?, output: FloatArray, offset: Int): Int = when (value) {
        is FloatArray -> {
            if (offset + value.size > output.size) throw IllegalStateException("Kokoro output is too large")
            value.copyInto(output, offset)
            offset + value.size
        }
        is DoubleArray -> {
            if (offset + value.size > output.size) throw IllegalStateException("Kokoro output is too large")
            value.indices.forEach { output[offset + it] = value[it].toFloat() }
            offset + value.size
        }
        is Number -> {
            if (offset >= output.size) throw IllegalStateException("Kokoro output is too large")
            output[offset] = value.toFloat()
            offset + 1
        }
        null -> throw IllegalStateException("Kokoro output is null")
        else -> {
            if (!value.javaClass.isArray) throw IllegalStateException("Kokoro output contains unsupported data")
            var next = offset
            for (index in 0 until java.lang.reflect.Array.getLength(value)) {
                next = appendOutput(java.lang.reflect.Array.get(value, index), output, next)
            }
            next
        }
    }

    private companion object {
        const val SAMPLE_RATE = 24_000
        const val MAX_BATCH_TOKENS = 508
        const val MIN_PREFERRED_SPLIT = 128
    }
}
