package com.folio.reader.mobile

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.Locale
import java.util.UUID

internal data class NativePhonemizerReadiness(
    val ready: Boolean,
    val error: String? = null,
)

/**
 * Lazy, process-local eSpeak NG phonemizer used by Kokoro. The native library
 * is bundled with the APK; only its small data directory is copied to an
 * app-private writable location on first use because eSpeak expects a path.
 */
class EspeakPhonemizer(private val context: Context) {
    private val lock = Any()
    private var initialized = false
    private var lastReadinessError: String? = null
    private var lastReadinessAttemptMs = 0L

    companion object {
        private val nativeLoadResult = runCatching {
            System.loadLibrary("folio_espeak")
        }
        private val nativeLoaded = nativeLoadResult.isSuccess

        private const val ASSET_ROOT = "espeak-ng-data"
        private const val DATA_VERSION = "folio-espeak-ng-1"
        private const val READINESS_RETRY_MS = 30_000L
        private val LANGUAGE_PATTERN = Regex("^[a-z]{2,3}(?:-[a-z]{2})?$")
    }

    /** Returns true only after the bundled library and data initialize successfully. */
    fun available(): Boolean = readiness().ready

    internal fun readiness(): NativePhonemizerReadiness {
        if (!nativeLoaded) {
            val detail = nativeLoadResult.exceptionOrNull()?.message?.take(240)
            return NativePhonemizerReadiness(false, detail ?: "The Android eSpeak NG library could not be loaded")
        }
        if (!bundledDataPresent()) {
            return NativePhonemizerReadiness(false, "The Android eSpeak NG data assets are missing")
        }
        return synchronized(lock) { initializeLocked(forceRetry = false) }
    }

    fun phonemize(text: String, language: String = "en-us"): String {
        val cleanText = text.trim()
        if (cleanText.isEmpty()) throw IllegalArgumentException("Text is required for phonemization")
        val cleanLanguage = language.trim().lowercase(Locale.ROOT)
        if (!LANGUAGE_PATTERN.matches(cleanLanguage)) {
            throw IllegalArgumentException("Invalid eSpeak NG language code: $language")
        }
        synchronized(lock) {
            val native = initializeLocked(forceRetry = true)
            if (!native.ready) {
                throw IllegalStateException(native.error ?: "The Android eSpeak NG phonemizer is unavailable")
            }
            return nativePhonemize(cleanText, cleanLanguage)
                ?.trim()
                ?.takeIf(String::isNotEmpty)
                ?: throw IllegalStateException("eSpeak NG returned no phonemes")
        }
    }

    private fun initializeLocked(forceRetry: Boolean): NativePhonemizerReadiness {
        if (initialized) return NativePhonemizerReadiness(true)
        val now = System.currentTimeMillis()
        if (
            !forceRetry && lastReadinessError != null &&
            now - lastReadinessAttemptMs in 0 until READINESS_RETRY_MS
        ) {
            return NativePhonemizerReadiness(false, lastReadinessError)
        }
        lastReadinessAttemptMs = now
        return try {
            // espeak_Initialize expects the directory *containing*
            // espeak-ng-data, not espeak-ng-data itself.
            val dataPath = ensureDataParentPath()
            if (!nativeInitialize(dataPath)) throw IllegalStateException("eSpeak NG could not initialize")
            initialized = true
            lastReadinessError = null
            NativePhonemizerReadiness(true)
        } catch (error: Throwable) {
            initialized = false
            lastReadinessError = error.message?.take(240) ?: "eSpeak NG could not initialize"
            NativePhonemizerReadiness(false, lastReadinessError)
        }
    }

    private fun bundledDataPresent(): Boolean = runCatching {
        context.assets.list(ASSET_ROOT).orEmpty().isNotEmpty()
    }.getOrDefault(false)

    private fun ensureDataParentPath(): String {
        val installRoot = File(context.filesDir, "phonemizer")
        val target = File(installRoot, ASSET_ROOT)
        val marker = File(target, ".folio-data-ready")
        val ready = marker.isFile && runCatching { marker.readText() == DATA_VERSION }.getOrDefault(false)
        if (!ready) {
            if (!installRoot.isDirectory && !installRoot.mkdirs()) {
                throw IllegalStateException("Could not create the eSpeak NG data directory")
            }
            val staging = File(installRoot, ".$ASSET_ROOT.import-${UUID.randomUUID()}")
            val backup = File(installRoot, ".$ASSET_ROOT.previous-${UUID.randomUUID()}")
            try {
                copyAssetTree(ASSET_ROOT, staging)
                File(staging, ".folio-data-ready").writeText(DATA_VERSION)

                if (target.exists() && !target.renameTo(backup)) {
                    throw IllegalStateException("Could not preserve the existing eSpeak NG data")
                }
                if (!staging.renameTo(target)) {
                    if (backup.exists() && !backup.renameTo(target)) {
                        throw IllegalStateException("Could not install or restore the eSpeak NG data")
                    }
                    throw IllegalStateException("Could not install eSpeak NG data")
                }
                backup.deleteRecursively()
            } finally {
                staging.deleteRecursively()
                if (backup.exists() && !target.exists()) backup.renameTo(target)
                if (target.exists()) backup.deleteRecursively()
            }
        }
        return installRoot.absolutePath
    }

    private fun copyAssetTree(assetPath: String, target: File) {
        val children = context.assets.list(assetPath).orEmpty()
        if (children.isNotEmpty()) {
            if (!target.isDirectory && !target.mkdirs()) {
                throw IOException("Could not create asset directory ${target.absolutePath}")
            }
            children.forEach { child -> copyAssetTree("$assetPath/$child", File(target, child)) }
            return
        }

        // AssetManager.list() returns an empty array for a file. Creating the
        // target directory before this check turns every leaf into a directory
        // and makes FileOutputStream fail on first use.
        target.parentFile?.let { parent ->
            if (!parent.isDirectory && !parent.mkdirs()) {
                throw IOException("Could not create asset parent ${parent.absolutePath}")
            }
        }
        context.assets.open(assetPath).use { input ->
            FileOutputStream(target).use { output -> input.copyTo(output, 64 * 1024) }
        }
    }

    private external fun nativeInitialize(dataPath: String): Boolean
    private external fun nativePhonemize(text: String, language: String): String?

}
