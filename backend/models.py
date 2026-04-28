from pydantic import BaseModel, Field

class BookMeta(BaseModel):
    id: str
    filepath: str
    title: str
    author: str
    page_count: int
    toc: list[dict]  # [{"title": str, "page": int}]
    format: str = "pdf"  # "pdf" | "epub"
    voice: str = "af_heart"
    speed: float = 0.95

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
    speed: float = 0.95
    last_position: Position = Field(default_factory=lambda: Position(page=0, sentence_idx=0))
    bookmarks: list[Bookmark] = Field(default_factory=list)

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
