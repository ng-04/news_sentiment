"""Any OpenAI-compatible Chat Completions API (Groq, Mistral, OpenRouter, DeepSeek, Together, ...)."""
from .base import LLMRequest
from .openai import OpenAIAdapter


class CompatibleAdapter(OpenAIAdapter):
    label = "The provider"

    def token_limit_kwargs(self, req: LLMRequest) -> dict:
        # Compatible servers widely support max_tokens; max_completion_tokens is OpenAI-specific.
        return {"max_tokens": req.max_tokens}
