package com.folio.reader.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import java.io.File

/**
 * Android's authoritative owner for Folio narration playback.
 *
 * The public companion API is intentionally kept stable for
 * [FolioMobilePlugin]. All player access is serialized on the service main
 * looper. Media3 owns audio focus, headset-disconnect handling, the foreground
 * media notification, lock-screen controls and media-button routing.
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
class FolioPlaybackService : MediaSessionService() {
    companion object {
        const val ACTION_PLAY = "com.folio.reader.mobile.PLAY"
        const val ACTION_PAUSE = "com.folio.reader.mobile.PAUSE"
        const val ACTION_RESUME = "com.folio.reader.mobile.RESUME"
        const val ACTION_STOP = "com.folio.reader.mobile.STOP"
        const val ACTION_SEEK = "com.folio.reader.mobile.SEEK"
        const val EXTRA_PATH = "audioPath"
        const val EXTRA_TITLE = "audioTitle"
        const val EXTRA_ARTIST = "audioArtist"
        const val EXTRA_ALBUM = "audioAlbum"
        const val EXTRA_POSITION_MS = "audioPositionMs"
        const val EXTRA_BOOK_ID = "folioBookId"
        const val EXTRA_CHAPTER_INDEX = "folioChapterIndex"
        const val EXTRA_SENTENCE_INDEX = "folioSentenceIndex"
        const val EXTRA_CHUNK_PROGRESS = "folioChunkProgress"
        const val EXTRA_LOCATION_URI = "folioLocationUri"

        private const val MAX_TRACK_TITLE = 120
        private const val SESSION_ACTIVITY_REQUEST_CODE = 9173
        private const val PLAYBACK_CHANNEL_NAME = "Folio narration"
        private const val PAUSED_SERVICE_TIMEOUT_MS = 10 * 60 * 1_000L
        private const val POSITION_UPDATE_INTERVAL_MS = 100L
        private const val DURABLE_CHECKPOINT_INTERVAL_MS = 2_000L
        private val lock = Any()
        private var service: FolioPlaybackService? = null
        private var snapshotInitialized = false
        private var snapshotValue = PlaybackSnapshot("idle", 0L, 0L, 0L, null, emptyList(), 0, 0L)

        data class PlaybackSnapshot(
            val state: String,
            val positionMs: Long,
            val durationMs: Long,
            val sessionId: Long,
            val error: String?,
            val queueSessionIds: List<Long>,
            val currentIndex: Int,
            val enqueuedSessionId: Long,
            val queueLocations: List<PlaybackQueueLocation> = emptyList(),
            val bookId: String? = null,
            val format: String? = null,
            val chapterTitle: String? = null,
            val chapterIndex: Int? = null,
            val chapterCount: Int? = null,
            val sentenceIndex: Int? = null,
            val sentenceCount: Int? = null,
            val chunkProgress: Float? = null,
            val locationUri: String? = null,
        )

        fun enqueue(
            context: Context,
            path: String,
            title: String?,
            artist: String?,
            album: String?,
            positionMs: Long,
            appendToActiveQueue: Boolean,
        ): PlaybackSnapshot = enqueue(
            context = context,
            path = path,
            metadata = PlaybackMetadata(
                title = title.orEmpty(),
                artist = artist.orEmpty(),
                album = album.orEmpty(),
            ),
            positionMs = positionMs,
            appendToActiveQueue = appendToActiveQueue,
        )

        fun enqueue(
            context: Context,
            path: String,
            metadata: PlaybackMetadata,
            positionMs: Long,
            appendToActiveQueue: Boolean,
        ): PlaybackSnapshot {
            val appContext = context.applicationContext
            initializeSnapshot(appContext)
            val persisted = PlaybackStateStore.enqueue(
                context = appContext,
                sourcePath = path,
                metadata = metadata.copy(
                    title = metadata.title.take(MAX_TRACK_TITLE).ifBlank { "Folio narration" },
                    artist = metadata.artist.take(MAX_TRACK_TITLE).ifBlank { "Folio" },
                    album = metadata.album.take(MAX_TRACK_TITLE).ifBlank { "Folio" },
                ),
                positionMs = positionMs,
                appendToActiveQueue = appendToActiveQueue,
            )

            setSnapshot(persisted.newState.toSnapshot())
            return try {
                appContext.startService(
                    Intent(appContext, FolioPlaybackService::class.java).setAction(ACTION_PLAY),
                ) ?: throw IllegalStateException("Narration service could not be started")
                PlaybackStateStore.finalizeEnqueue(appContext, persisted)
                snapshot().copy(enqueuedSessionId = persisted.item.sessionId)
            } catch (error: Throwable) {
                PlaybackStateStore.rollbackEnqueue(appContext, persisted)
                setSnapshot(persisted.previousState.toSnapshot())
                throw error
            }
        }

        fun control(context: Context, action: String, positionMs: Long?) {
            val appContext = context.applicationContext
            initializeSnapshot(appContext)
            val intentAction = actionToIntent(action)
            val persisted = PlaybackStateStore.control(appContext, action, positionMs)
            setSnapshot(persisted.toSnapshot())
            val running = synchronized(lock) { service }
            if (running != null) {
                running.dispatchControl(intentAction, positionMs)
                return
            }
            if (action != "resume" || persisted.items.isEmpty()) return

            try {
                appContext.startService(
                    Intent(appContext, FolioPlaybackService::class.java).setAction(ACTION_RESUME),
                ) ?: throw IllegalStateException("Narration service could not be started")
            } catch (error: Throwable) {
                val failed = PlaybackStateStore.control(appContext, "pause", null).copy(
                    state = "error",
                    error = error.message ?: "Narration service could not be started",
                )
                setSnapshot(failed.toSnapshot())
                throw error
            }
        }

        fun snapshot(): PlaybackSnapshot = synchronized(lock) { snapshotValue }

        internal fun refreshArtwork(state: PlaybackQueueState) {
            val running = synchronized(lock) { service } ?: return
            running.mainHandler.post { running.applyArtworkState(state) }
        }

        internal fun initializeSnapshot(context: Context) {
            if (synchronized(lock) { snapshotInitialized }) return
            val restored = runCatching { PlaybackStateStore.load(context.applicationContext).toSnapshot() }
                .getOrElse {
                    PlaybackSnapshot(
                        state = "error",
                        positionMs = 0L,
                        durationMs = 0L,
                        sessionId = 0L,
                        error = it.message ?: "Saved narration state could not be loaded",
                        queueSessionIds = emptyList(),
                        currentIndex = 0,
                        enqueuedSessionId = 0L,
                    )
                }
            synchronized(lock) {
                if (!snapshotInitialized) {
                    snapshotValue = restored
                    snapshotInitialized = true
                }
            }
        }

        private fun actionToIntent(action: String): String = when (action) {
            "pause" -> ACTION_PAUSE
            "resume" -> ACTION_RESUME
            "seek" -> ACTION_SEEK
            else -> ACTION_STOP
        }

        private fun setSnapshot(snapshot: PlaybackSnapshot) {
            synchronized(lock) {
                snapshotValue = snapshot
                snapshotInitialized = true
            }
        }

        private fun PlaybackQueueState.toSnapshot(): PlaybackSnapshot {
            val current = currentItem
            return PlaybackSnapshot(
            state = state,
            positionMs = positionMs,
            durationMs = durationMs,
            sessionId = currentSessionId,
            error = error,
            queueSessionIds = items.map { it.sessionId },
            queueLocations = queueLocations(),
            currentIndex = currentIndex,
            enqueuedSessionId = 0L,
                bookId = current?.bookId?.takeIf { it.isNotBlank() },
                format = current?.format?.takeIf { it.isNotBlank() },
                chapterTitle = current?.chapterTitle?.takeIf { it.isNotBlank() },
                chapterIndex = current?.chapterIndex,
                chapterCount = current?.chapterCount,
                sentenceIndex = current?.sentenceIndex,
                sentenceCount = current?.sentenceCount,
                chunkProgress = if (current != null) authoritativeChunkProgress() else null,
                locationUri = current?.locationUri?.takeIf { it.isNotBlank() },
            )
        }
    }

    private lateinit var player: ExoPlayer
    private var mediaSession: MediaSession? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var reconcilingQueue = false
    private var handlingTerminalState = false
    private var lastDurableCheckpointMs = 0L
    private var pendingRestorePositionMs: Long? = null
    private var queueByMediaId: Map<String, PlaybackQueueItem> = emptyMap()

    private val positionTicker = object : Runnable {
        override fun run() {
            if (!::player.isInitialized || !player.isPlaying) return
            publishPlayerState("playing", persist = shouldCheckpoint())
            mainHandler.postDelayed(this, POSITION_UPDATE_INTERVAL_MS)
        }
    }
    private val pausedServiceTimeout = Runnable {
        if (
            ::player.isInitialized &&
            !player.isPlaying &&
            player.mediaItemCount > 0 &&
            snapshot().state == "paused"
        ) {
            leaveForegroundPlayback()
            stopSelf()
        }
    }

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            if (reconcilingQueue || handlingTerminalState) return
            when (playbackState) {
                Player.STATE_BUFFERING -> publishPlayerState("preparing", persist = true)
                Player.STATE_READY -> {
                    pendingRestorePositionMs?.let { restoredPosition ->
                        if (player.currentPosition + 250L < restoredPosition) player.seekTo(restoredPosition)
                    }
                    publishPlayerState(if (player.isPlaying) "playing" else "paused", persist = true)
                }
                Player.STATE_ENDED -> finishPlayback()
                Player.STATE_IDLE -> if (player.mediaItemCount > 0) stopPlayback()
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (reconcilingQueue || handlingTerminalState || player.mediaItemCount == 0) return
            mainHandler.removeCallbacks(positionTicker)
            publishPlayerState(if (isPlaying) "playing" else stateWhileNotPlaying(), persist = true)
            if (isPlaying) mainHandler.post(positionTicker)
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            if (reconcilingQueue || handlingTerminalState || mediaItem == null) return
            val item = queueByMediaId[mediaItem.mediaId] ?: return
            val requestedPosition = pendingRestorePositionMs ?: item.requestedPositionMs.takeIf { it > 0L }
            if (requestedPosition != null && player.currentPosition + 250L < requestedPosition) {
                player.seekTo(requestedPosition)
            }
            updateSessionActivity(item)
            publishPlayerState("preparing", persist = true)
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            if (
                playWhenReady &&
                !reconcilingQueue &&
                !handlingTerminalState &&
                player.mediaItemCount > 0 &&
                player.playbackState == Player.STATE_IDLE
            ) {
                player.prepare()
            }
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int,
        ) {
            if (!reconcilingQueue && !handlingTerminalState) publishPlayerState(currentPlayerState(), persist = true)
        }

        override fun onPlayerError(error: PlaybackException) {
            failPlayback(error.errorCodeName + (error.message?.let { ": $it" } ?: ""))
        }
    }

    override fun onCreate() {
        super.onCreate()
        synchronized(lock) { service = this }
        ensurePlaybackNotificationChannel()

        player = ExoPlayer.Builder(this)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                    .build(),
                true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()
            .also { it.addListener(playerListener) }

        val sessionBuilder = MediaSession.Builder(this, player)
        sessionActivityPendingIntent(null)?.let(sessionBuilder::setSessionActivity)
        DefaultMediaNotificationProvider.Builder(this)
            .setNotificationId(DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID)
            .setChannelId(DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID)
            .build()
            .also { provider ->
                provider.setSmallIcon(R.drawable.ic_folio_notification)
                setMediaNotificationProvider(provider)
            }
        mediaSession = sessionBuilder.build().also(::addSession)

        val restored = PlaybackStateStore.load(this)
        setSnapshot(restored.toSnapshot())
        reconcileQueue(restored, allowPlayback = false, publishAfterReconcile = false)
        updateSessionActivity(restored.authoritativeCurrentItem())
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) {
        // Android may stop a target-36 service as soon as Media3 demotes it in
        // the background. Keep a prepared, paused queue foreground for the
        // same bounded user-engagement window as Media3 so the notification's
        // Resume action remains usable. Terminal paths clear the queue first.
        val keepPausedControls =
            ::player.isInitialized &&
            player.mediaItemCount > 0 &&
            !player.playWhenReady &&
            player.playbackState != Player.STATE_IDLE &&
            player.playbackState != Player.STATE_ENDED
        super.onUpdateNotification(session, startInForegroundRequired || keepPausedControls)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val restoredForRestart = if (intent == null) PlaybackStateStore.load(this) else null
        // App-originated commands start this service while Folio is in the
        // foreground. The registered MediaSession then owns the foreground
        // transition and its authenticated self-start intent. Starting Folio's
        // custom action with startForegroundService() would bypass that Media3
        // lifecycle and make later notification actions appear stale.
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            ACTION_PLAY -> reconcileQueue(PlaybackStateStore.load(this), allowPlayback = true)
            ACTION_PAUSE -> pausePlayback()
            ACTION_RESUME -> resumePlayback()
            ACTION_STOP -> stopPlayback()
            ACTION_SEEK -> seekPlayback(intent.getLongExtra(EXTRA_POSITION_MS, 0L))
            null -> {
                // A non-null, actionless intent is Media3's authenticated
                // self-start used to own foreground notification state. It has
                // already been handled by super and must not be mistaken for
                // Android recreating a sticky service with a genuinely null
                // intent.
                if (intent != null) return START_STICKY
                val restored = checkNotNull(restoredForRestart)
                if (!restored.playWhenReady || restored.items.isEmpty()) {
                    setSnapshot(restored.toSnapshot())
                    leaveForegroundPlayback()
                    stopSelf(startId)
                    return START_NOT_STICKY
                }
                reconcileQueue(restored, allowPlayback = true)
            }
        }
        return START_STICKY
    }

    private fun ensurePlaybackNotificationChannel() {
        val notificationManager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            notificationManager.createNotificationChannel(
                NotificationChannel(
                    DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID,
                    PLAYBACK_CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Playback controls for Folio narration"
                    setShowBadge(false)
                },
            )
        }
    }

    private fun dispatchControl(action: String, positionMs: Long?) {
        val command = Runnable {
            when (action) {
                ACTION_PAUSE -> pausePlayback()
                ACTION_RESUME -> resumePlayback()
                ACTION_STOP -> stopPlayback()
                ACTION_SEEK -> seekPlayback(positionMs ?: 0L)
            }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) command.run() else mainHandler.post(command)
    }

    private fun reconcileQueue(
        stored: PlaybackQueueState,
        allowPlayback: Boolean,
        publishAfterReconcile: Boolean = true,
    ) {
        check(Looper.myLooper() == Looper.getMainLooper()) { "Playback queue must be reconciled on the main looper" }
        reconcilingQueue = true
        try {
            if (stored.items.isEmpty()) {
                if (player.mediaItemCount > 0) player.clearMediaItems()
                queueByMediaId = emptyMap()
                setSnapshot(stored.toSnapshot())
                updateSessionActivity(null)
                return
            }

            queueByMediaId = stored.items.associateBy { it.sessionId.toString() }
            val storedIds = stored.items.map { it.sessionId.toString() }
            val playerIds = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }
            when {
                playerIds == storedIds -> Unit
                storedIds.size > playerIds.size && storedIds.take(playerIds.size) == playerIds -> {
                    player.addMediaItems(stored.items.drop(playerIds.size).map(::mediaItem))
                }
                playerIds.isNotEmpty() && storedIds.isNotEmpty() && playerIds.indexOf(storedIds.first()).let { start ->
                    start >= 0 && storedIds.take(playerIds.size - start) == playerIds.drop(start)
                } -> {
                    val start = playerIds.indexOf(storedIds.first())
                    if (start > 0) player.removeMediaItems(0, start)
                    val retained = playerIds.size - start
                    if (storedIds.size > retained) player.addMediaItems(stored.items.drop(retained).map(::mediaItem))
                }
                else -> {
                    pendingRestorePositionMs = stored.positionMs.takeIf { it > 0L }
                    player.setMediaItems(
                        stored.items.map(::mediaItem),
                        stored.currentIndex.coerceIn(0, stored.items.lastIndex),
                        stored.positionMs,
                    )
                }
            }
            if (allowPlayback) {
                pendingRestorePositionMs?.let { restoredPosition ->
                    player.seekTo(stored.currentIndex.coerceIn(0, stored.items.lastIndex), restoredPosition)
                }
                if (player.playbackState == Player.STATE_IDLE || player.playbackState == Player.STATE_ENDED) player.prepare()
                if (stored.playWhenReady) player.play() else player.pause()
            } else {
                player.pause()
            }
        } finally {
            reconcilingQueue = false
        }
        updateSessionActivity(stored.authoritativeCurrentItem())
        if (publishAfterReconcile) {
            publishPlayerState(if (player.isPlaying) "playing" else if (player.playWhenReady) "preparing" else "paused", persist = true)
        }
    }

    private fun resumePlayback() {
        val stored = PlaybackStateStore.load(this)
        if (player.mediaItemCount == 0) reconcileQueue(stored, allowPlayback = true)
        if (player.mediaItemCount == 0) return
        if (player.playbackState == Player.STATE_IDLE || player.playbackState == Player.STATE_ENDED) player.prepare()
        pendingRestorePositionMs?.let { restoredPosition ->
            player.seekTo(stored.currentIndex.coerceIn(0, stored.items.lastIndex), restoredPosition)
        }
        player.play()
        publishPlayerState("preparing", persist = true)
    }

    private fun pausePlayback() {
        if (player.mediaItemCount == 0) return
        player.pause()
        publishPlayerState("paused", persist = true)
    }

    private fun seekPlayback(requestedPositionMs: Long) {
        if (player.mediaItemCount == 0) return
        pendingRestorePositionMs = null
        val duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0L } ?: Long.MAX_VALUE
        player.seekTo(requestedPositionMs.coerceIn(0L, duration))
        publishPlayerState(currentPlayerState(), persist = true)
    }

    private fun stopPlayback() {
        terminalPlayerValues().let { (sessionId, position, duration) ->
            handlingTerminalState = true
            mainHandler.removeCallbacks(positionTicker)
            val stopped = PlaybackStateStore.stop(this, sessionId, position, duration)
            setSnapshot(stopped.toSnapshot())
            player.stop()
            player.clearMediaItems()
            queueByMediaId = emptyMap()
            handlingTerminalState = false
            updateSessionActivity(null)
        }
        leaveForegroundPlayback()
        stopSelf()
    }

    private fun finishPlayback() {
        val (sessionId, position, duration) = terminalPlayerValues()
        handlingTerminalState = true
        mainHandler.removeCallbacks(positionTicker)
        val finishedPosition = maxOf(position, duration)
        val finished = PlaybackStateStore.finish(this, sessionId, finishedPosition, duration)
        setSnapshot(finished.toSnapshot())
        player.clearMediaItems()
        queueByMediaId = emptyMap()
        handlingTerminalState = false
        updateSessionActivity(null)
        leaveForegroundPlayback()
        stopSelf()
    }

    private fun failPlayback(message: String) {
        val (sessionId, position, duration) = terminalPlayerValues()
        handlingTerminalState = true
        mainHandler.removeCallbacks(positionTicker)
        val failed = PlaybackStateStore.fail(this, sessionId, position, duration, message)
        setSnapshot(failed.toSnapshot())
        player.stop()
        player.clearMediaItems()
        queueByMediaId = emptyMap()
        handlingTerminalState = false
        updateSessionActivity(null)
        leaveForegroundPlayback()
        stopSelf()
    }

    private fun leaveForegroundPlayback() {
        stopForeground(android.app.Service.STOP_FOREGROUND_REMOVE)
        getSystemService(NotificationManager::class.java)
            .cancel(DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID)
    }

    private fun publishPlayerState(state: String, persist: Boolean) {
        val current = currentQueueItem() ?: return
        val rawPosition = player.currentPosition.coerceAtLeast(0L)
        val restoredPosition = pendingRestorePositionMs
        val position = if (
            restoredPosition != null &&
            rawPosition + 250L < restoredPosition &&
            (state == "preparing" || state == "playing")
        ) {
            // ExoPlayer can transiently report zero while resolving a restored
            // seek. Do not overwrite the durable checkpoint before the seek is
            // applied, or a Media3 self-start intent will restart from zero.
            restoredPosition
        } else {
            rawPosition
        }
        if (restoredPosition != null && state == "playing" && rawPosition + 250L >= restoredPosition) {
            pendingRestorePositionMs = null
        }
        val duration = player.duration.takeIf { it != C.TIME_UNSET }?.coerceAtLeast(0L) ?: snapshot().durationMs
        if (persist) {
            val stored = PlaybackStateStore.updateFromPlayer(
                context = this,
                sessionId = current.sessionId,
                state = state,
                positionMs = position,
                durationMs = duration,
                playWhenReady = player.playWhenReady,
                synchronous = state == "paused",
                preserveTransientZero = pendingRestorePositionMs != null || state == "preparing",
            )
            setSnapshot(stored.toSnapshot())
            updateSessionActivity(stored.authoritativeCurrentItem())
            lastDurableCheckpointMs = android.os.SystemClock.elapsedRealtime()
        } else {
            val latest = snapshot()
            val progress = if (duration > 0L) {
                (position.toDouble() / duration.toDouble()).toFloat().coerceIn(0f, 0.98f)
            } else {
                latest.chunkProgress?.coerceIn(0f, 0.98f) ?: 0f
            }
            setSnapshot(
                latest.copy(
                    state = state,
                    positionMs = position,
                    durationMs = duration,
                    sessionId = current.sessionId,
                    error = null,
                    chunkProgress = progress,
                ),
            )
            updateSessionActivity(current.copy(chunkProgress = progress))
        }
        mainHandler.removeCallbacks(pausedServiceTimeout)
        if (state == "paused") mainHandler.postDelayed(pausedServiceTimeout, PAUSED_SERVICE_TIMEOUT_MS)
    }

    private fun currentQueueItem(): PlaybackQueueItem? {
        val mediaId = player.currentMediaItem?.mediaId ?: return null
        return queueByMediaId[mediaId]
    }

    private fun applyArtworkState(state: PlaybackQueueState) {
        if (!::player.isInitialized || state.items.isEmpty()) return
        val byId = state.items.associateBy { it.sessionId.toString() }
        queueByMediaId = byId
        val limit = minOf(player.mediaItemCount, state.items.size)
        for (index in 0 until limit) {
            val mediaId = player.getMediaItemAt(index).mediaId
            val item = byId[mediaId] ?: continue
            player.replaceMediaItem(index, mediaItem(item))
        }
        setSnapshot(state.toSnapshot())
        updateSessionActivity(state.authoritativeCurrentItem())
    }

    private fun terminalPlayerValues(): Triple<Long, Long, Long> {
        val current = currentQueueItem()
        val latest = snapshot()
        val duration = player.duration.takeIf { it != C.TIME_UNSET }?.coerceAtLeast(0L) ?: latest.durationMs
        return Triple(current?.sessionId ?: latest.sessionId, player.currentPosition.coerceAtLeast(0L), duration)
    }

    private fun mediaItem(item: PlaybackQueueItem): MediaItem {
        val description = item.description.ifBlank {
            listOfNotNull(
                item.chapterTitle.takeIf { it.isNotBlank() },
                if (item.chapterCount > 0) "Chapter ${item.chapterIndex + 1} of ${item.chapterCount}" else null,
            ).joinToString(" · ")
        }
        val metadata = MediaMetadata.Builder()
            .setTitle(item.title)
            .setDisplayTitle(item.title)
            .setArtist(item.artist)
            .setAlbumTitle(item.album)
            .setSubtitle(item.chapterTitle.takeIf { it.isNotBlank() })
            .setDescription(description.takeIf { it.isNotBlank() })
            .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK_CHAPTER)
            .setTrackNumber((item.chapterIndex + 1).takeIf { item.chapterCount > 0 })
            .setTotalTrackCount(item.chapterCount.takeIf { it > 0 })
            .setIsPlayable(true)
        item.artworkPath?.let { path ->
            val artwork = File(path)
            if (artwork.isFile && artwork.length() > 0L) metadata.setArtworkUri(Uri.fromFile(artwork))
        }
        return MediaItem.Builder()
            .setMediaId(item.sessionId.toString())
            .setUri(Uri.fromFile(File(item.path)))
            .setMimeType(MimeTypes.AUDIO_WAV)
            .setMediaMetadata(metadata.build())
            .build()
    }

    private fun stateWhileNotPlaying(): String = when (player.playbackState) {
        Player.STATE_BUFFERING -> "preparing"
        Player.STATE_READY -> "paused"
        else -> currentPlayerState()
    }

    private fun currentPlayerState(): String = when {
        player.isPlaying -> "playing"
        player.playbackState == Player.STATE_BUFFERING -> "preparing"
        player.playbackState == Player.STATE_ENDED -> "finished"
        else -> "paused"
    }

    private fun shouldCheckpoint(): Boolean =
        android.os.SystemClock.elapsedRealtime() - lastDurableCheckpointMs >= DURABLE_CHECKPOINT_INTERVAL_MS

    private fun sessionActivityIntent(item: PlaybackQueueItem?): Intent? =
        packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            if (!item?.bookId.isNullOrBlank()) {
                putExtra(EXTRA_BOOK_ID, item?.bookId)
                putExtra(EXTRA_CHAPTER_INDEX, item?.chapterIndex ?: 0)
                putExtra(EXTRA_SENTENCE_INDEX, item?.sentenceIndex ?: 0)
                putExtra(EXTRA_CHUNK_PROGRESS, item?.chunkProgress ?: 0f)
                putExtra(EXTRA_LOCATION_URI, item?.locationUri.orEmpty())
            }
        }

    private fun sessionActivityPendingIntent(item: PlaybackQueueItem?): PendingIntent? =
        sessionActivityIntent(item)?.let { launchIntent ->
            PendingIntent.getActivity(this, SESSION_ACTIVITY_REQUEST_CODE, launchIntent, pendingIntentFlags())
        }

    private fun updateSessionActivity(item: PlaybackQueueItem?) {
        val session = mediaSession ?: return
        sessionActivityPendingIntent(item)?.let(session::setSessionActivity)
    }

    private fun pendingIntentFlags(): Int = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE


    override fun onDestroy() {
        mainHandler.removeCallbacks(positionTicker)
        mainHandler.removeCallbacks(pausedServiceTimeout)
        if (::player.isInitialized && player.mediaItemCount > 0 && !handlingTerminalState) {
            publishPlayerState(if (player.isPlaying) "playing" else stateWhileNotPlaying(), persist = true)
        }
        mediaSession?.let { session ->
            if (isSessionAdded(session)) removeSession(session)
            session.release()
        }
        mediaSession = null
        if (::player.isInitialized) {
            player.removeListener(playerListener)
            player.release()
        }
        synchronized(lock) {
            if (service === this) service = null
        }
        super.onDestroy()
    }
}
