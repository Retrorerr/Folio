import { useEffect, useCallback } from 'react'

export default function AudioPlayer({
  isPlaying, isGenerating, textLoading, modelLoaded, modelLoading,
  play, pause, stop, skipSentence,
  currentPage, pageCount, goToPage,
  speed, setSpeed, volume, setVolume,
  currentSentence, sentenceCount,
  sleepTimer, setSleepTimer,
}) {
  // Keyboard shortcuts
  const handleKeyDown = useCallback((e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return
    switch (e.code) {
      case 'Space':
        e.preventDefault()
        isPlaying ? pause() : play()
        break
      case 'ArrowRight':
        e.preventDefault()
        skipSentence(1)
        break
      case 'ArrowLeft':
        e.preventDefault()
        skipSentence(-1)
        break
      case 'PageDown':
        e.preventDefault()
        goToPage(currentPage + 1)
        break
      case 'PageUp':
        e.preventDefault()
        goToPage(currentPage - 1)
        break
    }
  }, [isPlaying, play, pause, skipSentence, goToPage, currentPage])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const sleepMinutes = sleepTimer !== null ? Math.ceil(sleepTimer) : null

  return (
    <div className="audio-player">
      <div className="player-controls">
        <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 0} title="Previous page">
          &#9198;
        </button>
        <button onClick={() => skipSentence(-1)} title="Previous sentence (Left arrow)">
          &#9194;
        </button>
        <button onClick={isPlaying ? pause : play} className="play-btn" title="Play/Pause (Space)">
          {isPlaying ? '\u23F8' : '\u25B6'}
        </button>
        <button onClick={stop} title="Stop">&#9209;</button>
        <button onClick={() => skipSentence(1)} title="Next sentence (Right arrow)">
          &#9193;
        </button>
        <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= pageCount - 1} title="Next page">
          &#9197;
        </button>
      </div>

      <div className="player-info">
        <span className="sentence-counter">
          Sentence {currentSentence + 1}/{sentenceCount}
        </span>
        {!modelLoaded && (
          <span className="status-indicator loading">
            {modelLoading ? 'Loading model...' : 'Model not ready'}
          </span>
        )}
        {textLoading && (
          <span className="status-indicator loading">
            Extracting text (OCR)...
          </span>
        )}
        {isGenerating && (
          <span className="status-indicator generating">
            Generating audio...
          </span>
        )}
        {!textLoading && sentenceCount === 0 && (
          <span className="status-indicator loading">
            No text on this page
          </span>
        )}
      </div>

      <div className="player-sliders">
        <label>
          Speed: {speed.toFixed(1)}x
          <input
            type="range" min="0.5" max="2" step="0.1"
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
          />
        </label>
        <label>
          Volume: {Math.round(volume * 100)}%
          <input
            type="range" min="0" max="1" step="0.05"
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
          />
        </label>
      </div>

      <div className="player-extras">
        <div className="sleep-timer">
          <span>Sleep:</span>
          {[null, 5, 15, 30, 60].map((mins) => (
            <button
              key={String(mins)}
              onClick={() => setSleepTimer(mins)}
              className={sleepTimer !== null && mins !== null && Math.ceil(sleepTimer) === mins ? 'active' : ''}
            >
              {mins === null ? 'Off' : `${mins}m`}
            </button>
          ))}
          {sleepMinutes !== null && (
            <span className="sleep-remaining">{sleepMinutes}m left</span>
          )}
        </div>
      </div>

      <div className="shortcuts-hint">
        Space: play/pause &bull; Arrows: skip sentence &bull; Page Up/Down: skip page
      </div>
    </div>
  )
}
