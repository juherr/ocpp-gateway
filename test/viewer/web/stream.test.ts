import { describe, expect, it } from "vitest";
import {
  type ConnectionState,
  ConnectionMachine,
  type StreamEvent,
} from "../../../web/viewer/model";
import { type LiveStreamHandlers, startLiveStream } from "../../../web/viewer/stream";

const HELLO = `event: hello\ndata: {"serverTime":"t","startedAt":"s1","maxBufferedMessages":10}\n\n`;

/** A response whose body yields `chunks`, then ends (or stays open). */
function streamResponse(chunks: Uint8Array[] | string[], open = false): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      if (!open) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface Harness {
  states: { state: ConnectionState; retryInMs?: number }[];
  events: StreamEvent[];
  lost: number[];
  connected: { reconnected: boolean; restarted: boolean }[];
  timers: { fn: () => void; ms: number }[];
  requests: RequestInit[];
  stop: () => void;
}

function run(responses: (() => Response | Promise<Response>)[]): Harness {
  const harness: Harness = {
    states: [],
    events: [],
    lost: [],
    connected: [],
    timers: [],
    requests: [],
    stop: () => undefined,
  };
  const handlers: LiveStreamHandlers = {
    onState: (state, retryInMs) => harness.states.push({ state, retryInMs }),
    onEvent: (event) => harness.events.push(event),
    onLost: (at) => harness.lost.push(at),
    onConnected: (result) => harness.connected.push(result),
  };
  let call = 0;
  let clock = 0;
  const stream = startLiveStream(handlers, {
    fetch: async (_url, init) => {
      harness.requests.push(init ?? {});
      const next = responses[call++];
      if (!next) throw new TypeError("no more responses");
      return next();
    },
    machine: new ConnectionMachine({ random: () => 1 }),
    now: () => (clock += 100),
    schedule: (fn, ms) => harness.timers.push({ fn, ms }),
  });
  harness.stop = stream.stop;
  return harness;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("startLiveStream", () => {
  it("fetches /events with the page's credentials, and connects on hello", async () => {
    const h = run([() => streamResponse([HELLO, 'event: gap\ndata: {"dropped":2}\n\n'], true)]);
    await settle();

    expect(h.requests[0]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    expect(h.states.map((s) => s.state)).toEqual(["connecting", "connected"]);
    expect(h.events.map((e) => e.type)).toEqual(["hello", "gap"]);
    expect(h.connected).toEqual([{ reconnected: false, restarted: false }]);
    h.stop();
  });

  it("decodes UTF-8 split across chunks", async () => {
    const bytes = new TextEncoder().encode(`${HELLO}event: gap\ndata: {"dropped":1,"x":"é"}\n\n`);
    const cut = bytes.indexOf(0xc3) + 1;
    const h = run([() => streamResponse([bytes.slice(0, cut), bytes.slice(cut)], true)]);
    await settle();
    expect(h.events.map((e) => e.type)).toEqual(["hello", "gap"]);
    h.stop();
  });

  it("stops for good on 401", async () => {
    const h = run([() => new Response("Unauthorized\n", { status: 401 })]);
    await settle();
    expect(h.states.at(-1)).toEqual({ state: "auth-failed", retryInMs: undefined });
    expect(h.timers).toEqual([]);
  });

  it("retries a refused or failed attempt with backoff, honouring Retry-After", async () => {
    const h = run([
      () => new Response("Too Many Requests\n", { status: 429, headers: { "retry-after": "5" } }),
      () => Promise.reject(new TypeError("network")),
      () => streamResponse([HELLO], true),
    ]);
    await settle();
    expect(h.states.at(-1)).toEqual({ state: "disconnected", retryInMs: 5000 });

    h.timers.shift()?.fn();
    await settle();
    expect(h.states.slice(-2)).toEqual([
      { state: "reconnecting", retryInMs: undefined },
      { state: "disconnected", retryInMs: 2000 },
    ]);
    expect(h.lost).toEqual([]);
    h.stop();
  });

  it("opens a gap when an established stream ends, and reports the reconnection", async () => {
    const h = run([
      () => streamResponse([HELLO]),
      () => streamResponse([HELLO.replace("s1", "s2")], true),
    ]);
    await settle();
    expect(h.lost).toHaveLength(1);
    expect(h.states.at(-1)?.state).toBe("disconnected");

    h.timers.shift()?.fn();
    await settle();
    expect(h.connected.at(-1)).toEqual({ reconnected: true, restarted: true });
    expect(h.states.at(-1)?.state).toBe("connected");
    h.stop();
  });

  it("does nothing more once stopped", async () => {
    const h = run([() => streamResponse([HELLO])]);
    h.stop();
    await settle();
    expect(h.timers).toEqual([]);
    expect(h.lost).toEqual([]);
  });
});
