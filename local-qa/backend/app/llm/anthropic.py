"""Claude via the official Anthropic SDK (1.x)."""
import anthropic

from .base import REASONING_HEADROOM, Event, LLMError, LLMRequest, redact

# Models that still honour sampling parameters. SDK 1.x removed `temperature` from its typed
# signatures, so for these it goes through extra_body; Opus 4.7+ and Sonnet 5 reject it.
_TEMPERATURE_OK = ("claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6", "claude-sonnet-4-5",
                   "claude-opus-4-5", "claude-opus-4-1", "claude-opus-4-0", "claude-sonnet-4-0")

# Models that accept output_config.effort (and may think adaptively before answering).
_EFFORT_OK = ("claude-opus-4-5", "claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-7",
              "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-fable", "claude-mythos")

# Models where server-side refusal fallbacks are enabled (re-runs a declined request on
# Anthropic's recommended fallback model inside the same call).
_FALLBACK_OK = ("claude-opus-5", "claude-fable-5-1")
_FALLBACK_BETA = "server-side-fallback-2026-07-01"


class AnthropicAdapter:
    async def stream(self, req: LLMRequest):
        client = anthropic.AsyncAnthropic(api_key=req.api_key, timeout=req.timeout_s, max_retries=1)
        model = req.model
        kwargs = dict(model=model, max_tokens=req.max_tokens, system=req.system, messages=req.messages)
        notes = []

        if model.startswith(_TEMPERATURE_OK):
            kwargs["extra_body"] = {"temperature": req.temperature}
        else:
            notes.append(f"{model} doesn't support temperature, so that setting was ignored.")
        if model.startswith(_EFFORT_OK):
            kwargs["output_config"] = {"effort": req.effort}
            kwargs["max_tokens"] += REASONING_HEADROOM

        if model.startswith(_FALLBACK_OK):
            stream_ctx = client.beta.messages.stream(betas=[_FALLBACK_BETA], fallbacks="default", **kwargs)
        else:
            stream_ctx = client.messages.stream(**kwargs)

        try:
            async with stream_ctx as stream:
                for note in notes:
                    yield Event("note", note)
                async for text in stream.text_stream:
                    yield Event("token", text)
                final = await stream.get_final_message()
        except anthropic.AuthenticationError:
            raise LLMError("invalid_api_key", "The Anthropic API key was rejected.", 401)
        except anthropic.PermissionDeniedError as e:
            raise LLMError("invalid_api_key", redact(f"The API key isn't allowed to do this: {e.message}", req.api_key), 401)
        except anthropic.NotFoundError:
            raise LLMError("invalid_model", f"Anthropic doesn't recognise the model {model!r}.", 400)
        except anthropic.RateLimitError:
            raise LLMError("rate_limited", "Anthropic rate limit reached for this key. Try again shortly.", 429)
        except anthropic.BadRequestError as e:
            msg = redact(e.message, req.api_key)
            if "credit balance" in msg.lower():
                raise LLMError("api_key_no_credit", "This Anthropic account is out of credit.", 402)
            raise LLMError("llm_bad_request", f"Anthropic rejected the request: {msg}", 400)
        except anthropic.APITimeoutError:
            raise LLMError("llm_timeout", "Anthropic took too long to respond.", 504)
        except anthropic.APIStatusError as e:
            raise LLMError("llm_error", redact(f"Anthropic error {e.status_code}: {e.message}", req.api_key), 502)
        except anthropic.APIConnectionError:
            raise LLMError("llm_unreachable", "Couldn't reach Anthropic.", 502)
        finally:
            await client.close()

        if final.stop_reason == "refusal":
            yield Event("note", "The model declined to answer this question.")
        elif final.stop_reason == "max_tokens":
            yield Event("note", "The answer was cut off at the length limit.")
