# Embedding model (self-hosted copy)

`Xenova/bge-small-en-v1.5` — the ONNX (quantized) build of
[BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) for Transformers.js, copied
from https://huggingface.co/Xenova/bge-small-en-v1.5 (commit `ea104dacec62`). MIT licensed.

Local Q&A loads these files from this site so it doesn't depend on Hugging Face being reachable
(or not rate-limiting) when someone uses the tool; it falls back to Hugging Face if they're missing.
