package com.folio.reader.mobile

internal data class PlaybackQueueItem(
    val sessionId: Long,
    val path: String,
    val title: String,
    val artist: String,
    val album: String,
    val requestedPositionMs: Long,
    val bookId: String = "",
    val format: String = "",
    val chapterTitle: String = "",
    val chapterIndex: Int = 0,
    val chapterCount: Int = 0,
    val sentenceIndex: Int = 0,
    val sentenceCount: Int = 0,
    val chunkProgress: Float = 0f,
    val locationUri: String = "",
    val description: String = "",
    val artworkPath: String? = null,
    // Durable player checkpoints. Missing JSON fields safely decode to zero.
    val lastPositionMs: Long = 0L,
    val lastDurationMs: Long = 0L,
)

internal data class PlaybackQueueState(
    val items: List<PlaybackQueueItem> = emptyList(),
    val currentIndex: Int = 0,
    val state: String = "idle",
    val positionMs: Long = 0L,
    val durationMs: Long = 0L,
    val currentSessionId: Long = 0L,
    val nextSessionId: Long = 0L,
    val playWhenReady: Boolean = false,
    val error: String? = null,
) {
    val currentItem: PlaybackQueueItem?
        get() = items.getOrNull(currentIndex.coerceIn(0, (items.size - 1).coerceAtLeast(0)))

    fun enqueue(item: PlaybackQueueItem, appendToActiveQueue: Boolean): PlaybackQueueMutation {
        if (appendToActiveQueue && items.isNotEmpty()) {
            return PlaybackQueueMutation(
                state = copy(
                    items = items + item,
                    nextSessionId = maxOf(nextSessionId, item.sessionId),
                ),
                discarded = emptyList(),
            )
        }

        return PlaybackQueueMutation(
            state = PlaybackQueueState(
                items = listOf(item),
                currentIndex = 0,
                state = "preparing",
                positionMs = item.requestedPositionMs.coerceAtLeast(0L),
                durationMs = 0L,
                currentSessionId = item.sessionId,
                nextSessionId = maxOf(nextSessionId, item.sessionId),
                playWhenReady = true,
                error = null,
            ),
            discarded = items,
        )
    }

    fun advance(
        sessionId: Long,
        nextState: String,
        nextPositionMs: Long,
        nextDurationMs: Long,
        nextPlayWhenReady: Boolean,
        nextError: String?,
        preserveTransientZero: Boolean = false,
    ): PlaybackQueueMutation {
        val index = items.indexOfFirst { it.sessionId == sessionId }
        if (index < 0) return PlaybackQueueMutation(this, emptyList())
        val current = items[index]
        val previousPosition = if (currentSessionId == sessionId) {
            maxOf(current.lastPositionMs, positionMs)
        } else {
            current.lastPositionMs
        }
        val previousDuration = if (currentSessionId == sessionId) durationMs else 0L
        val safeDuration = if (nextDurationMs > 0L) nextDurationMs else maxOf(current.lastDurationMs, previousDuration)
        val reportedPosition = nextPositionMs.coerceAtLeast(0L)
        val safePosition = if (preserveTransientZero && reportedPosition == 0L && previousPosition > 0L) previousPosition else reportedPosition
        val safeProgress = if (safeDuration > 0L && !(preserveTransientZero && reportedPosition == 0L && previousPosition > 0L)) {
            (safePosition.toDouble() / safeDuration.toDouble()).toFloat().coerceIn(0f, 0.98f)
        } else {
            current.chunkProgress.coerceIn(0f, 0.98f)
        }
        val checkpointedCurrent = current.copy(
            chunkProgress = safeProgress,
            lastPositionMs = safePosition,
            lastDurationMs = safeDuration,
        )
        val remaining = items.drop(index).let { list -> listOf(checkpointedCurrent) + list.drop(1) }
        return PlaybackQueueMutation(
            state = copy(
                items = remaining,
                currentIndex = 0,
                state = nextState,
                positionMs = safePosition,
                durationMs = safeDuration.coerceAtLeast(0L),
                currentSessionId = sessionId,
                playWhenReady = nextPlayWhenReady,
                error = nextError,
            ),
            discarded = items.take(index),
        )
    }

    fun control(action: String, requestedPositionMs: Long?): PlaybackQueueState = when (action) {
        "pause" -> if (items.isEmpty()) this else copy(state = "paused", playWhenReady = false, error = null)
        "resume" -> if (items.isEmpty()) this else copy(state = "preparing", playWhenReady = true, error = null)
        "seek" -> {
            val upperBound = durationMs.takeIf { it > 0L } ?: Long.MAX_VALUE
            val position = (requestedPositionMs ?: 0L).coerceIn(0L, upperBound)
            val updatedItems = if (currentItem == null) items else items.mapIndexed { index, item ->
                if (index != currentIndex) item else item.copy(
                    chunkProgress = if (durationMs > 0L) (position.toDouble() / durationMs).toFloat().coerceIn(0f, 0.98f) else item.chunkProgress,
                    lastPositionMs = position,
                    lastDurationMs = maxOf(item.lastDurationMs, durationMs),
                )
            }
            copy(items = updatedItems, positionMs = position, error = null)
        }
        "stop" -> copy(items = emptyList(), currentIndex = 0, state = "stopped", playWhenReady = false, error = null)
        else -> this
    }

    /** The progress exposed to the WebView, notification and reopen intent. */
    fun authoritativeChunkProgress(): Float {
        val item = currentItem ?: return 0f
        val duration = maxOf(item.lastDurationMs, durationMs)
        val position = if (item.lastPositionMs > 0L || positionMs <= 0L) item.lastPositionMs else positionMs
        return if (duration > 0L) {
            (position.toDouble() / duration.toDouble()).toFloat().coerceIn(0f, 0.98f)
        } else {
            item.chunkProgress.coerceIn(0f, 0.98f)
        }
    }

    fun authoritativeCurrentItem(): PlaybackQueueItem? = currentItem?.copy(chunkProgress = authoritativeChunkProgress())
}

internal data class PlaybackQueueMutation(
    val state: PlaybackQueueState,
    val discarded: List<PlaybackQueueItem>,
)
