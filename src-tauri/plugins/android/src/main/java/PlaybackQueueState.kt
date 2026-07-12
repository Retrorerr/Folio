package com.folio.reader.mobile

internal data class PlaybackQueueItem(
    val sessionId: Long,
    val path: String,
    val title: String,
    val artist: String,
    val album: String,
    val requestedPositionMs: Long,
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
    ): PlaybackQueueMutation {
        val index = items.indexOfFirst { it.sessionId == sessionId }
        if (index < 0) return PlaybackQueueMutation(this, emptyList())
        val remaining = items.drop(index)
        return PlaybackQueueMutation(
            state = copy(
                items = remaining,
                currentIndex = 0,
                state = nextState,
                positionMs = nextPositionMs.coerceAtLeast(0L),
                durationMs = nextDurationMs.coerceAtLeast(0L),
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
            copy(positionMs = (requestedPositionMs ?: 0L).coerceIn(0L, upperBound), error = null)
        }
        "stop" -> copy(items = emptyList(), currentIndex = 0, state = "stopped", playWhenReady = false, error = null)
        else -> this
    }
}

internal data class PlaybackQueueMutation(
    val state: PlaybackQueueState,
    val discarded: List<PlaybackQueueItem>,
)
