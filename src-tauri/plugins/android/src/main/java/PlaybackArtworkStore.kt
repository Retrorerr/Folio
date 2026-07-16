package com.folio.reader.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Typeface
import android.media.ExifInterface
import android.util.Base64
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID

/** Durable, bounded artwork conversion for Media3 metadata. */
internal object PlaybackArtworkStore {
    private const val SHARED_FALLBACK_FILE = "folio-fallback.jpg"
    private const val CACHE_DIRECTORY = "folio-artwork"
    private const val LEGACY_DIRECTORY = "folio-playback"
    private const val MAX_CACHE_BYTES = 32L * 1024L * 1024L

    fun prepare(
        context: android.content.Context,
        bookId: String,
        encoded: String?,
        mimeType: String?,
        reusablePath: String? = null,
        revision: String? = null,
    ): String? {
        return try {
            val appContext = context.applicationContext
            val root = artworkRoot(appContext)
            val fallback = { sharedFallback(root) }
            val normalizedBookId = bookId.trim()
            if (normalizedBookId.isEmpty()) return fallback()
            val target = File(root, "artwork-${PlaybackArtworkPolicy.artworkKey(normalizedBookId)}.jpg")
            val input = encoded?.trim().orEmpty()
            val reusable = reusablePath?.let { File(it) }
            if (reusable != null && isValidArtwork(reusable)) {
                val fallbackPath = isSharedFallback(appContext, reusable.absolutePath)
                if (isCacheFile(appContext, reusable) && !fallbackPath &&
                    (input.isEmpty() || revisionMatches(reusable, revision))) {
                    return reusable.canonicalPath
                }
                if (isLegacyFile(appContext, reusable) && input.isEmpty()) {
                    copyAtomic(reusable, target)
                    writeRevision(target, revision)
                    return target.absolutePath
                }
            }
            if (isValidArtwork(target) && revisionMatches(target, revision)) return target.absolutePath
            if (input.isEmpty()) {
                if (isValidArtwork(target)) return target.absolutePath
                return fallback()
            }

            val normalizedMime = PlaybackArtworkPolicy.normalizeMimeType(mimeType)
            if (
                normalizedMime == null ||
                input.length > PlaybackArtworkPolicy.MAX_ENCODED_CHARS ||
                PlaybackArtworkPolicy.approximateDecodedBytes(input) > PlaybackArtworkPolicy.MAX_INPUT_BYTES
            ) {
                return if (isValidArtwork(target)) target.absolutePath else fallback()
            }

            val bytes = try {
                Base64.decode(input, Base64.DEFAULT)
            } catch (_: Throwable) {
                null
            }
            if (bytes == null || bytes.isEmpty() || bytes.size.toLong() > PlaybackArtworkPolicy.MAX_INPUT_BYTES) {
                return if (isValidArtwork(target)) target.absolutePath else fallback()
            }

            val bitmap = decode(bytes) ?: return if (isValidArtwork(target)) target.absolutePath else fallback()
            return try {
                writeAtomic(target, bitmap)
                writeRevision(target, revision)
                target.absolutePath
            } finally {
                bitmap.recycle()
            }
        } catch (_: Throwable) {
            // Artwork must never turn a valid audio chunk into a playback
            // failure. Media3 can still expose title/artist without artwork.
            null
        }
    }

    private fun decode(bytes: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val width = bounds.outWidth
        val height = bounds.outHeight
        if (width <= 0 || height <= 0) return null
        if (width > PlaybackArtworkPolicy.MAX_DIMENSION || height > PlaybackArtworkPolicy.MAX_DIMENSION) return null
        if (width.toLong() * height.toLong() > PlaybackArtworkPolicy.MAX_DECODED_PIXELS) return null

        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSize(width, height)
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return null
        val oriented = orient(decoded, bytes)
        val maxDimension = maxOf(oriented.width, oriented.height)
        if (maxDimension <= PlaybackArtworkPolicy.MAX_OUTPUT_DIMENSION) return oriented
        val scale = PlaybackArtworkPolicy.MAX_OUTPUT_DIMENSION.toFloat() / maxDimension.toFloat()
        val scaled = Bitmap.createScaledBitmap(
            oriented,
            maxOf(1, (oriented.width * scale).toInt()),
            maxOf(1, (oriented.height * scale).toInt()),
            true,
        )
        if (scaled !== oriented) oriented.recycle()
        return scaled
    }

    private fun sampleSize(width: Int, height: Int): Int {
        var sample = 1
        while (width / sample > 2_048 || height / sample > 2_048) sample *= 2
        return sample
    }

    private fun orient(bitmap: Bitmap, bytes: ByteArray): Bitmap {
        val orientation = runCatching {
            ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL,
            )
        }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(-90f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
            else -> return bitmap
        }
        val transformed = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        if (transformed !== bitmap) bitmap.recycle()
        return transformed
    }

    private fun writeAtomic(target: File, bitmap: Bitmap) {
        val temporary = File(target.parentFile, ".pending-artwork-${UUID.randomUUID()}.jpg")
        try {
            FileOutputStream(temporary).use { output ->
                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 88, output)) throw IllegalStateException("Artwork encoding failed")
                output.flush()
                output.fd.sync()
            }
            if (!temporary.isFile || temporary.length() <= 0L || temporary.length() > PlaybackArtworkPolicy.MAX_OUTPUT_BYTES) {
                throw IllegalStateException("Artwork output is invalid")
            }
            commitAtomic(temporary, target)
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun writeFallback(target: File): String? {
        val bitmap = Bitmap.createBitmap(720, 960, Bitmap.Config.ARGB_8888)
        return try {
            val canvas = Canvas(bitmap)
            canvas.drawColor(Color.rgb(28, 25, 22))
            val accent = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(216, 162, 74); style = Paint.Style.STROKE; strokeWidth = 6f }
            canvas.drawRoundRect(92f, 92f, 628f, 868f, 28f, 28f, accent)
            val title = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.rgb(244, 228, 196)
                textAlign = Paint.Align.CENTER
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                textSize = 76f
            }
            canvas.drawText("FOLIO", 360f, 480f, title)
            val rule = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(216, 162, 74); strokeWidth = 3f }
            canvas.drawLine(190f, 540f, 530f, 540f, rule)
            writeAtomic(target, bitmap)
            target.absolutePath
        } catch (_: Throwable) {
            null
        } finally {
            bitmap.recycle()
        }
    }

    private fun artworkRoot(context: android.content.Context): File = File(context.noBackupFilesDir, CACHE_DIRECTORY).apply {
        if ((!exists() && !mkdirs()) || !isDirectory) throw IllegalStateException("Artwork storage is unavailable")
    }.canonicalFile

    private fun legacyRoot(context: android.content.Context): File = File(context.noBackupFilesDir, LEGACY_DIRECTORY).canonicalFile

    private fun isCacheFile(context: android.content.Context, file: File): Boolean =
        runCatching { file.canonicalPath.startsWith(artworkRoot(context).path + File.separator) }.getOrDefault(false)

    private fun isLegacyFile(context: android.content.Context, file: File): Boolean =
        runCatching { file.canonicalPath.startsWith(legacyRoot(context).path + File.separator) }.getOrDefault(false)

    internal fun migrateLegacyPath(context: android.content.Context, bookId: String, path: String?): String? {
        val source = path?.let { File(it) } ?: return null
        if (!isLegacyFile(context, source) || !isValidArtwork(source)) return null
        val root = runCatching { artworkRoot(context) }.getOrNull() ?: return null
        val target = File(root, "artwork-${PlaybackArtworkPolicy.artworkKey(bookId)}.jpg")
        return runCatching {
            if (!isValidArtwork(target)) copyAtomic(source, target)
            target.absolutePath
        }.getOrNull()
    }

    internal fun normalizeStoredPath(context: android.content.Context, bookId: String, path: String?): String? {
        val value = path?.trim().orEmpty()
        if (value.isEmpty()) return null
        if (isSharedFallback(context, value)) return runCatching { sharedFallback(artworkRoot(context)) }.getOrNull()
        val file = File(value)
        if (isCacheFile(context, file) && isValidArtwork(file)) return file.canonicalPath
        return migrateLegacyPath(context, bookId, value)
    }

    internal fun prune(context: android.content.Context, protectedBookIds: Set<String>, referencedPaths: Set<String>) {
        val root = runCatching { artworkRoot(context) }.getOrNull() ?: return
        val protectedKeys = protectedBookIds.map { PlaybackArtworkPolicy.artworkKey(it) }.toSet()
        val candidates = root.listFiles()?.filter { file ->
            file.name.startsWith("artwork-") && file.extension == "jpg" && file.absolutePath !in referencedPaths &&
                file.nameWithoutExtension.removePrefix("artwork-") !in protectedKeys
        }?.sortedWith(compareBy<File> { it.lastModified() }.thenBy { it.name }).orEmpty()
        var total = root.listFiles()?.filter { it.isFile && it.extension == "jpg" }?.sumOf { it.length() } ?: 0L
        candidates.forEach { file ->
            if (total <= MAX_CACHE_BYTES) return@forEach
            val bytes = file.length()
            if (file.delete()) {
                total -= bytes
                File(file.parentFile, "${file.name}.meta").delete()
            }
        }
    }

    private fun revisionFile(target: File): File = File(target.parentFile, "${target.name}.meta")

    private fun revisionMatches(target: File, revision: String?): Boolean {
        val requested = revision?.trim().orEmpty()
        if (requested.isEmpty()) return true
        return runCatching { revisionFile(target).readText(Charsets.UTF_8) == requested }.getOrDefault(false)
    }

    private fun writeRevision(target: File, revision: String?) {
        val value = revision?.trim().orEmpty()
        if (value.isEmpty()) return
        val metadata = revisionFile(target)
        val temporary = File(target.parentFile, ".pending-${UUID.randomUUID()}.meta")
        try {
            temporary.writeText(value, Charsets.UTF_8)
            commitAtomic(temporary, metadata)
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun copyAtomic(source: File, target: File) {
        val temporary = File(target.parentFile, ".pending-artwork-${UUID.randomUUID()}.jpg")
        try {
            Files.copy(source.toPath(), temporary.toPath(), StandardCopyOption.REPLACE_EXISTING)
            if (temporary.length() <= 0L || temporary.length() > PlaybackArtworkPolicy.MAX_OUTPUT_BYTES) {
                throw IllegalStateException("Artwork output is invalid")
            }
            commitAtomic(temporary, target)
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun commitAtomic(temporary: File, target: File) {
        try {
            Files.move(
                temporary.toPath(),
                target.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: Throwable) {
            // Same-directory rename is still atomic on Android filesystems. Do
            // not delete the existing target if the replacement cannot commit.
            if (!temporary.renameTo(target)) throw IllegalStateException("Artwork could not be committed")
        }
    }

    internal fun isSharedFallback(context: android.content.Context, path: String): Boolean {
        val root = runCatching { artworkRoot(context) }.getOrNull() ?: return false
        val legacy = runCatching { File(context.noBackupFilesDir, LEGACY_DIRECTORY).canonicalFile }.getOrNull()
        return runCatching {
            File(path).canonicalFile == File(root, SHARED_FALLBACK_FILE).canonicalFile ||
                (legacy != null && File(path).canonicalFile == File(legacy, SHARED_FALLBACK_FILE).canonicalFile)
        }.getOrDefault(false)
    }

    private fun sharedFallback(root: File): String? {
        val target = File(root, SHARED_FALLBACK_FILE)
        return if (isValidArtwork(target)) target.absolutePath else writeFallback(target)
    }

    private fun isOwned(context: android.content.Context, file: File): Boolean {
        val root = runCatching { artworkRoot(context).path + File.separator }.getOrNull() ?: return false
        return runCatching { file.canonicalPath.startsWith(root) }.getOrDefault(false)
    }

    private fun isValidArtwork(file: File): Boolean {
        if (!file.isFile || file.length() <= 0L || file.length() > PlaybackArtworkPolicy.MAX_OUTPUT_BYTES) return false
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        return bounds.outWidth > 0 && bounds.outHeight > 0 &&
            bounds.outWidth <= PlaybackArtworkPolicy.MAX_OUTPUT_DIMENSION &&
            bounds.outHeight <= PlaybackArtworkPolicy.MAX_OUTPUT_DIMENSION
    }
}
