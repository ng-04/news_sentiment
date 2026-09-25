import pytest

from app.config import ParamError, resolve_params
from app.ingest import ParseError, chunk_file, parse_file
from tests.conftest import make_pdf


def test_pdf_keeps_page_numbers(report_pdf):
    parsed = parse_file("report.pdf", report_pdf)
    assert parsed.pages == 3
    assert [u.page for u in parsed.units] == [1, 2, 3]
    assert "48 crore" in parsed.units[1].text


def test_pdf_without_text_is_rejected():
    with pytest.raises(ParseError, match="no extractable text"):
        parse_file("scan.pdf", make_pdf([""]))


def test_corrupt_files_are_rejected():
    with pytest.raises(ParseError):
        parse_file("bad.pdf", b"not a pdf")
    with pytest.raises(ParseError):
        parse_file("bad.docx", b"not a docx")


def test_docx_sections_and_tables(policy_docx):
    parsed = parse_file("policy.docx", policy_docx)
    assert parsed.pages is None
    sections = {u.section: u.text for u in parsed.units}
    assert "24 days" in sections["Leave policy"]
    assert "L2 | 8000" in sections["Travel policy"]  # table rows land under the preceding heading


def test_unsupported_type():
    with pytest.raises(ParseError, match="unsupported"):
        parse_file("notes.txt", b"hi")


@pytest.mark.parametrize("strategy", ["recursive", "fixed", "by_paragraph", "by_page"])
def test_chunk_strategies_respect_size(strategy):
    text = ("Sentence number one is here. " * 40 + "\n\n") * 5
    parsed = parse_file("big.pdf", make_pdf([text[:3000]]))
    parsed.units[0].text = text
    chunks = chunk_file("f1", parsed, strategy, size=300, overlap=50)
    limit = 600 if strategy == "by_page" else 300
    assert chunks and all(len(c.text) <= limit for c in chunks)
    assert all(c.page == 1 and c.file_name == "big.pdf" for c in chunks)


def test_recursive_chunks_overlap():
    parsed = parse_file("x.pdf", make_pdf(["placeholder"]))
    parsed.units[0].text = " ".join(f"word{i}" for i in range(400))
    chunks = chunk_file("f1", parsed, "recursive", size=200, overlap=60)
    assert len(chunks) > 1
    first_tail = chunks[0].text.split()[-2]
    assert first_tail in chunks[1].text  # neighbouring chunks share text


def test_params_are_clamped_and_validated():
    p = resolve_params({"temperature": 5, "top_k": 0, "chunk_size": 300, "chunk_overlap": 900})
    assert p["temperature"] == 1.0 and p["top_k"] == 1
    assert p["chunk_overlap"] == 150  # at most half the chunk size
    with pytest.raises(ParamError):
        resolve_params({"answer_style": "poem"})
