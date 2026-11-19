import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  MAX_PENDING_FORWARDED_CONTROL_FRAMES,
  forwardPing,
  forwardPong,
  rawDataToString,
} from "../src/utils/websocket";

describe("rawDataToString", () => {
  it("converts a Buffer", () => {
    expect(rawDataToString(Buffer.from("message"))).toBe("message");
  });

  it("converts an ArrayBuffer", () => {
    expect(rawDataToString(new Uint8Array([109, 115, 103]).buffer)).toBe("msg");
  });

  it("concatenates Buffer fragments", () => {
    expect(rawDataToString([Buffer.from("mes"), Buffer.from("sage")])).toBe("message");
  });
});

type Callback = (error?: Error) => void;

/** A target socket that keeps the write callbacks of its pings and pongs, like a peer not reading. */
function fakeTarget() {
  const target = {
    readyState: WebSocket.OPEN as number,
    sent: [] as { kind: "ping" | "pong"; data: Buffer }[],
    callbacks: [] as Callback[],
    error: null as Error | null,
    ping(data: Buffer, _mask: undefined, callback: Callback) {
      if (target.error) throw target.error;
      target.sent.push({ kind: "ping", data });
      target.callbacks.push(callback);
    },
    pong(data: Buffer, _mask: undefined, callback: Callback) {
      if (target.error) throw target.error;
      target.sent.push({ kind: "pong", data });
      target.callbacks.push(callback);
    },
    /** Write out the oldest pending frame, as ws does once the peer reads. */
    drain(error?: Error) {
      target.callbacks.shift()!(error);
    },
  };
  return target;
}

const asSocket = (target: ReturnType<typeof fakeTarget>) => target as unknown as WebSocket;
const payload = Buffer.from("keepalive");

describe.each([
  { kind: "pong" as const, forward: forwardPong },
  { kind: "ping" as const, forward: forwardPing },
])("$kind forwarding", ({ kind, forward }) => {
  it("forwards the payload to an open target", () => {
    const target = fakeTarget();
    expect(forward(asSocket(target), payload)).toBe("sent");
    expect(target.sent).toEqual([{ kind, data: payload }]);
  });

  it("skips a target that is missing or not open", () => {
    const target = fakeTarget();
    target.readyState = WebSocket.CLOSING;
    expect(forward(asSocket(target), payload)).toBe("skipped");
    expect(forward(null, payload)).toBe("skipped");
    expect(target.sent).toEqual([]);
  });

  it(`refuses the frame once ${MAX_PENDING_FORWARDED_CONTROL_FRAMES} are not written out`, () => {
    const target = fakeTarget();
    for (let i = 0; i < MAX_PENDING_FORWARDED_CONTROL_FRAMES; i++) {
      expect(forward(asSocket(target), payload)).toBe("sent");
    }
    expect(forward(asSocket(target), payload)).toBe("over-cap");
    expect(target.sent).toHaveLength(MAX_PENDING_FORWARDED_CONTROL_FRAMES);
  });

  it("frees a slot once a frame is written out, or fails to be", () => {
    const target = fakeTarget();
    for (let i = 0; i < MAX_PENDING_FORWARDED_CONTROL_FRAMES; i++)
      forward(asSocket(target), payload);
    target.drain();
    expect(forward(asSocket(target), payload)).toBe("sent");
    target.drain(new Error("socket closed"));
    expect(forward(asSocket(target), payload)).toBe("sent");
    expect(forward(asSocket(target), payload)).toBe("over-cap");
  });

  it("frees the slot of a frame whose send throws", () => {
    const target = fakeTarget();
    for (let i = 0; i < MAX_PENDING_FORWARDED_CONTROL_FRAMES - 1; i++) {
      forward(asSocket(target), payload);
    }
    target.error = new Error("not open");
    expect(forward(asSocket(target), payload)).toBe("skipped");
    target.error = null;
    expect(forward(asSocket(target), payload)).toBe("sent");
    expect(forward(asSocket(target), payload)).toBe("over-cap");
  });

  it("forwards at a normal rate indefinitely", () => {
    const target = fakeTarget();
    for (let i = 0; i < MAX_PENDING_FORWARDED_CONTROL_FRAMES * 10; i++) {
      expect(forward(asSocket(target), payload)).toBe("sent");
      target.drain();
    }
  });
});

describe("pending forwarded control frames", () => {
  it("counts pings and pongs to the same target together", () => {
    const target = fakeTarget();
    const half = MAX_PENDING_FORWARDED_CONTROL_FRAMES / 2;
    for (let i = 0; i < half; i++) forwardPing(asSocket(target), payload);
    for (let i = 0; i < half; i++) forwardPong(asSocket(target), payload);
    expect(forwardPing(asSocket(target), payload)).toBe("over-cap");
    expect(forwardPong(asSocket(target), payload)).toBe("over-cap");
  });

  it("counts each target separately", () => {
    const stalled = fakeTarget();
    const reading = fakeTarget();
    for (let i = 0; i < MAX_PENDING_FORWARDED_CONTROL_FRAMES; i++) {
      forwardPong(asSocket(stalled), payload);
    }
    expect(forwardPong(asSocket(stalled), payload)).toBe("over-cap");
    expect(forwardPong(asSocket(reading), payload)).toBe("sent");
  });
});
