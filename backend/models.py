from pydantic import BaseModel, Field

from tts_defaults import DEFAULT_TTS_ENGINE, DEFAULT_TTS_SPEED, DEFAULT_TTS_VOICE

class BookMeta(BaseModel):
    id: str
    filepath: str
    title: str
    author: str
    page_count: int
    toc: list[dict]  # [{"title": str, "page": int}]
    format: str = "epub"
    cover_url: str | None = None
    cover_source: str | None = None
    tts_engine: str = DEFAULT_TTS_ENGINE
    voice: str = DEFAULT_TTS_VOICE
    tts_voices: dict[str, str] = Field(default_factory=dict)
    speed: float = DEFAULT_TTS_SPEED

class Position(BaseModel):
    page: int
    sentence_idx: int
    content_page: int | None = None
    visual_page: int | None = None
    pages_per_view: int | None = None
    layout_key: str | None = None
    chunk_progress: float | None = None
    saved_at: float | None = None

class Bookmark(BaseModel):
    page: int
    sentence_idx: int
    label: str = ""
    visual_page: int | None = None

class BookState(BaseModel):
    id: str
    filepath: str
    title: str
    author: str
    page_count: int
    toc: list[dict]
    format: str = "epub"
    cover_url: str | None = None
    cover_source: str | None = None
    tts_engine: str = DEFAULT_TTS_ENGINE
    voice: str = DEFAULT_TTS_VOICE
    tts_voices: dict[str, str] = Field(default_factory=dict)
    speed: float = DEFAULT_TTS_SPEED
    last_position: Position = Field(default_factory=lambda: Position(page=0, sentence_idx=0))
    bookmarks: list[Bookmark] = Field(default_factory=list)
    imported_at: float | None = None
    last_opened_at: float | None = None
    updated_at: float | None = None
    collections: list[str] = Field(default_factory=list)
    genres: list[str] = Field(default_factory=list)
    reading_ms_total: int = 0
    visual_page_count: int | None = None

class WordInfo(BaseModel):
    text: str
    x: float
    y: float
    w: float
    h: float
    char_offset: int
    char_length: int

class SentenceInfo(BaseModel):
    text: str
    words: list[WordInfo]
    audio_path: str | None = None
    duration_ms: float = 0

class PageText(BaseModel):
    page_number: int
    sentences: list[SentenceInfo]
    render_width: float
    render_height: float
