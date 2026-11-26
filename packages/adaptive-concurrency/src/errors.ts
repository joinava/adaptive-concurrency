import { defineErrorVocabulary } from "@zingage/errors";

/**
 * This package's error vocabulary. An app that uses `@zingage/errors` lists
 * it in `makeErrorHelpers({ vocabularies })`, so its readers know the types
 * below.
 *
 * The package states the annotation on each error it throws, so it needs no
 * derivation rule of its own.
 */
export const adaptiveConcurrencyErrorVocabulary = defineErrorVocabulary({
  name: "adaptive-concurrency",
  deriveAnnotation: () => undefined,
  types: {
    /**
     * The limiter gave no allotment, so the operation never started. For
     * example: the acquire strategy refused and the limiter has no
     * {@link AllotmentUnavailableStrategy}, the backlog was full, or the
     * request timed out in the backlog.
     *
     * Safe to repeat, because nothing ran, and the condition clears with time
     * as inflight work completes. A refusal is a load signal: the caller
     * sends faster than the limit admits. A throw site can state a
     * `retryAfter`, or a different `load`, when it knows more.
     */
    ALLOTMENT_UNAVAILABLE: {
      parents: ["SERVICE_UNAVAILABLE"],
      retries: { safe: true, mayHelp: "on-its-own" },
      load: { signalsHighLoad: true },
    },
  },
});

/**
 * Makes the error for a request that got no allotment. It is the `error` of
 * the `{ ok: false, error }` result of `Limiter.acquire`. An
 * {@link AllotmentUnavailableStrategy} that gives up makes it, and can state
 * a `retryAfter` or a different `load`.
 */
export const allotmentUnavailableError =
  adaptiveConcurrencyErrorVocabulary.types.ALLOTMENT_UNAVAILABLE;

/**
 * Whether `error` is an {@link allotmentUnavailableError}, or a type under it.
 * It reads the type names in the error's annotation, so it works across
 * copies of this package.
 */
export function isAllotmentUnavailableError(error: unknown): boolean {
  return adaptiveConcurrencyErrorVocabulary.errorHasType(
    error,
    allotmentUnavailableError.typeName,
  );
}
