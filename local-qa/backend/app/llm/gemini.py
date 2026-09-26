"""Google Gemini via the official google-genai SDK."""
from google import genai
from google.genai import errors, types

from .base import REASONING_HEADROOM, Event, LLMError, LLMRequest, redact


class GeminiAdapter:
    async def stream(self, req: LLMRequest):
        client = genai.Client(api_key=req.api_key,
                              http_options=types.HttpOptions(timeout=req.timeout_s * 1000))
        contents = [{"role": "model" if m["role"] == "assistant" else "user",
                     "parts": [{"text": m["content"]}]} for m in req.messages]
        config = types.GenerateContentConfig(
            system_instruction=req.system,
            temperature=req.temperature,
            # Gemini's thinking models count thinking tokens against this limit.
            max_output_tokens=req.max_tokens + REASONING_HEADROOM,
        )
        finish = None
        try:
            stream = await client.aio.models.generate_content_stream(
                model=req.model, contents=contents, config=config)
            async for chunk in stream:
                if chunk.text:
                    yield Event("token", chunk.text)
                if chunk.candidates and chunk.candidates[0].finish_reason:
                    finish = str(chunk.candidates[0].finish_reason)
        except errors.ClientError as e:
            msg = redact(str(e.message or e), req.api_key)
            if e.code in (401, 403) or "API_KEY_INVALID" in msg or "API key not valid" in msg:
                raise LLMError("invalid_api_key", "The Gemini API key was rejected.", 401)
            if e.code == 404:
                raise LLMError("invalid_model", f"Gemini doesn't recognise the model {req.model!r}.", 400)
            if e.code == 429:
                raise LLMError("rate_limited", "Gemini rate limit or quota reached for this key.", 429)
            raise LLMError("llm_bad_request", f"Gemini rejected the request: {msg}", 400)
        except errors.ServerError as e:
            raise LLMError("llm_error", redact(f"Gemini error {e.code}: {e.message}", req.api_key), 502)
        except errors.APIError as e:
            raise LLMError("llm_error", redact(f"Gemini error: {e}", req.api_key), 502)

        if finish and "MAX_TOKENS" in finish:
            yield Event("note", "The answer was cut off at the length limit.")
        elif finish and "SAFETY" in finish:
            yield Event("note", "Gemini's safety filter stopped the answer.")
