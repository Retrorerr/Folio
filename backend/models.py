from pydantic import BaseModel

class BookMeta(BaseModel):
    id: str
    filepath: str
    title: str
    author: str
    page_count: int
    toc: list[dict]  # [{"title": str, "page": int}]
    format: str = "pdf"  # "pdf" | "epub"
    voice: str = "af_heart"
    speed: float = 1.0
    engine: str = "kokoro"

class Position(BaseModel):
    page: int
    sentence_idx: int

class Bookmark(BaseModel):
    page: int
    sentence_idx: int
    label: str = ""

class BookState(BaseModel):
    id: str
    filepath: str
    title: str
    author: str
    page_count: int
    toc: list[dict]
    format: str = "pdf"
    voice: str = "af_heart"
    speed: float = 1.0
    engine: str = "kokoro"  # "kokoro" or "orpheus"
    last_position: Position = Position(page=0, sentence_idx=0)
    bookmarks: list[Bookmark] = []

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
