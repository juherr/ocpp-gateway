import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { configureLogger } from "../src/logger";
import type { TraceSink } from "../src/trace/writer";
import { connectWhenOpen, startGateway, waitFor, waitForClose } from "./helpers";
import { MemoryTraceSink } from "./trace/memory-sink";

/**
 * Size of each CALLRESULT the CSMS answers with: large, so that a charger that
 * stops reading fills the host's TCP buffers, and then the gateway's own, in a
 * few dozen answers whatever the kernel's settings.
 */
const ANSWER_BYTES = 256 * 1024;
const MAX_MESSAGE_BYTES = 2 * ANSWER_BYTES;

const SATURATED = "send buffer full, closing the charger";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  configureLogger({ logLevel: "error" });
});

const call = (id: number) => JSON.stringify([2, String(id), "Heartbeat", {}]);

/**
 * A gateway routing every charger to one primary CSMS that answers each CALL
 * with a CALLRESULT of `answerBytes`, then calls `onCall`.
 */
async function setup({
  answerBytes = ANSWER_BYTES,
  traceSink = undefined as TraceSink | undefined,
} = {}) {
  const csms = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    maxPayload: MAX_MESSAGE_BYTES,
    handleProtocols: (protocols) => (protocols.has("ocpp1.6") ? "ocpp1.6" : false),
  });
  await once(csms, "listening");
  cleanups.push(() => csms.close());
  const calls: { answered: number; onCall?: () => void } = { answered: 0 };
  const padding = "x".repeat(answerBytes);
  const upstream = new Promise<WebSocket>((resolve) => {
    csms.once("connection", (ws) => {
      ws.on("message", (data) => {
        const [, id] = JSON.parse(data.toString()) as [number, string];
        ws.send(JSON.stringify([3, id, { padding }]));
        calls.answered++;
        calls.onCall?.();
      });
      resolve(ws);
    });
  });

  const { port } = csms.address() as AddressInfo;
  const gateway = await startGateway(
    { default: { primary: { id: "csms-main", url: `ws://127.0.0.1:${port}` }, secondaries: [] } },
    { maxMessageBytes: MAX_MESSAGE_BYTES },
    { traceSink },
  );
  cleanups.push(() => gateway.close());
  const charger = await connectWhenOpen(`ws://127.0.0.1:${gateway.port}/CP-001`, "ocpp1.6");
  cleanups.push(() => charger.terminate());
  return { charger, upstream: await upstream, calls };
}

/** The ids of the next `count` answers the charger reads. */
function answersOf(charger: WebSocket, count: number) {
  const ids: string[] = [];
  return new Promise<string[]>((resolve) => {
    charger.on("message", (data) => {
      ids.push((JSON.parse(data.toString()) as [number, string])[1]);
      if (ids.length === count) resolve(ids);
    });
  });
}

const idsUpTo = (count: number) => Array.from({ length: count }, (_, i) => String(i));

describe("buffered data frames", () => {
  it("returns every answer to a charger that waits for each one, far beyond the bound", async () => {
    const { charger } = await setup();
    const COUNT = 200;
    const answers = answersOf(charger, COUNT);

    // One CALL at a time, as OCPP requires: 200 × 256 KiB = 50 MiB in total.
    let next = 0;
    charger.on("message", () => {
      if (next < COUNT) charger.send(call(next++));
    });
    charger.send(call(next++));

    expect(await answers).toEqual(idsUpTo(COUNT));
    expect(charger.readyState).toBe(WebSocket.OPEN);
  }, 30_000);

  it("returns every answer to a charger that sends a burst after reconnecting", async () => {
    const { charger } = await setup({ answerBytes: 1024 });
    const BURST = 200;
    const answers = answersOf(charger, BURST);

    for (let i = 0; i < BURST; i++) charger.send(call(i));

    expect(await answers).toEqual(idsUpTo(BURST));
    expect(charger.readyState).toBe(WebSocket.OPEN);
  });

  it("ends the session of a charger that sends CALLs without reading", async () => {
    const warnings: Record<string, unknown>[] = [];
    configureLogger({
      logLevel: "warn",
      sink: {
        stdout: (line) => warnings.push(JSON.parse(line) as Record<string, unknown>),
        stderr: () => undefined,
      },
    });
    await flood(await setup());

    const saturated = warnings.filter(({ msg }) => msg === SATURATED);
    expect(saturated).toEqual([
      expect.objectContaining({ link: "charger", maxBufferedBytes: 1024 * 1024 }),
    ]);
    expect(saturated[0].bufferedAmount).toBeGreaterThan(1024 * 1024);
    expect(saturated[0].bufferedAmount).toBeLessThanOrEqual(1024 * 1024 + MAX_MESSAGE_BYTES);
  }, 30_000);

  it("settles the trace of every answer once the charger is cut", async () => {
    const sink = new MemoryTraceSink();
    const session = await setup({ traceSink: sink });
    await flood(session);
    // The write callbacks of the frames still buffered run as the socket goes.
    await waitFor(() => answerOutcomes(sink).every(([status]) => status !== "submitted"));

    const outcomes = answerOutcomes(sink);
    expect(outcomes).toHaveLength(session.calls.answered);
    // The answer that found the charger full was never handed to it.
    expect(outcomes.filter(([, reason]) => reason === "link-saturated")).toHaveLength(1);
    // Those still buffered when it was cut (over the bound, so some were) fail
    // with the socket's error, as on any link that goes away.
    expect(outcomes.filter(([status]) => status === "failed").length).toBeGreaterThan(0);
    // Answers sent after the cut: the link was already closing.
    for (const [status, reason] of outcomes) {
      expect(["written", "failed", "dropped"]).toContain(status);
      if (status === "dropped") expect(["link-saturated", "link-not-open"]).toContain(reason);
    }
  }, 30_000);
});

/** Status and reason of the delivery to the charger of each CSMS answer, in order. */
function answerOutcomes(sink: MemoryTraceSink) {
  return sink.docs
    .filter((doc) => doc.deliveries[0]?.role === "charge-point")
    .map((doc) => [doc.deliveries[0].status, doc.deliveries[0].reason] as const);
}

/**
 * Make the charger stop reading while it keeps a few CALLs on their way (the
 * next leaves once the CSMS has answered one), until the session ends.
 */
async function flood({ charger, upstream, calls }: Awaited<ReturnType<typeof setup>>) {
  // Bound before flooding: the end of the session closes the primary link.
  const primaryClosed = waitForClose(upstream, 15_000);
  charger.pause();
  let next = 0;
  const send = () => {
    if (charger.readyState === WebSocket.OPEN) charger.send(call(next++));
  };
  calls.onCall = send;
  for (let i = 0; i < 4; i++) send();

  try {
    await expect(primaryClosed).resolves.toMatchObject({ code: 1000 });
  } finally {
    calls.onCall = undefined;
  }
}
