/**
 * The viewer page's DOM glue: renders the model (`model.ts`) fed by the live
 * stream (`stream.ts`). Untrusted content (every value of a frame) only ever
 * reaches the page through `textContent`: never parsed as HTML.
 */

import {
  capturedOf,
  type ConnectionState,
  type DeliveryStatus,
  type Entry,
  formatClock,
  type GapEntry,
  NONE,
  RenderQueue,
  sourceLabel,
  type StreamEvent,
  type TraceEntry,
  TraceStore,
  type WireTraceDocument,
} from "./model";
import { startLiveStream } from "./stream";

/** Until `/api/config` or the stream's hello tells the configured capacity. */
const DEFAULT_CAPACITY = 1000;

// --- DOM helpers: elements and text only ---

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`viewer page: #${id} missing`);
  return element as T;
}

type Child = Node | string;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.append(...children);
  return element;
}

const text = (value: unknown): string =>
  value === undefined || value === null || value === "" ? NONE : String(value);

// --- Page state ---

const ui = {
  connection: byId("connection"),
  connectionMessage: byId("connection-message"),
  received: byId("count-received"),
  sessions: byId("count-sessions"),
  scroll: byId("list-scroll"),
  rows: byId<HTMLTableSectionElement>("rows"),
  empty: byId("empty"),
  detail: byId("detail"),
};

const store = new TraceStore(DEFAULT_CAPACITY);
const rows = new Map<number, HTMLTableRowElement>();
let selected: TraceEntry | undefined;

/**
 * Which entries are listed: every one for now. Filters plug in here; a filter
 * change rebuilds the list from `store.entries()`.
 */
function isVisible(_entry: Entry): boolean {
  return true;
}

// --- Batched rendering: one DOM update per animation frame ---

const pending = new RenderQueue((key) => rows.has(key));
let frame: number | undefined;
let detailDirty = false;

function schedule(): void {
  frame ??= requestAnimationFrame(flush);
}

function evicted(entries: readonly Entry[]): void {
  pending.evict(entries);
}

function flush(): void {
  frame = undefined;
  const batch = pending.take();
  for (const key of batch.removed) {
    rows.get(key)?.remove();
    rows.delete(key);
    if (selected?.key === key) {
      selected = undefined;
      showNoSelection();
    }
  }
  const atBottom = ui.scroll.scrollTop + ui.scroll.clientHeight >= ui.scroll.scrollHeight - 4;
  const fragment = document.createDocumentFragment();
  for (const entry of batch.added) {
    if (!isVisible(entry)) continue;
    const row = rowFor(entry);
    rows.set(entry.key, row);
    fragment.append(row);
  }
  ui.rows.append(fragment);
  for (const entry of batch.changed) {
    const row = rows.get(entry.key);
    if (row) fillRow(row, entry);
  }
  if (atBottom) ui.scroll.scrollTop = ui.scroll.scrollHeight;

  if (detailDirty && selected) renderDetail(selected);
  detailDirty = false;

  ui.received.textContent = store.received.toLocaleString("en");
  ui.sessions.textContent = store.sessions.toLocaleString("en");
  ui.empty.hidden = store.size > 0;
}

// --- Rows ---

function rowFor(entry: Entry): HTMLTableRowElement {
  const row = el("tr");
  row.dataset.key = String(entry.key);
  if (entry.kind === "trace") {
    row.tabIndex = 0;
    row.addEventListener("click", () => select(entry));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(entry);
      }
    });
  }
  fillRow(row, entry);
  return row;
}

function fillRow(row: HTMLTableRowElement, entry: Entry): void {
  if (entry.kind === "gap") {
    row.className = "gap";
    const cell = el("td", undefined, gapText(entry));
    cell.colSpan = 7;
    row.replaceChildren(cell);
    return;
  }
  const s = entry.summary;
  row.className = `message type-${s.type.toLowerCase()}${s.ignored ? " ignored" : ""}`;
  row.classList.toggle("selected", entry === selected);
  row.setAttribute("aria-selected", String(entry === selected));
  const action = el("span", s.correlated ? "action correlated" : "action", s.action);
  if (s.correlated) action.title = "Action of the CALL this response answers";
  const details =
    s.type === "unparsed"
      ? `unparsed: ${s.reason ?? NONE}`
      : `${s.messageId} · OCPP ${s.ocppVersion}`;
  row.replaceChildren(
    el("td", "time", s.time),
    el("td", "what", el("span", "cp", s.chargePointId), " ", action, el("span", "sub", details)),
    el("td", "type", el("span", `pill type-${s.type.toLowerCase()}`, s.type)),
    el(
      "td",
      `direction ${s.direction}`,
      `${s.arrow} ${s.direction === "cp-to-csms" ? "to CSMS" : "to charger"}`,
    ),
    el("td", "tenant", s.tenant),
    el("td", "source", s.source, ...(s.ignored ? [el("span", "pill ignored", "ignored")] : [])),
    el("td", "delivery", statusPill(s.delivery)),
  );
}

function statusPill(status: DeliveryStatus | typeof NONE): HTMLElement {
  return el("span", status === NONE ? "pill" : `pill status-${status}`, status);
}

function gapText(gap: GapEntry): string {
  if (gap.reason === "missed") {
    const count = gap.missed ?? 0;
    return `${count} event${count === 1 ? "" : "s"} missed: this page fell behind the stream (${formatClock(gap.from)}${gap.to ? ` – ${formatClock(gap.to)}` : ""}).`;
  }
  const span = gap.to
    ? `between ${formatClock(gap.from)} and ${formatClock(gap.to)}`
    : `since ${formatClock(gap.from)}`;
  const restart = gap.restarted ? " The gateway restarted meanwhile." : "";
  return `Possible gap ${span}: the live stream was interrupted. Messages from this period are not recovered.${restart}`;
}

// --- Detail ---

function select(entry: TraceEntry): void {
  const previous = selected && rows.get(selected.key);
  previous?.classList.remove("selected");
  previous?.setAttribute("aria-selected", "false");
  selected = entry;
  const row = rows.get(entry.key);
  row?.classList.add("selected");
  row?.setAttribute("aria-selected", "true");
  renderDetail(entry);
}

function showNoSelection(): void {
  ui.detail.replaceChildren(el("p", "hint", "Select a message to see its content."));
}

function field(list: HTMLDListElement, label: string, value: unknown): void {
  list.append(el("dt", undefined, label), el("dd", undefined, text(value)));
}

function json(value: unknown): string {
  return value === undefined ? NONE : JSON.stringify(value, null, 2);
}

/** Rendered on selection only, so a large payload costs nothing until opened. */
function renderDetail(entry: TraceEntry): void {
  const { doc } = entry;
  const captured = capturedOf(doc);
  const { gateway } = captured.meta;
  const sections: HTMLElement[] = [];

  const status = el("p", "copy-status");
  status.setAttribute("role", "status");
  sections.push(
    el(
      "div",
      "copy-actions",
      copyButton(
        doc.kind === "trace" ? "Copy trace JSON" : "Copy frame JSON",
        () => JSON.stringify(captured, null, 2),
        status,
      ),
      copyButton("Copy raw frame", () => captured.raw, status),
      status,
    ),
  );

  const record = el("dl", "fields");
  if (doc.kind === "trace") {
    const { trace } = doc;
    field(record, "Schema version", trace.schemaVersion);
    field(record, "Timestamp", trace.timestamp);
    field(record, "OCPP version", trace.ocppVersion);
    field(record, "Charge point", trace.chargePointId);
    field(record, "Direction", trace.direction);
    field(record, "Message type", trace.messageType);
    field(record, "Message ID", trace.messageId);
    field(record, "Action", trace.action);
    if (trace.connectorId !== undefined) field(record, "Connector", trace.connectorId);
    sections.push(section("Open OCPP Trace", record));
    if (trace.messageType === "CALLERROR" && trace.error) {
      const error = el("dl", "fields");
      field(error, "Code", trace.error.code);
      field(error, "Description", trace.error.description);
      sections.push(section("Error", error));
      if (trace.error.details !== undefined) {
        sections.push(
          section("Error details (JSON)", el("pre", "code", json(trace.error.details))),
        );
      }
    }
    if (trace.messageType !== "CALLERROR" || trace.payload !== undefined) {
      sections.push(section("Payload (JSON)", el("pre", "code", json(trace.payload))));
    }
  } else {
    const { frame } = doc;
    field(record, "Reason", frame.reason);
    field(record, "Timestamp", frame.timestamp);
    field(record, "OCPP version", frame.ocppVersion);
    field(record, "Charge point", frame.chargePointId);
    field(record, "Direction", frame.direction);
    sections.push(
      section(
        "Unparsed frame",
        el("p", "note", "This frame could not be read as an Open OCPP Trace record."),
        record,
      ),
    );
  }

  const meta = el("dl", "fields");
  field(meta, "Tenant ID", gateway.tenantId);
  field(meta, "Session ID", gateway.sessionId);
  field(meta, "Trace ID", gateway.traceId);
  field(meta, "Sequence", gateway.seq);
  field(meta, "Source", sourceLabel(gateway.source));
  field(
    meta,
    "Destinations",
    gateway.destinations.length === 0
      ? undefined
      : gateway.destinations.map((d) => `${d.target} (${d.role})`).join(", "),
  );
  field(
    meta,
    "Correlation",
    gateway.correlation &&
      `answers the ${gateway.correlation.action} CALL ${gateway.correlation.callTraceId}`,
  );
  field(meta, "Ignored", gateway.ignored ? "yes: a secondary's frame, never forwarded" : "no");
  if (gateway.binary) field(meta, "Binary", "yes: received as a binary message");
  sections.push(section("Gateway", meta));

  sections.push(deliveriesSection(doc));
  sections.push(section("Raw frame", el("pre", "code raw", captured.raw)));
  ui.detail.replaceChildren(...sections);
}

function section(title: string, ...content: Child[]): HTMLElement {
  return el("section", "detail-section", el("h3", undefined, title), ...content);
}

function deliveriesSection(doc: WireTraceDocument): HTMLElement {
  const note = el(
    "p",
    "note",
    "“written” means written to the socket, not acknowledged by the CSMS or the charger.",
  );
  if (doc.deliveries.length === 0) {
    return section("Deliveries", el("p", undefined, "Routed nowhere."), note);
  }
  const head = el(
    "tr",
    undefined,
    ...["Destination", "Role", "Status", "Updated", "Reason"].map((h) => {
      const th = el("th", undefined, h);
      th.scope = "col";
      return th;
    }),
  );
  const body = el(
    "tbody",
    undefined,
    ...doc.deliveries.map((d) =>
      el(
        "tr",
        undefined,
        el("td", undefined, text(d.target)),
        el("td", undefined, text(d.role)),
        el("td", undefined, statusPill(d.status)),
        el("td", undefined, text(d.updatedAt)),
        el("td", undefined, text(d.reason)),
      ),
    ),
  );
  return section("Deliveries", el("table", "deliveries", el("thead", undefined, head), body), note);
}

function copyButton(label: string, value: () => string, status: HTMLElement): HTMLButtonElement {
  const button = el("button", "copy", label);
  button.type = "button";
  button.addEventListener("click", () => {
    const done = (message: string) => (status.textContent = message);
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) {
      done("Copy unavailable here: select the text instead.");
      return;
    }
    clipboard.writeText(value()).then(
      () => done("Copied."),
      () => done("Copy failed: select the text instead."),
    );
  });
  return button;
}

// --- Connection state ---

const STATE_LABELS: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  connected: "Live",
  disconnected: "Disconnected",
  reconnecting: "Reconnecting…",
  "auth-failed": "Authentication failed",
};

function showState(state: ConnectionState, retryInMs?: number): void {
  ui.connection.textContent = STATE_LABELS[state];
  ui.connection.className = `badge badge-${state}`;
  let message: string | undefined;
  if (state === "disconnected") {
    message = `The live stream is down${retryInMs === undefined ? "" : `; retrying in ${Math.ceil(retryInMs / 1000)} s`}. Messages already shown stay available.`;
  } else if (state === "auth-failed") {
    message =
      "Authentication failed: reload the page to enter your credentials again. Messages already shown stay available.";
  }
  ui.connectionMessage.hidden = message === undefined;
  ui.connectionMessage.textContent = message ?? "";
}

// --- Stream events ---

const iso = (ms: number) => new Date(ms).toISOString();

/** A received message enters the page here: pausing plugs in. */
function ingest(doc: WireTraceDocument): void {
  const { added, evicted: out } = store.addTrace(doc);
  pending.add(added);
  evicted(out);
  schedule();
}

function onEvent(event: StreamEvent): void {
  switch (event.type) {
    case "hello":
      evicted(store.setCapacity(event.hello.maxBufferedMessages));
      break;
    case "trace":
      ingest(event.doc);
      return;
    case "delivery": {
      const entry = store.applyDelivery(event.update);
      if (!entry) return;
      pending.change(entry);
      if (entry === selected) detailDirty = true;
      break;
    }
    case "gap":
      addGap(store.addGap({ reason: "missed", at: iso(Date.now()), missed: event.dropped }));
      return;
  }
  schedule();
}

function addGap({ added, evicted: out }: { added: GapEntry; evicted: Entry[] }): void {
  pending.upsert(added);
  evicted(out);
  schedule();
}

async function loadCapacity(): Promise<void> {
  try {
    const response = await fetch("/api/config", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return;
    const config = (await response.json()) as { maxBufferedMessages?: unknown };
    if (Number.isInteger(config.maxBufferedMessages)) {
      evicted(store.setCapacity(config.maxBufferedMessages as number));
      schedule();
    }
  } catch {
    // The stream's hello carries the same value.
  }
}

void loadCapacity();
startLiveStream({
  onState: showState,
  onEvent,
  onLost: (at) => addGap(store.addGap({ reason: "disconnected", at: iso(at) })),
  onConnected: ({ reconnected, restarted }) => {
    if (!reconnected) return;
    const gap = store.closeGap(iso(Date.now()), restarted);
    if (gap) addGap({ added: gap, evicted: [] });
  },
});
