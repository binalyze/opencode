export * as SessionTurnRetry from "./turn-retry"

import { LLMError } from "@opencode-ai/llm"
import { Cause, Option } from "effect"

/**
 * Fleet fork patch, part 3 (see platform-v2/docs/OPENCODE-FORK.md): bounded
 * provider-turn retry for the v2 native runner.
 *
 * The V1 session loop retries transient provider failures
 * (packages/opencode/src/session/retry.ts wrapped around the stream drain in
 * processor.ts), but the v2 runner's own TODO list ("Bound provider retries")
 * is unimplemented — a single transient failure (rate limit, provider 5xx, a
 * response stream dying mid-read) terminates the whole run. These helpers
 * classify a failed turn attempt and compute its backoff; the drain loop in
 * session/runner/llm.ts wires them in.
 */

export const MAX_ATTEMPTS = 3
export const INITIAL_DELAY_MS = 2_000
export const BACKOFF_FACTOR = 2
export const MAX_BACKOFF_MS = 30_000
/** A provider-sent retry-after is honored past the backoff cap, but never further than this. */
export const MAX_RETRY_AFTER_MS = 300_000

/**
 * The llm package's mid-stream read failure ("Failed to read <route> stream",
 * emitted by the route client's Stream.catchCause and the http transport's
 * Stream.mapError) is an InvalidProviderOutputReason, whose `retryable` is
 * hard-coded false — but a response body dying mid-read is exactly the
 * transient failure class the V1 path retries (its ResponseStreamError maps
 * to APIError with isRetryable: true). Both emit sites share the
 * "Failed to read … stream" message template; match on it.
 */
const isStreamReadFailure = (error: LLMError) =>
  error.reason._tag === "InvalidProviderOutput" &&
  error.reason.message.startsWith("Failed to read ") &&
  error.reason.message.endsWith(" stream")

/**
 * The retry-worthy LLMError inside a failed turn's cause, if any.
 * Interrupted causes (user abort) and non-LLM failures never retry;
 * otherwise the llm package's own `retryable` classification decides
 * (RateLimit, ProviderInternal), plus the mid-stream read failure above.
 */
export const retryableFailure = (cause: Cause.Cause<unknown>): LLMError | undefined => {
  if (Cause.hasInterrupts(cause)) return undefined
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (!(failure instanceof LLMError)) return undefined
  if (failure.retryable || isStreamReadFailure(failure)) return failure
  return undefined
}

/** Delay before the given attempt (1-based): the provider's retry-after wins, else 2s·2^(n−1) capped at 30s. */
export const delayMs = (attempt: number, error?: LLMError): number => {
  const retryAfter = error?.retryAfterMs
  if (retryAfter !== undefined && retryAfter > 0) return Math.min(retryAfter, MAX_RETRY_AFTER_MS)
  return Math.min(INITIAL_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt - 1), MAX_BACKOFF_MS)
}
