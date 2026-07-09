import { describe, expect, it } from "bun:test"
import { Cause } from "effect"
import {
  InvalidProviderOutputReason,
  InvalidRequestReason,
  LLMError,
  ProviderInternalReason,
  RateLimitReason,
} from "@opencode-ai/llm"
import { SessionTurnRetry } from "@opencode-ai/core/session/runner/turn-retry"

// Fleet fork patch coverage, part 3 (see platform-v2/docs/OPENCODE-FORK.md):
// bounded provider-turn retry for the v2 native runner. These helpers decide
// which failed turn attempts session/runner/llm.ts re-runs and how long it
// backs off. Guarded by platform-v2/scripts/build-opencode.sh.

const llmError = (reason: LLMError["reason"]) => new LLMError({ module: "Test", method: "stream", reason })

const streamReadError = (route = "openai/openai-responses") =>
  llmError(new InvalidProviderOutputReason({ message: `Failed to read ${route} stream`, route }))

describe("SessionTurnRetry.retryableFailure", () => {
  it("retries the llm package's own retryable classes (rate limit, provider internal)", () => {
    const rateLimited = llmError(new RateLimitReason({ message: "429" }))
    expect(SessionTurnRetry.retryableFailure(Cause.fail(rateLimited))).toBe(rateLimited)
    const providerInternal = llmError(new ProviderInternalReason({ message: "upstream 500", status: 500 }))
    expect(SessionTurnRetry.retryableFailure(Cause.fail(providerInternal))).toBe(providerInternal)
  })

  it("retries the mid-stream read failure despite its non-retryable reason class", () => {
    const failure = streamReadError()
    expect(failure.retryable).toBe(false) // upstream classification: InvalidProviderOutput is not retryable
    expect(SessionTurnRetry.retryableFailure(Cause.fail(failure))).toBe(failure)
  })

  it("does not retry other InvalidProviderOutput failures (deterministic protocol errors)", () => {
    const parseFailure = llmError(new InvalidProviderOutputReason({ message: "Failed to parse openai event JSON" }))
    expect(SessionTurnRetry.retryableFailure(Cause.fail(parseFailure))).toBeUndefined()
  })

  it("does not retry non-retryable classes, non-LLM failures, or interrupted causes", () => {
    expect(SessionTurnRetry.retryableFailure(Cause.fail(llmError(new InvalidRequestReason({ message: "bad request" }))))).toBeUndefined()
    expect(SessionTurnRetry.retryableFailure(Cause.fail(new Error("not an LLMError")))).toBeUndefined()
    expect(SessionTurnRetry.retryableFailure(Cause.interrupt(1))).toBeUndefined()
    // an abort racing a retryable failure must still read as an abort
    const mixed = Cause.combine(Cause.fail(streamReadError()), Cause.interrupt(1))
    expect(SessionTurnRetry.retryableFailure(mixed)).toBeUndefined()
  })
})

describe("SessionTurnRetry.delayMs", () => {
  it("backs off exponentially from 2s and caps at 30s", () => {
    expect(SessionTurnRetry.delayMs(1)).toBe(2_000)
    expect(SessionTurnRetry.delayMs(2)).toBe(4_000)
    expect(SessionTurnRetry.delayMs(3)).toBe(8_000)
    expect(SessionTurnRetry.delayMs(10)).toBe(30_000)
  })

  it("honors the provider's retry-after over the backoff, bounded by the hard cap", () => {
    const rateLimited = llmError(new RateLimitReason({ message: "429", retryAfterMs: 12_345 }))
    expect(SessionTurnRetry.delayMs(1, rateLimited)).toBe(12_345)
    const pathological = llmError(new RateLimitReason({ message: "429", retryAfterMs: 86_400_000 }))
    expect(SessionTurnRetry.delayMs(1, pathological)).toBe(SessionTurnRetry.MAX_RETRY_AFTER_MS)
  })

  it("ignores an absent or zero retry-after", () => {
    const noHeader = llmError(new RateLimitReason({ message: "429" }))
    expect(SessionTurnRetry.delayMs(2, noHeader)).toBe(4_000)
    expect(SessionTurnRetry.delayMs(2, streamReadError())).toBe(4_000)
  })
})
