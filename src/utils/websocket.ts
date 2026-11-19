import { isUtf8 } from "node:buffer";
import WebSocket from "ws";

/**
 * Forwarded pings and pongs a target socket may hold before they are written
 * out, like `ws`'s own `maxPendingAutoPongs` (60 by default). Control frames
 * escape `maxPayload`, so without this a peer that sends pings in a loop and
 * stops reading would make the gateway buffer the answers without limit. As
 * with `ws`, a frame counts until its write callback runs, so a burst of more
 * pings than this read at once is refused too, even from a peer that reads.
 */
export const MAX_PENDING_FORWARDED_CONTROL_FRAMES = 60;

/** `sent`: handed to `ws`; `skipped`: target missing or not open; `over-cap`: refused, see above. */
export type ForwardResult = "sent" | "skipped" | "over-cap";

/** Forwarded control frames not yet written out, per target socket. */
const pendingControlFrames = new WeakMap<WebSocket, number>();

function forwardControlFrame(
  ws: WebSocket | null,
  data: Buffer,
  kind: "ping" | "pong",
): ForwardResult {
  if (ws?.readyState !== WebSocket.OPEN) return "skipped";
  const pending = pendingControlFrames.get(ws) ?? 0;
  if (pending >= MAX_PENDING_FORWARDED_CONTROL_FRAMES) return "over-cap";
  pendingControlFrames.set(ws, pending + 1);
  // ws calls back once the frame is written out, or with an error once the
  // socket is gone: either way it no longer holds the frame.
  const release = () => {
    pendingControlFrames.set(ws, (pendingControlFrames.get(ws) ?? 1) - 1);
  };
  try {
    ws[kind](data, undefined, release);
    return "sent";
  } catch {
    /* best-effort — peer may have just closed */
    release();
    return "skipped";
  }
}

export function forwardPing(ws: WebSocket | null, data: Buffer): ForwardResult {
  return forwardControlFrame(ws, data, "ping");
}

export function forwardPong(ws: WebSocket | null, data: Buffer): ForwardResult {
  return forwardControlFrame(ws, data, "pong");
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

export function rawDataToString(data: WebSocket.RawData): string {
  return rawDataToBuffer(data).toString();
}

/** Whether the bytes are valid UTF-8, i.e. decode to text without replacement characters. */
export function isUtf8Data(data: WebSocket.RawData): boolean {
  return isUtf8(rawDataToBuffer(data));
}
