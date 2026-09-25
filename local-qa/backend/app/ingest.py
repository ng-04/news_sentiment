"""Parse PDF/DOCX files into located text units, then split units into chunks."""
import io
import re
from dataclasses import dataclass

from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph
from pypdf import PdfReader
from pypdf.errors import PdfReadError

# A DOCX has no fixed pages; count this many characters as one page for the page limit.
DOCX_CHARS_PER_PAGE = 3000


@dataclass
class Unit:
    """A span of source text with a citable location: a PDF page or a DOCX section."""
    text: str
    page: int | None = None
    section: str | None = None


@dataclass
class ParsedFile:
    name: str
    units: list[Unit]
    pages: int | None  # real page count for PDFs, None for DOCX
    page_equivalent: int  # used for the per-session page limit


@dataclass
class Chunk:
    file_id: str
    file_name: str
    text: str
    page: int | None
    section: str | None
    chunk_index: int


class ParseError(Exception):
    pass


def parse_file(name: str, data: bytes) -> ParsedFile:
    lower = name.lower()
    if lower.endswith(".pdf"):
        return _parse_pdf(name, data)
    if lower.endswith(".docx"):
        return _parse_docx(name, data)
    raise ParseError("unsupported file type (only .pdf and .docx)")


def _parse_pdf(name: str, data: bytes) -> ParsedFile:
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise ParseError("PDF is password-protected")
        units = []
        for i, page in enumerate(reader.pages, start=1):
            text = _clean(page.extract_text() or "")
            if text:
                units.append(Unit(text=text, page=i))
        n_pages = len(reader.pages)
    except PdfReadError as e:
        raise ParseError(f"could not read PDF ({e})")
    if not units:
        raise ParseError("no extractable text (the PDF may be scanned images)")
    return ParsedFile(name=name, units=units, pages=n_pages, page_equivalent=n_pages)


def _parse_docx(name: str, data: bytes) -> ParsedFile:
    try:
        doc = Document(io.BytesIO(data))
    except Exception as e:  # python-docx raises several unrelated types for corrupt files
        raise ParseError(f"could not read DOCX ({type(e).__name__})")

    # Walk paragraphs and tables in document order, grouping text under the nearest heading.
    units: list[Unit] = []
    section, buf = None, []

    def flush():
        text = _clean("\n\n".join(buf))
        if text:
            units.append(Unit(text=text, section=section))
        buf.clear()

    for block in doc.element.body.iterchildren():
        tag = block.tag.rsplit("}", 1)[-1]
        if tag == "p":
            para = Paragraph(block, doc)
            style = (para.style.name if para.style is not None else "") or ""
            if style.lower().startswith(("heading", "title")) and para.text.strip():
                flush()
                section = para.text.strip()[:120]
            elif para.text.strip():
                buf.append(para.text)
        elif tag == "tbl":
            table = Table(block, doc)
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells]
                if any(cells):
                    buf.append(" | ".join(cells))
    flush()
    if not units:
        raise ParseError("document contains no text")
    chars = sum(len(u.text) for u in units)
    return ParsedFile(name=name, units=units, pages=None,
                      page_equivalent=max(1, -(-chars // DOCX_CHARS_PER_PAGE)))


def _clean(text: str) -> str:
    text = text.replace("\x00", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ---------------------------------------------------------------- chunking

_SEPARATORS = ["\n\n", "\n", ". ", " "]


def chunk_file(file_id: str, parsed: ParsedFile, strategy: str, size: int, overlap: int) -> list[Chunk]:
    chunks: list[Chunk] = []
    for unit in parsed.units:
        if strategy == "by_page":
            pieces = [unit.text] if len(unit.text) <= size * 2 else _fixed(unit.text, size * 2, overlap)
        elif strategy == "by_paragraph":
            pieces = _by_paragraph(unit.text, size, overlap)
        elif strategy == "fixed":
            pieces = _fixed(unit.text, size, overlap)
        else:
            pieces = _recursive(unit.text, size, overlap)
        for piece in pieces:
            piece = piece.strip()
            if piece:
                chunks.append(Chunk(file_id=file_id, file_name=parsed.name, text=piece,
                                    page=unit.page, section=unit.section, chunk_index=len(chunks)))
    return chunks


def _fixed(text: str, size: int, overlap: int) -> list[str]:
    step = max(1, size - overlap)
    return [text[i:i + size] for i in range(0, max(len(text) - overlap, 1), step)]


def _by_paragraph(text: str, size: int, overlap: int) -> list[str]:
    out = []
    for para in re.split(r"\n\s*\n", text):
        out.extend([para] if len(para) <= size else _recursive(para, size, overlap))
    return out


def _recursive(text: str, size: int, overlap: int) -> list[str]:
    """Split on the coarsest separator that works, then pack pieces up to `size` with overlap."""
    pieces = _split(text, size, 0)
    chunks, current = [], ""
    for piece in pieces:
        if current and len(current) + len(piece) > size:
            chunks.append(current)
            tail = current[-overlap:] if overlap else ""
            # Start the overlap at a word boundary so chunks don't begin mid-word.
            if tail and " " in tail:
                tail = tail[tail.index(" ") + 1:]
            current = tail + piece
        else:
            current += piece
    if current.strip():
        chunks.append(current)
    return chunks


def _split(text: str, size: int, level: int) -> list[str]:
    if len(text) <= size:
        return [text]
    if level >= len(_SEPARATORS):
        return [text[i:i + size] for i in range(0, len(text), size)]
    sep = _SEPARATORS[level]
    parts = text.split(sep)
    out = []
    for i, part in enumerate(parts):
        piece = part + (sep if i < len(parts) - 1 else "")
        out.extend([piece] if len(piece) <= size else _split(piece, size, level + 1))
    return out
