package com.folio.reader.mobile

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.FloatBuffer
import java.text.Normalizer
import java.util.Random
import kotlin.math.ceil

internal data class SupertonicTensor(val data: FloatArray, val shape: LongArray)
internal data class SupertonicStyle(
    val ttl: FloatArray,
    val ttlShape: LongArray,
    val dp: FloatArray,
    val dpShape: LongArray,
)

internal object SupertonicTensorParser {
    fun fromJson(json: JSONObject): SupertonicTensor {
        if (json.has("type") && json.optString("type") != "float32") {
            throw IllegalStateException("Supertonic style tensor must use float32 data")
        }
        val dims = json.optJSONArray("dims")
            ?: throw IllegalStateException("Supertonic style tensor is missing dims")
        val shape = LongArray(dims.length()) { index ->
            val value = dims.optLong(index, -1)
            if (value <= 0) throw IllegalStateException("Supertonic style tensor has invalid dimensions")
            value
        }
        return fromNested(shape, json.opt("data"))
    }

    internal fun fromNested(shape: LongArray, value: Any?): SupertonicTensor {
        if (shape.isEmpty() || shape.size > 6 || shape.any { it <= 0 }) {
            throw IllegalArgumentException("Supertonic style tensor has invalid dimensions")
        }
        val elementCount = shape.fold(1L, Math::multiplyExact)
        if (elementCount > Int.MAX_VALUE) throw IllegalArgumentException("Supertonic style tensor is too large")
        val output = FloatArray(elementCount.toInt())
        val finalOffset = appendDimension(value, shape, 0, output, 0)
        if (finalOffset != output.size) throw IllegalArgumentException("Supertonic style tensor size is invalid")
        return SupertonicTensor(output, shape.copyOf())
    }

    private fun appendDimension(
        value: Any?,
        shape: LongArray,
        depth: Int,
        output: FloatArray,
        offset: Int,
    ): Int {
        if (depth == shape.size) {
            val number = value as? Number
                ?: throw IllegalArgumentException("Supertonic style tensor contains a non-numeric value")
            val scalar = number.toFloat()
            if (!scalar.isFinite()) throw IllegalArgumentException("Supertonic style tensor contains a non-finite value")
            output[offset] = scalar
            return offset + 1
        }

        val expected = shape[depth].toInt()
        val actual = containerSize(value)
        if (actual != expected) {
            throw IllegalArgumentException(
                "Supertonic style tensor is ragged at dimension $depth (expected $expected, found $actual)",
            )
        }
        var next = offset
        for (index in 0 until actual) {
            next = appendDimension(containerValue(value, index), shape, depth + 1, output, next)
        }
        return next
    }

    private fun containerSize(value: Any?): Int = when (value) {
        is JSONArray -> value.length()
        is List<*> -> value.size
        is Array<*> -> value.size
        is FloatArray -> value.size
        is DoubleArray -> value.size
        is IntArray -> value.size
        is LongArray -> value.size
        else -> throw IllegalArgumentException("Supertonic style tensor data is not an array")
    }

    private fun containerValue(value: Any?, index: Int): Any? = when (value) {
        is JSONArray -> value.opt(index)
        is List<*> -> value[index]
        is Array<*> -> value[index]
        is FloatArray -> value[index]
        is DoubleArray -> value[index]
        is IntArray -> value[index]
        is LongArray -> value[index]
        else -> null
    }
}

internal object SupertonicModelAssets {
    data class Config(
        val sampleRate: Int,
        val baseChunkSize: Int,
        val chunkCompressFactor: Int,
        val latentDim: Int,
        val unicodeIndexer: IntArray,
    )

    val voices = listOf("M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5")

    fun loadConfig(root: File): Config {
        val config = JSONObject(File(root, "onnx/tts.json").readText())
        val ae = config.getJSONObject("ae")
        val ttl = config.getJSONObject("ttl")
        val sampleRate = ae.getInt("sample_rate")
        val baseChunkSize = ae.getInt("base_chunk_size")
        val chunkCompressFactor = ttl.getInt("chunk_compress_factor")
        val latentDim = ttl.getInt("latent_dim")
        if (sampleRate !in 8_000..192_000 || baseChunkSize !in 64..16_384 ||
            chunkCompressFactor !in 1..32 || latentDim !in 1..1_024
        ) {
            throw IllegalStateException("Supertonic configuration contains invalid dimensions")
        }
        Math.multiplyExact(baseChunkSize, chunkCompressFactor)
        Math.multiplyExact(latentDim, chunkCompressFactor)

        val values = JSONArray(File(root, "onnx/unicode_indexer.json").readText())
        if (values.length() < 128 || values.length() > 1_114_112) {
            throw IllegalStateException("Supertonic unicode indexer has an invalid length")
        }
        val indexer = IntArray(values.length()) { index ->
            val item = values.opt(index)
            if (item !is Number) throw IllegalStateException("Supertonic unicode indexer contains invalid data")
            item.toInt()
        }
        return Config(sampleRate, baseChunkSize, chunkCompressFactor, latentDim, indexer)
    }

    fun loadStyle(root: File, voice: String): SupertonicStyle {
        if (voice !in voices) throw IllegalArgumentException("Unknown Supertonic voice: $voice")
        val json = JSONObject(File(root, "voice_styles/$voice.json").readText())
        val ttl = SupertonicTensorParser.fromJson(json.getJSONObject("style_ttl"))
        val dp = SupertonicTensorParser.fromJson(json.getJSONObject("style_dp"))
        if (!ttl.shape.contentEquals(longArrayOf(1, 50, 256)) ||
            !dp.shape.contentEquals(longArrayOf(1, 8, 16))
        ) {
            throw IllegalStateException("Supertonic voice $voice has incompatible tensor shapes")
        }
        return SupertonicStyle(ttl.data, ttl.shape, dp.data, dp.shape)
    }

    fun validate(root: File) {
        loadConfig(root)
        voices.forEach { loadStyle(root, it) }
    }
}

/** Android port of the Supertonic-3 ONNX inference pipeline. */
class SupertonicRuntime(private val modelManager: OnDeviceModelManager) {
    private val environment = OrtEnvironment.getEnvironment()
    private val random = Random()
    private val styleCache = mutableMapOf<String, SupertonicStyle>()
    private var loadedGeneration = Long.MIN_VALUE
    private lateinit var config: SupertonicModelAssets.Config

    data class GeneratedAudio(val samples: FloatArray, val sampleRate: Int)
    private data class TensorData(val data: FloatArray, val shape: LongArray)

    fun synthesize(text: String, voice: String, speed: Float): GeneratedAudio =
        modelManager.withSessions("supertonic") { sessions, root, generation ->
            if (sessions.size != 4) throw IllegalStateException("Supertonic requires four ONNX sessions")
            if (!speed.isFinite() || speed !in 0.7f..2.0f) {
                throw IllegalArgumentException("Supertonic speed must be between 0.7 and 2.0")
            }
            val selectedVoice = voice.ifBlank { "M1" }
            if (selectedVoice !in SupertonicModelAssets.voices) {
                throw IllegalArgumentException("Unknown Supertonic voice: $selectedVoice")
            }
            if (generation != loadedGeneration) {
                config = SupertonicModelAssets.loadConfig(root)
                styleCache.clear()
                loadedGeneration = generation
            }

            val style = styleCache.getOrPut(selectedVoice) {
                SupertonicModelAssets.loadStyle(root, selectedVoice)
            }
            val prepared = preprocess(text)
            val ids = codePointIds(prepared)
            if (ids.isEmpty()) throw IllegalArgumentException("Text contains no Supertonic-supported characters")
            if (ids.size > MAX_TEXT_IDS) throw IllegalArgumentException("Text is too long for one Supertonic request")
            val textMask = FloatArray(ids.size) { 1f }

            val duration = runDuration(sessions[0], ids, textMask, style, speed)
            if (!duration.isFinite() || duration <= 0f || duration > MAX_AUDIO_SECONDS) {
                throw IllegalStateException("Supertonic predicted an invalid audio duration")
            }
            val wavLength = (duration * config.sampleRate).toInt().coerceAtLeast(1)
            val latentSize = Math.multiplyExact(config.baseChunkSize, config.chunkCompressFactor)
            val latentLength = ceil(wavLength.toDouble() / latentSize).toInt().coerceAtLeast(1)
            val latentChannels = Math.multiplyExact(config.latentDim, config.chunkCompressFactor)
            val latentElementCount = Math.multiplyExact(latentChannels, latentLength)
            if (latentElementCount > MAX_LATENT_ELEMENTS) {
                throw IllegalStateException("Supertonic request would exceed the Android inference memory limit")
            }
            val latentShape = longArrayOf(1, latentChannels.toLong(), latentLength.toLong())
            val latentValues = FloatArray(latentElementCount) { random.nextGaussian().toFloat() }
            val latentMask = FloatArray(latentLength) { 1f }
            val textEmbedding = runTextEncoder(sessions[1], ids, textMask, style)

            var latent = TensorData(latentValues, latentShape)
            val totalStep = floatTensor(floatArrayOf(QUALITY_STEPS.toFloat()), longArrayOf(1))
            try {
                repeat(QUALITY_STEPS) { step ->
                    val noisy = floatTensor(latent.data, latent.shape)
                    val embedding = floatTensor(textEmbedding.data, textEmbedding.shape)
                    val ttlInput = floatTensor(style.ttl, style.ttlShape)
                    val maskInput = floatTensor(textMask, longArrayOf(1, 1, ids.size.toLong()))
                    val latentMaskInput = floatTensor(latentMask, longArrayOf(1, 1, latentLength.toLong()))
                    val currentStep = floatTensor(floatArrayOf(step.toFloat()), longArrayOf(1))
                    latent = try {
                        runTensor(
                            sessions[2],
                            mapOf(
                                "noisy_latent" to noisy,
                                "text_emb" to embedding,
                                "style_ttl" to ttlInput,
                                "text_mask" to maskInput,
                                "latent_mask" to latentMaskInput,
                                "current_step" to currentStep,
                                "total_step" to totalStep,
                            ),
                        )
                    } finally {
                        noisy.close()
                        embedding.close()
                        ttlInput.close()
                        maskInput.close()
                        latentMaskInput.close()
                        currentStep.close()
                    }
                }
                val latentInput = floatTensor(latent.data, latent.shape)
                val audio = try {
                    runTensor(sessions[3], mapOf("latent" to latentInput)).data
                } finally {
                    latentInput.close()
                }
                if (audio.isEmpty() || audio.any { !it.isFinite() }) {
                    throw IllegalStateException("Supertonic produced invalid audio")
                }
                GeneratedAudio(audio, config.sampleRate)
            } finally {
                totalStep.close()
            }
        }

    private fun runDuration(
        session: OrtSession,
        ids: LongArray,
        textMask: FloatArray,
        style: SupertonicStyle,
        speed: Float,
    ): Float {
        val idsTensor = OnnxTensor.createTensor(environment, arrayOf(ids))
        val maskTensor = floatTensor(textMask, longArrayOf(1, 1, ids.size.toLong()))
        val dpStyle = floatTensor(style.dp, style.dpShape)
        return try {
            val values = runTensor(
                session,
                mapOf("text_ids" to idsTensor, "style_dp" to dpStyle, "text_mask" to maskTensor),
            ).data
            (values.firstOrNull() ?: throw IllegalStateException("Supertonic returned no duration")) / speed
        } finally {
            idsTensor.close()
            maskTensor.close()
            dpStyle.close()
        }
    }

    private fun runTextEncoder(
        session: OrtSession,
        ids: LongArray,
        textMask: FloatArray,
        style: SupertonicStyle,
    ): TensorData {
        val idsInput = OnnxTensor.createTensor(environment, arrayOf(ids))
        val maskInput = floatTensor(textMask, longArrayOf(1, 1, ids.size.toLong()))
        val ttlInput = floatTensor(style.ttl, style.ttlShape)
        return try {
            runTensor(
                session,
                mapOf("text_ids" to idsInput, "style_ttl" to ttlInput, "text_mask" to maskInput),
            )
        } finally {
            idsInput.close()
            maskInput.close()
            ttlInput.close()
        }
    }

    private fun codePointIds(value: String): LongArray {
        val result = mutableListOf<Long>()
        var offset = 0
        while (offset < value.length) {
            val codePoint = value.codePointAt(offset)
            val mapped = if (codePoint in config.unicodeIndexer.indices) config.unicodeIndexer[codePoint] else -1
            if (mapped >= 0) result += mapped.toLong()
            offset += Character.charCount(codePoint)
        }
        return result.toLongArray()
    }

    private fun preprocess(value: String): String {
        var text = Normalizer.normalize(value, Normalizer.Form.NFKD)
            .replace('\u2011', '-')
            .replace('\u2013', '-')
            .replace('\u2014', '-')
            .replace('\u201c', '"')
            .replace('\u201d', '"')
            .replace('\u2018', '\'')
            .replace('\u2019', '\'')
            .replace('_', ' ')
            .replace(Regex("\\s+"), " ")
            .trim()
        if (text.isEmpty()) throw IllegalArgumentException("Text is required")
        if (text.last() !in ".!?;:,'\")]}…。」』】〉》›»") text += "."
        return "<en>$text</en>"
    }

    private fun floatTensor(data: FloatArray, shape: LongArray): OnnxTensor =
        OnnxTensor.createTensor(environment, FloatBuffer.wrap(data), shape)

    private fun runTensor(session: OrtSession, inputs: Map<String, OnnxTensor>): TensorData {
        session.run(inputs).use { results ->
            val output = results[0]
            val info = output.info as? TensorInfo
                ?: throw IllegalStateException("ONNX graph returned invalid tensor metadata")
            return TensorData(flatten(output.value, info.shape), info.shape.copyOf())
        }
    }

    private fun flatten(value: Any?, shape: LongArray): FloatArray {
        val count = shape.fold(1L, Math::multiplyExact)
        if (count <= 0 || count > Int.MAX_VALUE) throw IllegalStateException("ONNX output tensor is too large")
        val result = FloatArray(count.toInt())
        val written = appendOutput(value, result, 0)
        if (written != result.size) throw IllegalStateException("ONNX output tensor has an unexpected shape")
        return result
    }

    private fun appendOutput(value: Any?, output: FloatArray, offset: Int): Int = when (value) {
        is FloatArray -> {
            if (offset + value.size > output.size) throw IllegalStateException("ONNX output is too large")
            value.copyInto(output, offset)
            offset + value.size
        }
        is DoubleArray -> {
            if (offset + value.size > output.size) throw IllegalStateException("ONNX output is too large")
            value.indices.forEach { output[offset + it] = value[it].toFloat() }
            offset + value.size
        }
        is Number -> {
            if (offset >= output.size) throw IllegalStateException("ONNX output is too large")
            output[offset] = value.toFloat()
            offset + 1
        }
        null -> throw IllegalStateException("ONNX output is null")
        else -> {
            if (!value.javaClass.isArray) throw IllegalStateException("ONNX output contains unsupported data")
            var next = offset
            for (index in 0 until java.lang.reflect.Array.getLength(value)) {
                next = appendOutput(java.lang.reflect.Array.get(value, index), output, next)
            }
            next
        }
    }

    private companion object {
        const val QUALITY_STEPS = 8
        const val MAX_TEXT_IDS = 4_096
        const val MAX_AUDIO_SECONDS = 180f
        const val MAX_LATENT_ELEMENTS = 32 * 1024 * 1024
    }
}
