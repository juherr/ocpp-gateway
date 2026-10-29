/**
 * The live stream's transport: `fetch("/events")` read as a stream, rather
 * than `EventSource`, so the page sees a 401 (and stops) and owns the
 * reconnection backoff. DOM-free: it runs in Node too (tests).
 */

import {
  type ConnectionState,
  ConnectionMachine,
  decodeEvent,
  type Failure,
  type Hello,
  responseFailure,
  type StreamEvent,
} from "./model";
import { SseParser } from "./sse";

export interface LiveStreamHandlers {
  /** `retryInMs` is set while `disconnected`, waiting to retry. */
  onState(state: ConnectionState, retryInMs?: number): void;
  onEvent(event: StreamEvent): void;
  /** An established stream was lost at `at` (ms since the epoch): a gap opens. */
  onLost(at: number): void;
  /** A stream said hello: after a loss (`reconnected`), maybe to a restarted gateway. */
  onConnected(result: { reconnected: boolean; restarted: boolean }, hello: Hello): void;
}

export interface LiveStreamOptions {
  url?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Extra request headers; the page relies on the browser's credentials instead. */
  headers?: Record<string, string>;
  machine?: ConnectionMachine;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}

export interface LiveStream {
  /** Stops reading and retrying. Idempotent. */
  stop(): void;
}

export function startLiveStream(
  handlers: LiveStreamHandlers,
  options: LiveStreamOptions = {},
): LiveStream {
  const url = options.url ?? "/events";
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const machine = options.machine ?? new ConnectionMachine();
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel =
    options.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let stopped = false;
  let controller: AbortController | undefined;
  let timer: unknown;

  const fail = (failure: Failure) => {
    if (stopped) return;
    const decision = machine.failed(failure, now());
    if (decision.lostAt !== undefined) handlers.onLost(decision.lostAt);
    handlers.onState(machine.state, decision.retryInMs ?? undefined);
    if (decision.retryInMs === null) return;
    timer = schedule(() => {
      timer = undefined;
      if (stopped) return;
      machine.retrying();
      handlers.onState(machine.state);
      void attempt();
    }, decision.retryInMs);
  };

  const attempt = async () => {
    controller = new AbortController();
    let response: Response;
    try {
      response = await doFetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "text/event-stream", ...options.headers },
        signal: controller.signal,
      });
    } catch {
      return fail({ kind: "network" });
    }
    if (stopped) {
      void response.body?.cancel().catch(() => undefined);
      return;
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      return fail(responseFailure(response.status, response.headers.get("retry-after")));
    }

    const parser = new SseParser((sse) => {
      if (stopped) return;
      const event = decodeEvent(sse);
      if (!event) return;
      if (event.type === "hello") {
        const result = machine.connected(event.hello, now());
        handlers.onState(machine.state);
        handlers.onConnected(result, event.hello);
      }
      handlers.onEvent(event);
    });
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
    } catch {
      // A reset or an abort ends the stream like its end does.
    }
    parser.end();
    fail({ kind: "ended" });
  };

  handlers.onState(machine.state);
  void attempt();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) cancel(timer);
      controller?.abort();
    },
  };
}
