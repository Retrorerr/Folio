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
import java.util.UUID

/** Durable, bounded artwork conversion for Media3 metadata. */
internal object PlaybackArtworkStore {
    private const val SHARED_FALLBACK_FILE = "folio-fallback.jpg"

    fun prepare(
        context: android.content.Context,
        bookId: String,
        encoded: String?,
        mimeType: String?,
        reusablePath: String? = null,
    ): String? {
        return try {
            val appContext = context.applicationContext
            val root = artworkRoot(appContext)
            val reusable = reusablePath?.let { File(it) }
            if (reusable != null && isOwned(appContext, reusable) && isValidArtwork(reusable)) return reusable.absolutePath

            val fallback = { sharedFallback(root) }
            val normalizedBookId = bookId.trim()
            if (normalizedBookId.isEmpty()) return fallback()
            val target = File(root, "artwork-${PlaybackArtworkPolicy.artworkKey(normalizedBookId)}.jpg")
            val input = encoded?.trim().orEmpty()
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
            if (target.exists() && !target.delete()) throw IllegalStateException("Artwork could not be replaced")
            if (!temporary.renameTo(target)) throw IllegalStateException("Artwork could not be committed")
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

    private fun artworkRoot(context: android.content.Context): File = File(context.noBackupFilesDir, "folio-playback").apply {
        if ((!exists() && !mkdirs()) || !isDirectory) throw IllegalStateException("Artwork storage is unavailable")
    }.canonicalFile

    internal fun isSharedFallback(context: android.content.Context, path: String): Boolean {
        val root = runCatching { artworkRoot(context) }.getOrNull() ?: return false
        return runCatching { File(path).canonicalFile == File(root, SHARED_FALLBACK_FILE).canonicalFile }.getOrDefault(false)
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
