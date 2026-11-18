// Optional OpenTelemetry instrumentation (issue #129).
//
// This module deliberately does **not** import `@opentelemetry/api` at
// runtime. The API is an optional peer dependency: a server that never wires
// instrumentation pays nothing (the helpers below return before touching a
// clock or allocating an attribute object beyond the caller's own object),
// and an integrator who already runs OTel passes their tracer in.
//
// `otelTracer()` is the one place that resolves the peer dependency, and it
// does so lazily so that bundlers can drop it when it is unused.
//
// Privacy (threat model T9): spans identify the contract, the function, the
// numeric escrow id and a transaction hash. Account addresses are **not**
// included unless `includeAddresses` is explicitly set.

/** Phases an escrow call goes through, in order. */
export type EscrowSpanName = "simulate" | "sign" | "submit" | "confirm";

/** Standard, non-secret span attributes. Addresses are opt-in. */
export interface EscrowSpanAttributes {
  /** The escrow contract being called. */
  "contract.id": string;
  /** The contract entry point, e.g. `"release"`. */
  "contract.function": string;
  /** Numeric escrow id, serialised so OTel keeps it as a string attribute. */
  "escrow.id"?: string;
  /** Submitted transaction hash, once known. */
  "tx.hash"?: string;
  /** Number of confirmation polls after the initial submission. */
  "retry.count"?: number;
  /**
   * Opt-in only (`includeAddresses: true`). Never set by default: addresses
   * can be personal data, and a trace backend is not the place to leak them.
   */
  "account.address"?: string;
  [key: string]: string | number | boolean | undefined;
}

/** The subset of an OTel `Span` this package uses. */
export interface EscrowSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(error: Error): void;
  end(): void;
}

/** The subset of an OTel `Tracer` this package uses. */
export interface EscrowTracer {
  startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean> }): EscrowSpan;
}

/** A completed instrumentation event, for integrators who don't use OTel. */
export interface EscrowInstrumentationEvent {
  /** Which phase finished. */
  name: EscrowSpanName;
  /** Full OTel span name, e.g. `"escrow.simulate"`. */
  spanName: string;
  /** Wall-clock duration of the phase, in milliseconds. */
  durationMs: number;
  /**
   * Attributes captured for the span. Addresses appear here only when
   * `includeAddresses` is enabled.
   */
  attributes: EscrowSpanAttributes;
  /** Set when the phase failed. */
  error?: unknown;
}

export interface InstrumentationOptions {
  /**
   * An OTel-compatible tracer. Passing one enables spans; leaving it out
   * keeps the instrumentation a no-op unless `onEvent` is set.
   */
  tracer?: EscrowTracer;
  /**
   * Hook for integrators who want timing without pulling in OTel. Called once
   * per completed (or failed) phase.
   */
  onEvent?: (event: EscrowInstrumentationEvent) => void;
  /**
   * Include account addresses in span attributes. Default `false` — see
   * threat model T9. Only enable this when your trace backend is cleared for
   * the addresses involved.
   */
  includeAddresses?: boolean;
}

const SPAN_PREFIX = "escrow.";

export function spanName(name: EscrowSpanName): string {
  return `${SPAN_PREFIX}${name}`;
}

/** True when the options actually do something; used to skip all work. */
export function isInstrumentationEnabled(options: InstrumentationOptions | undefined): options is InstrumentationOptions {
  return Boolean(options && (options.tracer || options.onEvent));
}

function toOtelAttributes(attributes: EscrowSpanAttributes): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Run `work` inside one span and emit one `onEvent`. With instrumentation
 * disabled this is a straight `return work()` — no clock read, no allocation
 * of a span, no try/catch that changes behaviour.
 */
export async function tracePhase<T>(
  options: InstrumentationOptions | undefined,
  name: EscrowSpanName,
  attributes: EscrowSpanAttributes,
  work: () => Promise<T>,
): Promise<T> {
  if (!isInstrumentationEnabled(options)) return work();

  const startedAt = Date.now();
  const span = options.tracer?.startSpan(spanName(name), { attributes: toOtelAttributes(attributes) });
  let failure: unknown;
  try {
    const result = await work();
    span?.setStatus({ code: 1 });
    return result;
  } catch (error) {
    failure = error;
    span?.recordException(error instanceof Error ? error : new Error(String(error)));
    span?.setStatus({ code: 2, message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    span?.end();
    if (options.onEvent) {
      try {
        options.onEvent({
          name,
          spanName: spanName(name),
          durationMs: Date.now() - startedAt,
          attributes: { ...attributes },
          ...(failure !== undefined ? { error: failure } : {}),
        });
      } catch {
        // An observability hook must never break a payment.
      }
    }
  }
}

/**
 * An in-progress span for phases whose boundaries live inside a callback
 * (submit ends at `onSubmitted`; confirm ends when polling finishes).
 * Disabled instrumentation gets a no-op handle with a mutable attribute bag.
 */
export interface PhaseSpan {
  readonly attributes: EscrowSpanAttributes;
  /** Mark the phase as started (only needed when confirm starts mid-flight). */
  start(): void;
  end(error?: unknown): void;
}

export function beginPhase(
  options: InstrumentationOptions | undefined,
  name: EscrowSpanName,
  attributes: EscrowSpanAttributes,
): PhaseSpan {
  if (!isInstrumentationEnabled(options)) {
    return { attributes, start() {}, end() {} };
  }

  let startedAt = Date.now();
  let span: EscrowSpan | undefined;
  let ended = false;
  const open = () => {
    span = options.tracer?.startSpan(spanName(name), { attributes: toOtelAttributes(attributes) });
    startedAt = Date.now();
  };
  if (name !== "confirm") open();

  return {
    attributes,
    start() {
      if (!span) open();
    },
    end(error?: unknown) {
      if (ended) return;
      ended = true;
      span = span ?? options.tracer?.startSpan(spanName(name), { attributes: toOtelAttributes(attributes) });
      // Attributes such as `tx.hash` and `retry.count` are only known at the
      // end; re-apply the whole bag so the tracer sees the final values.
      if (span) {
        for (const [key, value] of Object.entries(toOtelAttributes(attributes))) {
          span.setAttribute(key, value);
        }
      }
      if (error !== undefined) {
        span?.recordException(error instanceof Error ? error : new Error(String(error)));
        span?.setStatus({ code: 2, message: error instanceof Error ? error.message : String(error) });
      } else {
        span?.setStatus({ code: 1 });
      }
      span?.end();
      if (options.onEvent) {
        try {
          options.onEvent({
            name,
            spanName: spanName(name),
            durationMs: Date.now() - startedAt,
            attributes: { ...attributes },
            ...(error !== undefined ? { error } : {}),
          });
        } catch {
          // Ignore observer failures.
        }
      }
    },
  };
}

/**
 * Resolve the OpenTelemetry API at call time. Returns `undefined` when the
 * optional peer dependency isn't installed, so callers can pass the result
 * straight into `InstrumentationOptions.tracer` without a guard.
 *
 * ```ts
 * const instrumentation = { tracer: await otelTracer(), onEvent: console.debug };
 * ```
 */
export async function otelTracer(options: { tracerName?: string; version?: string } = {}): Promise<EscrowTracer | undefined> {
  try {
    // A variable specifier keeps TypeScript/bundlers from requiring the
    // optional peer at build time. Vite/Rollup leaves it as a runtime import.
    const specifier = "@opentelemetry/api";
    const api = (await import(/* @vite-ignore */ specifier)) as {
      trace?: { getTracer(name: string, version?: string): EscrowTracer };
    };
    return api.trace?.getTracer(options.tracerName ?? "@docforum/escrow-sdk", options.version);
  } catch {
    return undefined;
  }
}
