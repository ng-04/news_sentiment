"""OpenAI via the official SDK (Chat Completions); also the base for OpenAI-compatible APIs."""
import openai

from .base import REASONING_HEADROOM, Event, LLMError, LLMRequest, redact


class OpenAIAdapter:
    label = "OpenAI"

    def token_limit_kwargs(self, req: LLMRequest) -> dict:
        # OpenAI's reasoning models count hidden reasoning against max_completion_tokens.
        return {"max_completion_tokens": req.max_tokens + REASONING_HEADROOM}

    async def stream(self, req: LLMRequest):
        client = openai.AsyncOpenAI(api_key=req.api_key, base_url=req.base_url or None,
                                    timeout=req.timeout_s, max_retries=1)
        kwargs = dict(model=req.model, stream=True, temperature=req.temperature,
                      messages=[{"role": "system", "content": req.system}, *req.messages],
                      **self.token_limit_kwargs(req))
        try:
            try:
                stream = await client.chat.completions.create(**kwargs)
            except openai.BadRequestError as e:
                # Some models (e.g. reasoning models) only allow the default temperature.
                if "temperature" not in str(e.message).lower():
                    raise
                del kwargs["temperature"]
                stream = await client.chat.completions.create(**kwargs)
                yield Event("note", f"{req.model} doesn't support temperature, so that setting was ignored.")
            finish = None
            async for chunk in stream:
                if chunk.choices:
                    choice = chunk.choices[0]
                    if choice.delta and choice.delta.content:
                        yield Event("token", choice.delta.content)
                    finish = choice.finish_reason or finish
        except openai.AuthenticationError:
            raise LLMError("invalid_api_key", f"The {self.label} API key was rejected.", 401)
        except openai.PermissionDeniedError as e:
            raise LLMError("invalid_api_key", redact(f"The API key isn't allowed to do this: {e.message}", req.api_key), 401)
        except openai.NotFoundError:
            raise LLMError("invalid_model", f"{self.label} doesn't recognise the model {req.model!r}.", 400)
        except openai.RateLimitError as e:
            if "insufficient_quota" in str(e.body or e.message):
                raise LLMError("api_key_no_credit", f"This {self.label} account is out of credit.", 402)
            raise LLMError("rate_limited", f"{self.label} rate limit reached for this key. Try again shortly.", 429)
        except openai.BadRequestError as e:
            raise LLMError("llm_bad_request", redact(f"{self.label} rejected the request: {e.message}", req.api_key), 400)
        except openai.APITimeoutError:
            raise LLMError("llm_timeout", f"{self.label} took too long to respond.", 504)
        except openai.APIStatusError as e:
            raise LLMError("llm_error", redact(f"{self.label} error {e.status_code}: {e.message}", req.api_key), 502)
        except openai.APIConnectionError:
            raise LLMError("llm_unreachable", f"Couldn't reach {self.label}.", 502)
        finally:
            await client.close()

        if finish == "length":
            yield Event("note", "The answer was cut off at the length limit.")
        elif finish == "content_filter":
            yield Event("note", "The provider's content filter stopped the answer.")
