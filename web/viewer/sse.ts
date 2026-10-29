/**
 * An incremental Server-Sent Events parser, following the WHATWG event stream
 * format. It takes text: the caller decodes bytes with a streaming
 * `TextDecoder`, so a UTF-8 sequence split across chunks stays whole.
 */

export interface SseEvent {
  /** The `event:` field, `"message"` when absent. */
  event: string;
  data: string;
}

export class SseParser {
  /** The current line's text so far, one chunk at a time: no line ending in it. */
  private pending: string[] = [];
  private started = false;
  /** The previous chunk ended with CR: an LF opening this one ends nothing. */
  private skipLeadingLf = false;
  private data: string[] = [];
  private eventType = "";

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
    // Only the new text is scanned: the pending chunks hold no line ending, so
    // a large event pushed in small chunks costs linear time, not quadratic.
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char !== "\n" && char !== "\r") continue;
      let line = text.slice(start, i);
      if (this.pending.length > 0) {
        this.pending.push(line);
        line = this.pending.join("");
        this.pending = [];
      }
      this.line(line);
      if (char === "\r") {
        if (i + 1 === text.length) this.skipLeadingLf = true;
        else if (text[i + 1] === "\n") i++;
      }
      start = i + 1;
    }
    if (start < text.length) this.pending.push(text.slice(start));
  }

  /** The stream is over: an event without its blank line is never dispatched. */
  end(): void {
    this.pending = [];
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
    // Other fields (`id`, `retry`) are ignored: the stream carries no history to resume.
    if (field === "data") this.data.push(value);
    else if (field === "event") this.eventType = value;
  }

  private dispatch(): void {
    if (this.data.length > 0) {
      const event: SseEvent = { event: this.eventType || "message", data: this.data.join("\n") };
      this.reset();
      this.onEvent(event);
      return;
    }
    this.reset();
  }

  private reset(): void {
    this.data = [];
    this.eventType = "";
  }
}
