package com.folio.reader.mobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

internal data class PersistedEnqueue(
    val previousState: PlaybackQueueState,
    val newState: PlaybackQueueState,
    val item: PlaybackQueueItem,
    val discarded: List<PlaybackQueueItem>,
    val source: File,
)

/**
 * Synchronous, process-local serialization around the durable playback queue.
 * SharedPreferences uses an atomic file replacement, while the audio itself is
 * staged under noBackupFilesDir so Android cache eviction cannot break active
 * narration after the WebView or app process is reclaimed.
 */
internal object PlaybackStateStore {
    private const val PREFERENCES = "folio-playback"
    private const val KEY_STATE = "queue-state-v2"
    private const val DIRECTORY = "folio-playback"
    private const val MAX_QUEUE_ITEMS = 8
    private const val MAX_ITEM_BYTES = 128L * 1024L * 1024L
    private const val MAX_QUEUE_BYTES = 256L * 1024L * 1024L
    private const val ORPHAN_MAX_AGE_MS = 24L * 60L * 60L * 1000L
    private val lock = Any()

    fun load(context: Context): PlaybackQueueState = synchronized(lock) {
        readAndRepair(context.applicationContext)
    }

    fun enqueue(
        context: Context,
        sourcePath: String,
        title: String,
        artist: String,
        album: String,
        positionMs: Long,
        appendToActiveQueue: Boolean,
    ): PersistedEnqueue = enqueue(
        context = context,
        sourcePath = sourcePath,
        metadata = PlaybackMetadata(title = title, artist = artist, album = album),
        positionMs = positionMs,
        appendToActiveQueue = appendToActiveQueue,
    )

    fun enqueue(
        context: Context,
        sourcePath: String,
        metadata: PlaybackMetadata,
        positionMs: Long,
        appendToActiveQueue: Boolean,
    ): PersistedEnqueue = synchronized(lock) {
        val appContext = context.applicationContext
        val previous = readAndRepair(appContext)
        if (appendToActiveQueue && previous.items.size >= MAX_QUEUE_ITEMS) {
            throw IllegalStateException("Narration queue is full")
        }

        val source = File(sourcePath).canonicalFile
        if (!source.isFile || source.length() <= 0L) {
            throw IllegalStateException("Narration audio is missing or empty")
        }
        if (source.length() > MAX_ITEM_BYTES) {
            throw IllegalStateException("Narration audio is too large")
        }
        val retainedBytes = if (appendToActiveQueue) previous.items.sumOf { File(it.path).length() } else 0L
        if (retainedBytes + source.length() > MAX_QUEUE_BYTES) {
            throw IllegalStateException("Narration queue exceeds the local storage limit")
        }

        val sessionId = previous.nextSessionId + 1L
        val staged = stageAudio(appContext, source, sessionId)
        val reusableArtworkPath = if (metadata.bookId.isNotBlank() && (appendToActiveQueue || metadata.artworkBase64.isNullOrBlank())) {
            previous.items.firstOrNull { it.bookId == metadata.bookId && !it.artworkPath.isNullOrBlank() }?.artworkPath
        } else null
        val artworkPath = PlaybackArtworkStore.prepare(
            context = appContext,
            bookId = metadata.bookId,
            encoded = metadata.artworkBase64,
            mimeType = metadata.artworkMimeType,
            reusablePath = reusableArtworkPath,
        )
        val safeTitle = metadata.title.take(120).ifBlank { "Folio narration" }
        val safeArtist = metadata.artist.take(120).ifBlank { "Folio" }
        val safeAlbum = metadata.album.take(120).ifBlank { "Folio" }
        val safeFormat = metadata.format.take(24)
        val safeChapterTitle = metadata.chapterTitle.take(180)
        val safeDescription = metadata.description.take(240)
        val chapterIndex = metadata.chapterIndex.coerceAtLeast(0)
        val chapterCount = metadata.chapterCount.coerceAtLeast(0)
        val sentenceIndex = metadata.sentenceIndex.coerceAtLeast(0)
        val sentenceCount = metadata.sentenceCount.coerceAtLeast(0)
        val chunkProgress = metadata.chunkProgress.coerceIn(0f, 0.98f)
        val bookId = metadata.bookId.take(256)
        val locationUri = metadata.locationUri.take(2_048)
        val description = safeDescription.ifBlank {
            listOfNotNull(
                safeChapterTitle.takeIf { it.isNotBlank() },
                if (chapterCount > 0) "Chapter ${chapterIndex + 1} of $chapterCount" else null,
            ).joinToString(" · ")
        }
        val item = PlaybackQueueItem(
            sessionId = sessionId,
            path = staged.absolutePath,
            title = safeTitle,
            artist = safeArtist,
            album = safeAlbum,
            requestedPositionMs = positionMs.coerceAtLeast(0L),
            bookId = bookId,
            format = safeFormat,
            chapterTitle = safeChapterTitle,
            chapterIndex = chapterIndex,
            chapterCount = chapterCount,
            sentenceIndex = sentenceIndex,
            sentenceCount = sentenceCount,
            chunkProgress = chunkProgress,
            locationUri = locationUri,
            description = description,
            artworkPath = artworkPath,
        )
        val mutation = previous.enqueue(item, appendToActiveQueue)
        try {
            write(appContext, mutation.state)
        } catch (error: Throwable) {
            staged.delete()
            throw error
        }
        cleanupOrphans(appContext, referencedPaths(mutation.state.items))
        PersistedEnqueue(previous, mutation.state, item, mutation.discarded, source)
    }

    fun finalizeEnqueue(context: Context, enqueue: PersistedEnqueue) = synchronized(lock) {
        deleteOwned(context.applicationContext, enqueue.discarded, enqueue.newState.items)
        deletePrivateCacheSource(context.applicationContext, enqueue.source)
    }

    fun rollbackEnqueue(context: Context, enqueue: PersistedEnqueue) = synchronized(lock) {
        val appContext = context.applicationContext
        val current = read(appContext)
        if (current.items.any { it.sessionId == enqueue.item.sessionId }) {
            write(appContext, enqueue.previousState)
        }
        deleteOwned(appContext, listOf(enqueue.item), enqueue.previousState.items)
    }

    fun control(context: Context, action: String, positionMs: Long?): PlaybackQueueState = synchronized(lock) {
        val appContext = context.applicationContext
        val previous = readAndRepair(appContext)
        val updated = previous.control(action, positionMs)
        write(appContext, updated)
        if (action == "stop") deleteOwned(appContext, previous.items)
        updated
    }

    fun updateFromPlayer(
        context: Context,
        sessionId: Long,
        state: String,
        positionMs: Long,
        durationMs: Long,
        playWhenReady: Boolean,
        error: String? = null,
        synchronous: Boolean = false,
    ): PlaybackQueueState = synchronized(lock) {
        val appContext = context.applicationContext
        val previous = readAndRepair(appContext)
        val mutation = previous.advance(
            sessionId = sessionId,
            nextState = state,
            nextPositionMs = positionMs,
            nextDurationMs = durationMs,
            nextPlayWhenReady = playWhenReady,
            nextError = error,
        )
        write(appContext, mutation.state, synchronous)
        deleteOwned(appContext, mutation.discarded, mutation.state.items)
        mutation.state
    }

    fun finish(
        context: Context,
        sessionId: Long,
        positionMs: Long,
        durationMs: Long,
    ): PlaybackQueueState = terminal(context, "finished", sessionId, positionMs, durationMs, null)

    fun fail(
        context: Context,
        sessionId: Long,
        positionMs: Long,
        durationMs: Long,
        error: String,
    ): PlaybackQueueState = terminal(context, "error", sessionId, positionMs, durationMs, error)

    fun stop(context: Context, sessionId: Long, positionMs: Long, durationMs: Long): PlaybackQueueState =
        terminal(context, "stopped", sessionId, positionMs, durationMs, null)

    private fun terminal(
        context: Context,
        terminalState: String,
        sessionId: Long,
        positionMs: Long,
        durationMs: Long,
        error: String?,
    ): PlaybackQueueState = synchronized(lock) {
        val appContext = context.applicationContext
        val previous = readAndRepair(appContext)
        val updated = previous.copy(
            items = emptyList(),
            currentIndex = 0,
            state = terminalState,
            positionMs = positionMs.coerceAtLeast(0L),
            durationMs = durationMs.coerceAtLeast(0L),
            currentSessionId = sessionId,
            playWhenReady = false,
            error = error,
        )
        write(appContext, updated)
        deleteOwned(appContext, previous.items)
        updated
    }

    private fun readAndRepair(context: Context): PlaybackQueueState {
        val raw = read(context)
        val validItems = raw.items.mapNotNull { item ->
            val file = File(item.path)
            if (!isOwned(context, file) || !file.isFile || file.length() <= 0L) return@mapNotNull null
            val artworkPath = item.artworkPath?.let { path ->
                val artwork = File(path)
                if (isOwned(context, artwork) && artwork.isFile && artwork.length() > 0L) artwork.absolutePath else null
            }
            item.copy(artworkPath = artworkPath)
        }
        val indexedCurrent = validItems.getOrNull(raw.currentIndex)
        if (
            validItems == raw.items &&
            (validItems.isEmpty() || indexedCurrent?.sessionId == raw.currentSessionId)
        ) return raw

        val currentSession = raw.currentItem?.sessionId
        val repairedIndex = validItems.indexOfFirst { it.sessionId == currentSession }.coerceAtLeast(0)
        val repairedCurrent = validItems.getOrNull(repairedIndex)
        val repaired = if (validItems.isEmpty()) {
            raw.copy(
                items = emptyList(),
                currentIndex = 0,
                state = if (raw.state in setOf("playing", "preparing", "paused")) "error" else raw.state,
                playWhenReady = false,
                error = if (raw.state in setOf("playing", "preparing", "paused")) {
                    "Saved narration audio is no longer available"
                } else raw.error,
            )
        } else {
            raw.copy(
                items = validItems,
                currentIndex = repairedIndex,
                currentSessionId = repairedCurrent?.sessionId ?: raw.currentSessionId,
                positionMs = if (repairedCurrent?.sessionId == currentSession) raw.positionMs else repairedCurrent?.requestedPositionMs ?: 0L,
            )
        }
        write(context, repaired)
        cleanupOrphans(context, referencedPaths(validItems))
        return repaired
    }

    private fun read(context: Context): PlaybackQueueState {
        val encoded = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(KEY_STATE, null)
            ?: return PlaybackQueueState()
        return try {
            val json = JSONObject(encoded)
            val itemsJson = json.optJSONArray("items") ?: JSONArray()
            val items = buildList {
                for (index in 0 until itemsJson.length()) {
                    val item = itemsJson.optJSONObject(index) ?: continue
                    val sessionId = item.optLong("sessionId", 0L)
                    val path = item.optString("path", "")
                    if (sessionId <= 0L || path.isBlank()) continue
                    add(
                        PlaybackQueueItem(
                            sessionId = sessionId,
                            path = path,
                            title = item.optString("title", "Folio narration"),
                            artist = item.optString("artist", "Folio"),
                            album = item.optString("album", "Folio"),
                            requestedPositionMs = item.optLong("requestedPositionMs", 0L).coerceAtLeast(0L),
                            bookId = item.optString("bookId", ""),
                            format = item.optString("format", ""),
                            chapterTitle = item.optString("chapterTitle", ""),
                            chapterIndex = item.optInt("chapterIndex", 0).coerceAtLeast(0),
                            chapterCount = item.optInt("chapterCount", 0).coerceAtLeast(0),
                            sentenceIndex = item.optInt("sentenceIndex", 0).coerceAtLeast(0),
                            sentenceCount = item.optInt("sentenceCount", 0).coerceAtLeast(0),
                            chunkProgress = item.optDouble("chunkProgress", 0.0).toFloat().coerceIn(0f, 0.98f),
                            locationUri = item.optString("locationUri", ""),
                            description = item.optString("description", ""),
                            artworkPath = if (item.isNull("artworkPath")) null else item.optString("artworkPath", "").takeIf { it.isNotBlank() },
                        ),
                    )
                }
            }
            PlaybackQueueState(
                items = items,
                currentIndex = json.optInt("currentIndex", 0).coerceIn(0, (items.size - 1).coerceAtLeast(0)),
                state = json.optString("state", "idle"),
                positionMs = json.optLong("positionMs", 0L).coerceAtLeast(0L),
                durationMs = json.optLong("durationMs", 0L).coerceAtLeast(0L),
                currentSessionId = json.optLong("currentSessionId", 0L),
                nextSessionId = json.optLong("nextSessionId", 0L).coerceAtLeast(items.maxOfOrNull { it.sessionId } ?: 0L),
                playWhenReady = json.optBoolean("playWhenReady", false),
                error = if (json.isNull("error")) null else json.optString("error").takeIf { it.isNotBlank() },
            )
        } catch (_: Throwable) {
            PlaybackQueueState(state = "error", error = "Saved narration state could not be read")
        }
    }

    private fun write(context: Context, state: PlaybackQueueState, synchronous: Boolean = true) {
        val items = JSONArray()
        state.items.forEach { item ->
            items.put(
                JSONObject()
                    .put("sessionId", item.sessionId)
                    .put("path", item.path)
                    .put("title", item.title)
                    .put("artist", item.artist)
                    .put("album", item.album)
                    .put("requestedPositionMs", item.requestedPositionMs)
                    .put("bookId", item.bookId)
                    .put("format", item.format)
                    .put("chapterTitle", item.chapterTitle)
                    .put("chapterIndex", item.chapterIndex)
                    .put("chapterCount", item.chapterCount)
                    .put("sentenceIndex", item.sentenceIndex)
                    .put("sentenceCount", item.sentenceCount)
                    .put("chunkProgress", item.chunkProgress.toDouble())
                    .put("locationUri", item.locationUri)
                    .put("description", item.description)
                    .put("artworkPath", item.artworkPath ?: JSONObject.NULL),
            )
        }
        val json = JSONObject()
            .put("items", items)
            .put("currentIndex", state.currentIndex)
            .put("state", state.state)
            .put("positionMs", state.positionMs)
            .put("durationMs", state.durationMs)
            .put("currentSessionId", state.currentSessionId)
            .put("nextSessionId", state.nextSessionId)
            .put("playWhenReady", state.playWhenReady)
            .put("error", state.error ?: JSONObject.NULL)
        val editor = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_STATE, json.toString())
        if (synchronous) {
            if (!editor.commit()) throw IllegalStateException("Could not save narration state")
        } else {
            editor.apply()
        }
    }

    private fun stageAudio(context: Context, source: File, sessionId: Long): File {
        val root = playbackRoot(context)
        val temporary = File(root, ".pending-$sessionId-${UUID.randomUUID()}")
        val destination = File(root, "narration-$sessionId.wav")
        source.inputStream().buffered().use { input ->
            FileOutputStream(temporary).use { output ->
                input.copyTo(output, 64 * 1024)
                output.flush()
                output.fd.sync()
            }
        }
        if (temporary.length() != source.length()) {
            temporary.delete()
            throw IllegalStateException("Narration audio could not be staged completely")
        }
        if (destination.exists() && !destination.delete()) {
            temporary.delete()
            throw IllegalStateException("Could not replace staged narration audio")
        }
        if (!temporary.renameTo(destination)) {
            temporary.delete()
            throw IllegalStateException("Could not commit staged narration audio")
        }
        return destination
    }

    private fun playbackRoot(context: Context): File = File(context.noBackupFilesDir, DIRECTORY).apply {
        if ((!exists() && !mkdirs()) || !isDirectory) throw IllegalStateException("Narration storage is unavailable")
    }.canonicalFile

    private fun isOwned(context: Context, file: File): Boolean {
        val root = playbackRoot(context).path + File.separator
        return runCatching { file.canonicalPath.startsWith(root) }.getOrDefault(false)
    }

    private fun deleteOwned(
        context: Context,
        items: Collection<PlaybackQueueItem>,
        retained: Collection<PlaybackQueueItem> = emptyList(),
    ) {
        val referenced = referencedPaths(retained)
        items.forEach { item ->
            listOfNotNull(item.path, item.artworkPath).forEach { path ->
                val file = File(path)
                if (path !in referenced && !PlaybackArtworkStore.isSharedFallback(context, path) && isOwned(context, file)) runCatching { file.delete() }
            }
        }
    }

    private fun referencedPaths(items: Collection<PlaybackQueueItem>): Set<String> = buildSet {
        items.forEach { item ->
            add(item.path)
            item.artworkPath?.let(::add)
        }
    }

    private fun deletePrivateCacheSource(context: Context, source: File) {
        val cacheRoot = context.cacheDir.canonicalPath + File.separator
        if (runCatching { source.canonicalPath.startsWith(cacheRoot) }.getOrDefault(false)) {
            runCatching { source.delete() }
        }
    }

    private fun cleanupOrphans(context: Context, referencedPaths: Set<String>) {
        val cutoff = System.currentTimeMillis() - ORPHAN_MAX_AGE_MS
        playbackRoot(context).listFiles()?.forEach { file ->
            if (file.name == "folio-fallback.jpg") return@forEach
            if (file.absolutePath !in referencedPaths && file.lastModified() < cutoff) runCatching { file.delete() }
        }
    }
}
