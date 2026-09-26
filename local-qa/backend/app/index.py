"""Embeddings and in-memory vector search (cosine similarity, optional MMR)."""
import os
import threading
from dataclasses import dataclass

import numpy as np

from .ingest import Chunk


class Embedder:
    """Wraps fastembed. The model loads lazily on first use (~130 MB download, then cached)."""

    def __init__(self, model_name: str):
        self.model_name = model_name
        self._model = None
        self._lock = threading.Lock()

    def _get(self):
        with self._lock:
            if self._model is None:
                from fastembed import TextEmbedding
                self._model = TextEmbedding(self.model_name, cache_dir=os.environ.get("QA_EMBEDDING_CACHE"))
            return self._model

    def embed_passages(self, texts: list[str]) -> np.ndarray:
        return _normalize(np.array(list(self._get().passage_embed(texts, batch_size=32))))

    def embed_query(self, text: str) -> np.ndarray:
        return _normalize(np.array(list(self._get().query_embed(text))))[0]


def _normalize(m: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(m, axis=-1, keepdims=True)
    return m / np.where(norms == 0, 1, norms)


@dataclass
class Hit:
    chunk: Chunk
    score: float


class VectorIndex:
    def __init__(self):
        self.chunks: list[Chunk] = []
        self.vectors: np.ndarray | None = None

    def __len__(self):
        return len(self.chunks)

    def add(self, chunks: list[Chunk], vectors: np.ndarray):
        if not chunks:
            return
        self.chunks.extend(chunks)
        self.vectors = vectors if self.vectors is None else np.vstack([self.vectors, vectors])

    def remove_file(self, file_id: str):
        keep = [i for i, c in enumerate(self.chunks) if c.file_id != file_id]
        self.chunks = [self.chunks[i] for i in keep]
        self.vectors = self.vectors[keep] if keep and self.vectors is not None else None

    def search(self, query: np.ndarray, top_k: int, min_similarity: float,
               diversify: bool, mmr_lambda: float) -> list[Hit]:
        if self.vectors is None or not self.chunks:
            return []
        sims = self.vectors @ query
        candidates = [i for i in np.argsort(-sims) if sims[i] >= min_similarity]
        if not diversify:
            chosen = candidates[:top_k]
        else:
            chosen = _mmr(self.vectors, sims, candidates[: top_k * 4], top_k, mmr_lambda)
        return [Hit(self.chunks[i], float(sims[i])) for i in chosen]


def _mmr(vectors, sims, candidates, k, lam) -> list[int]:
    """Maximal marginal relevance: trade query relevance against similarity to already-picked chunks."""
    chosen: list[int] = []
    pool = list(candidates)
    while pool and len(chosen) < k:
        if not chosen:
            best = pool[0]
        else:
            redundancy = (vectors[pool] @ vectors[chosen].T).max(axis=1)
            scores = lam * sims[pool] - (1 - lam) * redundancy
            best = pool[int(np.argmax(scores))]
        chosen.append(best)
        pool.remove(best)
    return chosen
