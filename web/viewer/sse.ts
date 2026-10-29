/**
 * An incremental Server-Sent Events parser, following the WHATWG event stream
 * format. It takes text: the caller decodes bytes with a streaming
 * `TextDecoder`, so a UTF-8 sequence split across chunks stays whole.
 */

export interface SseEvent {
  /** The `event:` field, `"message"` when absent. */
  event: string;
  data: string;
  /**
   * This event's own `id:` field. Unlike the browser's `lastEventId`, it is
   * not carried over to later events: the viewer's stream only numbers trace
   * events.
   */
  id?: string;
}

export class SseParser {
  private buffer = "";
  private started = false;
  /** The previous chunk ended with CR: an LF opening this one ends nothing. */
  private skipLeadingLf = false;
  private data: string[] = [];
  private eventType = "";
  private eventId: string | undefined;

  constructor(private readonly onEvent: (event: SseEvent) => void) {}

  push(chunk: string): void {
    let text = chunk;
    if (this.skipLeadingLf && text.length > 0) {
      this.skipLeadingLf = false;
      if (text[0] === "\n") text = text.slice(1);
    }
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text[0] === "﻿") text = text.slice(1);
    }
    this.buffer += text;

    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const char = this.buffer[i];
      if (char !== "\n" && char !== "\r") continue;
      this.line(this.buffer.slice(start, i));
      if (char === "\r") {
        if (i + 1 === this.buffer.length) this.skipLeadingLf = true;
        else if (this.buffer[i + 1] === "\n") i++;
      }
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
  }

  /** The stream is over: an event without its blank line is never dispatched. */
  end(): void {
    this.buffer = "";
    this.skipLeadingLf = false;
    this.reset();
  }

  private line(line: string): void {
    if (line === "") return this.dispatch();
    if (line[0] === ":") return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value[0] === " ") value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.eventType = value;
    else if (field === "id" && !value.includes("\0")) this.eventId = value;
  }

  private dispatch(): void {
    if (this.data.length > 0) {
      const event: SseEvent = { event: this.eventType || "message", data: this.data.join("\n") };
      if (this.eventId !== undefined) event.id = this.eventId;
      this.reset();
      this.onEvent(event);
      return;
    }
    this.reset();
  }

  private reset(): void {
    this.data = [];
    this.eventType = "";
    this.eventId = undefined;
  }
}
