package com.folio.reader.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackQueueStateTest {
    private fun item(id: Long, startMs: Long = 0L) = PlaybackQueueItem(
        sessionId = id,
        path = "audio-$id.wav",
        title = "Chapter $id",
        artist = "Author",
        album = "Book",
        requestedPositionMs = startMs,
    )

    @Test
    fun replacingQueueStartsNewItemAndDiscardsOldItems() {
        val old = PlaybackQueueState(
            items = listOf(item(1)),
            state = "paused",
            currentSessionId = 1,
            nextSessionId = 1,
        )

        val mutation = old.enqueue(item(2, 750), appendToActiveQueue = false)

        assertEquals(listOf(1L), mutation.discarded.map { it.sessionId })
        assertEquals(listOf(2L), mutation.state.items.map { it.sessionId })
        assertEquals("preparing", mutation.state.state)
        assertEquals(750L, mutation.state.positionMs)
        assertTrue(mutation.state.playWhenReady)
    }

    @Test
    fun activeQueueAppendDoesNotChangeCurrentSnapshot() {
        val old = PlaybackQueueState(
            items = listOf(item(4)),
            state = "playing",
            positionMs = 1234,
            currentSessionId = 4,
            nextSessionId = 4,
            playWhenReady = true,
        )

        val mutation = old.enqueue(item(5), appendToActiveQueue = true)

        assertTrue(mutation.discarded.isEmpty())
        assertEquals(listOf(4L, 5L), mutation.state.items.map { it.sessionId })
        assertEquals(4L, mutation.state.currentSessionId)
        assertEquals(1234L, mutation.state.positionMs)
        assertEquals("playing", mutation.state.state)
    }

    @Test
    fun controlsPreserveQueueForPauseAndClearItForStop() {
        val playing = PlaybackQueueState(
            items = listOf(item(8)),
            state = "playing",
            durationMs = 2_000,
            currentSessionId = 8,
            playWhenReady = true,
        )

        val paused = playing.control("pause", null)
        assertEquals("paused", paused.state)
        assertFalse(paused.playWhenReady)
        assertEquals(1, paused.items.size)
        assertEquals(2_000L, paused.control("seek", 9_000).positionMs)

        val stopped = paused.control("stop", null)
        assertEquals("stopped", stopped.state)
        assertTrue(stopped.items.isEmpty())
        assertFalse(stopped.playWhenReady)
    }

    @Test
    fun mediaTransitionDiscardsCompletedItemsAndKeepsLeadQueue() {
        val queued = PlaybackQueueState(
            items = listOf(item(10), item(11), item(12)),
            currentSessionId = 10,
            nextSessionId = 12,
            state = "playing",
            playWhenReady = true,
        )

        val transition = queued.advance(11, "preparing", 0, 0, true, null)

        assertEquals(listOf(10L), transition.discarded.map { it.sessionId })
        assertEquals(listOf(11L, 12L), transition.state.items.map { it.sessionId })
        assertEquals(0, transition.state.currentIndex)
        assertEquals(11L, transition.state.currentSessionId)
    }

    @Test
    fun metadataAndArtworkStayAttachedToTheCorrectQueueItem() {
        val first = item(20).copy(
            bookId = "book-a",
            format = "epub",
            chapterTitle = "Opening",
            chapterIndex = 0,
            chapterCount = 3,
            sentenceIndex = 2,
            sentenceCount = 8,
            chunkProgress = 0.35f,
            locationUri = "android://book-a/book.epub",
            artworkPath = "/data/user/0/com.folio.reader/noBackupFiles/folio-playback/artwork-a.jpg",
        )
        val state = PlaybackQueueState(items = listOf(first), currentSessionId = 20, nextSessionId = 20)
        val appended = state.enqueue(item(21).copy(bookId = "book-a", artworkPath = first.artworkPath), appendToActiveQueue = true)

        assertEquals("book-a", appended.state.currentItem?.bookId)
        assertEquals("Opening", appended.state.currentItem?.chapterTitle)
        assertEquals(first.artworkPath, appended.state.currentItem?.artworkPath)
        assertEquals("book-a", appended.state.items[1].bookId)
        assertEquals(first.artworkPath, appended.state.items[1].artworkPath)
    }
}
