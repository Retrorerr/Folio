package com.folio.reader.mobile

import app.tauri.plugin.JSObject
import android.os.StatFs
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.net.URL
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

private class ModelDownloadCancelled : RuntimeException("Model download cancelled")
private class ModelDownloadHttpException(val statusCode: Int) :
    RuntimeException("Model source returned HTTP $statusCode")

internal class AndroidModelDownloader(private val modelManager: OnDeviceModelManager) {
    private val cancellations = ConcurrentHashMap<String, AtomicBoolean>()

    fun cancel(engine: String): Boolean {
        val token = cancellations[engine] ?: return false
        token.set(true)
        return true
    }

    fun download(engine: String): JSObject {
        val assets = AndroidModelCatalog.assets(engine)
        val trusted = modelManager.expectedAssets(engine)
        val totalBytes = assets.sumOf { trusted[it.path]?.size ?: 0L }
        val result = JSObject().apply {
            put("engine", engine)
            put("started", true)
            put("totalBytes", totalBytes)
        }

        if (!modelManager.beginDownload(engine, totalBytes)) {
            return result.apply {
                put("started", false)
                put("state", modelManager.downloadState(engine)["state"] ?: "downloading")
                put("error", "A $engine model download is already running.")
            }
        }
        val cancellation = AtomicBoolean(false)
        cancellations[engine] = cancellation

        val target = modelManager.modelRoot(engine)
        val parent = target.parentFile ?: throw IllegalStateException("Model directory is unavailable")
        val staging = File(parent, ".${engine}.download-${UUID.randomUUID()}")
        var downloadedBytes = 0L
        try {
            if (!parent.isDirectory && !parent.mkdirs()) throw IllegalStateException("Could not create the model directory")
            val requiredBytes = totalBytes + (32L * 1024L * 1024L)
            val availableBytes = StatFs(parent.absolutePath).availableBytes
            if (availableBytes < requiredBytes) {
                throw IllegalStateException(
                    "Not enough device storage for $engine. Free at least ${(requiredBytes - availableBytes + 1024L * 1024L - 1L) / (1024L * 1024L)} MB and retry."
                )
            }
            if (!staging.mkdirs()) throw IllegalStateException("Could not create model-download staging")

            assets.forEach { asset ->
                if (cancellation.get()) throw ModelDownloadCancelled()
                val expected = trusted[asset.path]
                    ?: throw IllegalStateException("No trusted manifest entry exists for ${asset.path}")
                val destination = File(staging, asset.path)
                destination.parentFile?.let { directory ->
                    if (!directory.isDirectory && !directory.mkdirs()) {
                        throw IllegalStateException("Could not create model-download directory")
                    }
                }
                downloadedBytes += downloadAsset(
                    asset.url,
                    destination,
                    expected.size,
                    downloadedBytes,
                    totalBytes,
                    engine,
                    cancellation,
                )
            }

            if (cancellation.get()) throw ModelDownloadCancelled()
            modelManager.writeManifest(staging, engine)
            modelManager.markDownloadVerifying(engine, downloadedBytes, totalBytes)
            modelManager.installPack(engine, staging)
            modelManager.finishDownload(engine)
            result.put("installed", true)
            result.put("state", "ready")
            result.put("path", target.absolutePath)
        } catch (_: ModelDownloadCancelled) {
            val installed = runCatching { modelManager.installed(engine) }.getOrDefault(false)
            modelManager.cancelDownload(engine, installed)
            result.put("installed", installed)
            result.put("state", if (installed) "ready" else "not_installed")
            result.put("path", target.absolutePath)
            result.put("cancelled", true)
        } catch (error: Throwable) {
            val detail = actionableDownloadError(error)
            modelManager.failDownload(engine, detail)
            result.put("installed", false)
            result.put("state", "failed")
            result.put("path", target.absolutePath)
            result.put("error", detail.take(300))
        } finally {
            if (staging.exists()) staging.deleteRecursively()
            cancellations.remove(engine, cancellation)
        }
        return result
    }

    private fun actionableDownloadError(error: Throwable): String {
        val causes = generateSequence(error) { it.cause }.toList()
        val httpError = causes.filterIsInstance<ModelDownloadHttpException>().firstOrNull()
        return when {
            causes.any { it is UnknownHostException } -> "No network connection. Reconnect to the internet and retry the model download."
            causes.any { it is SocketTimeoutException } -> "The model download timed out. Check the connection and retry; partial files were cleaned up."
            httpError?.statusCode == 403 ->
                "The model host denied the transfer (HTTP 403). This is usually temporary; reconnect and tap Retry Download."
            httpError != null -> "The model host returned HTTP ${httpError.statusCode}. Retry the download in a moment."
            causes.any { it.message?.contains("ENOSPC", ignoreCase = true) == true || it.message?.contains("no space", ignoreCase = true) == true } ->
                "Android ran out of storage while downloading the model. Free space and retry."
            else -> causes.mapNotNull { it.message }.firstOrNull()?.take(300) ?: "Model download failed"
        }
    }

    private fun downloadAsset(
        url: String,
        destination: File,
        expectedBytes: Long,
        alreadyDownloaded: Long,
        totalBytes: Long,
        engine: String,
        cancellation: AtomicBoolean,
    ): Long {
        var lastError: Throwable? = null
        repeat(DOWNLOAD_ATTEMPTS) { attempt ->
            if (cancellation.get()) throw ModelDownloadCancelled()
            try {
                return downloadAssetOnce(
                    url,
                    destination,
                    expectedBytes,
                    alreadyDownloaded,
                    totalBytes,
                    engine,
                    cancellation,
                )
            } catch (error: Throwable) {
                if (error is ModelDownloadCancelled) throw error
                lastError = error
                destination.delete()
                if (!retryable(error) || attempt == DOWNLOAD_ATTEMPTS - 1) throw error
                val waitMs = RETRY_BASE_DELAY_MS * (attempt + 1L)
                val deadline = System.nanoTime() + waitMs * 1_000_000L
                while (System.nanoTime() < deadline) {
                    if (cancellation.get()) throw ModelDownloadCancelled()
                    Thread.sleep(100L)
                }
            }
        }
        throw lastError ?: IllegalStateException("Model download failed")
    }

    private fun retryable(error: Throwable): Boolean {
        val causes = generateSequence(error) { it.cause }.toList()
        val httpStatus = causes.filterIsInstance<ModelDownloadHttpException>().firstOrNull()?.statusCode
        return causes.any { it is SocketTimeoutException || it is UnknownHostException } ||
            httpStatus == 403 || httpStatus == 408 || httpStatus == 425 || httpStatus == 429 ||
            (httpStatus != null && httpStatus >= 500)
    }

    private fun downloadAssetOnce(
        url: String,
        destination: File,
        expectedBytes: Long,
        alreadyDownloaded: Long,
        totalBytes: Long,
        engine: String,
        cancellation: AtomicBoolean,
    ): Long {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 30_000
            readTimeout = 60_000
            instanceFollowRedirects = true
            useCaches = false
            requestMethod = "GET"
            setRequestProperty("Accept", "application/octet-stream")
            setRequestProperty("Accept-Encoding", "identity")
            setRequestProperty("Cache-Control", "no-cache")
            setRequestProperty("User-Agent", "Folio-Android-Model-Installer/1")
        }
        try {
            val response = connection.responseCode
            if (response !in 200..299) throw ModelDownloadHttpException(response)
            var written = 0L
            BufferedInputStream(connection.inputStream, 128 * 1024).use { input ->
                FileOutputStream(destination).use { output ->
                    val buffer = ByteArray(128 * 1024)
                    while (true) {
                        if (cancellation.get()) throw ModelDownloadCancelled()
                        val count = input.read(buffer)
                        if (count < 0) break
                        if (count == 0) continue
                        written += count
                        if (written > expectedBytes) {
                            throw IllegalStateException("Downloaded $engine asset is larger than its pinned size")
                        }
                        output.write(buffer, 0, count)
                        modelManager.updateDownload(
                            engine,
                            alreadyDownloaded + written,
                            totalBytes,
                        )
                    }
                }
            }
            if (written != expectedBytes) {
                throw IllegalStateException("Downloaded model asset is truncated (${written} bytes, expected $expectedBytes)")
            }
            return written
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val DOWNLOAD_ATTEMPTS = 3
        const val RETRY_BASE_DELAY_MS = 750L
    }
}
