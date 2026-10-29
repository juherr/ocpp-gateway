/**
 * The viewer page's DOM glue: renders the model (`model.ts`) fed by the live
 * stream (`stream.ts`). Untrusted content (every value of a frame) only ever
 * reaches the page through `textContent`: never parsed as HTML.
 */

import {
  type AddResult,
  capturedOf,
  type ConnectionState,
  type DeliveryStatus,
  EMPTY_FILTER,
  type Entry,
  exportFilename,
  type FilterState,
  filterPredicate,
  formatClock,
  type GapEntry,
  isFilterActive,
  jsonlLines,
  listedEntries,
  membershipChanges,
  NONE,
  type ObservedValues,
  RenderQueue,
  shortId,
  sourceLabel,
  type StreamEvent,
  type TraceEntry,
  TraceStore,
  type WireTraceDocument,
} from "./model";
import { type Builder, buildTokens, HIGHLIGHT_MAX_CHARS, jsonTokens } from "./highlight";
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
  shown: byId("count-shown"),
  evicted: byId("count-evicted"),
  pendingCounter: byId("counter-pending"),
  pending: byId("count-pending"),
  droppedCounter: byId("counter-dropped"),
  dropped: byId("count-dropped"),
  scroll: byId("list-scroll"),
  rows: byId<HTMLTableSectionElement>("rows"),
  empty: byId("empty"),
  detail: byId("detail"),
  pause: byId<HTMLButtonElement>("pause"),
  filterReset: byId<HTMLButtonElement>("filter-reset"),
  actionStatus: byId("action-status"),
};

const filterUi = {
  tenant: byId<HTMLSelectElement>("filter-tenant"),
  chargePointId: byId<HTMLInputElement>("filter-cp"),
  chargePointOptions: byId<HTMLDataListElement>("filter-cp-options"),
  sessionId: byId<HTMLInputElement>("filter-session"),
  direction: byId<HTMLSelectElement>("filter-direction"),
  messageType: byId<HTMLSelectElement>("filter-type"),
  action: byId<HTMLSelectElement>("filter-action"),
  source: byId<HTMLSelectElement>("filter-source"),
  messageId: byId<HTMLInputElement>("filter-message-id"),
  delivery: byId<HTMLSelectElement>("filter-delivery"),
  text: byId<HTMLInputElement>("filter-text"),
};

const store = new TraceStore(DEFAULT_CAPACITY);
const rows = new Map<number, HTMLTableRowElement>();
/** The message of each row showing one (the others show gap markers), by key. */
const messageRows = new Map<number, TraceEntry>();
/** The delivery status each message row shows, so an unchanged one is not drawn again. */
const shownDelivery = new WeakMap<HTMLTableRowElement, string>();
let selected: TraceEntry | undefined;
/** The selected message's Deliveries section, refreshed on its own. */
let detailDeliveries: HTMLElement | undefined;

let filter: FilterState = { ...EMPTY_FILTER };
/** Which entries are listed: those the filters let through, gap markers always. */
let visible = filterPredicate(filter);

function deselect(): void {
  selected = undefined;
  showNoSelection();
}

// --- Batched rendering: one DOM update per animation frame ---

const pending = new RenderQueue((key) => rows.has(key));
let frame: number | undefined;
let detailDirty = false;
/** The filters changed: the next frame lists `store.entries()` again. */
let rebuildDue = false;
/** Listed messages whose delivery changed while filtering by delivery status. */
const refilter = new Map<number, TraceEntry>();

function schedule(): void {
  frame ??= requestAnimationFrame(flush);
}

function evicted(entries: readonly Entry[]): void {
  pending.evict(entries);
  for (const entry of entries) {
    refilter.delete(entry.key);
    // A selected message hidden by the filters has no row whose removal would clear it.
    if (entry === selected && !rows.has(entry.key)) deselect();
  }
}

function register(entry: Entry, row: HTMLTableRowElement): void {
  rows.set(entry.key, row);
  if (entry.kind === "trace") messageRows.set(entry.key, entry);
}

function addRow(entry: Entry, before?: Node | null): HTMLTableRowElement {
  const row = rowFor(entry);
  register(entry, row);
  if (before !== undefined) ui.rows.insertBefore(row, before);
  return row;
}

function removeRow(key: number): void {
  rows.get(key)?.remove();
  rows.delete(key);
  messageRows.delete(key);
}

/**
 * Lists `store.entries()` again through the filters, keeping the rows
 * already built (refreshed if their entry changed) and creating the others.
 */
function rebuild(): void {
  const { changed } = pending.take();
  refilter.clear();
  const built = new Map(rows);
  rows.clear();
  messageRows.clear();
  const fragment = document.createDocumentFragment();
  for (const entry of store.entries()) {
    if (!visible(entry)) continue;
    const row = built.get(entry.key);
    if (!row) {
      fragment.append(addRow(entry));
      continue;
    }
    register(entry, row);
    fragment.append(row);
  }
  for (const entry of changed) {
    const row = built.get(entry.key);
    if (row && rows.has(entry.key)) refreshRow(row, entry);
  }
  ui.rows.replaceChildren(fragment);
  // A selected message evicted in the same frame: its removal was not drawn.
  if (selected && store.get(selected.doc.id) !== selected) deselect();
}

/**
 * A listed message whose delivery changed may now pass the delivery filter,
 * or no longer: its row is inserted in reception order, or removed. Paused,
 * rows only change state: they wait for the resume to come or go.
 */
function applyRefilter(): void {
  // Paused, the changed messages wait for the first frame after the resume.
  if (refilter.size === 0 || store.paused) return;
  const { insert, remove } = membershipChanges(
    store.entries(),
    isListed,
    refilter.values(),
    visible,
  );
  refilter.clear();
  for (const key of remove) removeRow(key);
  for (const { entry, beforeKey } of insert) {
    addRow(entry, beforeKey === null ? null : (rows.get(beforeKey) ?? null));
  }
}

const isListed = (key: number): boolean => rows.has(key);

function flush(): void {
  frame = undefined;
  const atBottom = ui.scroll.scrollTop + ui.scroll.clientHeight >= ui.scroll.scrollHeight - 4;
  if (rebuildDue) {
    rebuildDue = false;
    rebuild();
  } else {
    const batch = pending.take();
    for (const key of batch.removed) {
      removeRow(key);
      if (selected?.key === key) deselect();
    }
    const fragment = document.createDocumentFragment();
    for (const entry of batch.added) {
      if (visible(entry)) fragment.append(addRow(entry));
    }
    ui.rows.append(fragment);
    for (const entry of batch.changed) {
      const row = rows.get(entry.key);
      if (row) refreshRow(row, entry);
    }
    applyRefilter();
  }
  if (atBottom) ui.scroll.scrollTop = ui.scroll.scrollHeight;

  if (detailDirty && selected) refreshDeliveries(selected);
  detailDirty = false;

  refreshOptions();
  showCounters();
}

function showCounters(): void {
  const count = (value: number) => value.toLocaleString("en");
  ui.received.textContent = count(store.received);
  ui.sessions.textContent = count(store.sessions);
  ui.shown.textContent = count(messageRows.size);
  ui.evicted.textContent = count(store.evictedMessages);
  ui.pending.textContent = count(store.pendingMessages);
  ui.dropped.textContent = count(store.pendingDropped);
  ui.pendingCounter.hidden = !store.paused;
  ui.droppedCounter.hidden = store.pendingDropped === 0;
  ui.pause.textContent = store.paused
    ? `Resume${store.pendingMessages > 0 ? ` (${count(store.pendingMessages)} new)` : ""}`
    : "Pause";
  ui.pause.setAttribute("aria-pressed", String(store.paused));
  ui.empty.hidden = rows.size > 0;
  ui.filterReset.disabled = !isFilterActive(filter);
  ui.empty.textContent =
    store.size > 0 && isFilterActive(filter)
      ? "No message matches the filters."
      : store.paused
        ? "Paused: new messages are held until you resume."
        : "Waiting for OCPP traffic…";
}

// --- Filters ---

/** A tenant option's value for messages without a tenant: never a tenant id (a DNS label). */
const NO_TENANT = "(none)";
const NO_TENANT_LABEL = "No tenant";

function readFilter(): FilterState {
  const tenant = filterUi.tenant.value;
  return {
    tenant: tenant === NO_TENANT ? null : tenant,
    chargePointId: filterUi.chargePointId.value,
    sessionId: filterUi.sessionId.value,
    direction: filterUi.direction.value as FilterState["direction"],
    messageType: filterUi.messageType.value as FilterState["messageType"],
    action: filterUi.action.value,
    source: filterUi.source.value,
    messageId: filterUi.messageId.value,
    delivery: filterUi.delivery.value as FilterState["delivery"],
    text: filterUi.text.value,
  };
}

/** How long typing in a text filter waits before the list follows. */
const TYPING_DELAY_MS = 200;
let typingTimer: ReturnType<typeof setTimeout> | undefined;

function filterTyped(): void {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(filtersChanged, TYPING_DELAY_MS);
}

/** Applies the filters now, a pending typing delay included. */
function filtersChanged(): void {
  clearTimeout(typingTimer);
  typingTimer = undefined;
  filter = readFilter();
  visible = filterPredicate(filter);
  // A select may have kept a value no longer observed: drop it at the next refresh.
  filledVersions.clear();
  rebuildDue = true;
  schedule();
}

function resetFilters(): void {
  for (const control of Object.values(filterUi)) {
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
      control.value = "";
    }
  }
  filtersChanged();
}

let optionsVersion = -1;

/** A control offering one kind of observed values, and how its options are refilled. */
interface OptionList<K extends keyof ObservedValues = keyof ObservedValues> {
  kind: K;
  fill(values: ObservedValues[K]): void;
}

const optionList = <K extends keyof ObservedValues>(
  kind: K,
  fill: (values: ObservedValues[K]) => void,
): OptionList => ({ kind, fill }) as OptionList;

const optionLists = new Map<HTMLElement, OptionList>([
  [
    filterUi.tenant,
    optionList("tenants", (tenants) =>
      fillSelect(
        filterUi.tenant,
        tenants.map((t) => (t === null ? [NO_TENANT, NO_TENANT_LABEL] : [t, t])),
      ),
    ),
  ],
  [
    filterUi.action,
    optionList("actions", (actions) =>
      fillSelect(
        filterUi.action,
        actions.map((a) => [a, a]),
      ),
    ),
  ],
  [
    filterUi.source,
    optionList("sources", (sources) =>
      fillSelect(
        filterUi.source,
        sources.map((s) => [s, s]),
      ),
    ),
  ],
  [
    filterUi.chargePointId,
    optionList("chargePointIds", (ids) =>
      filterUi.chargePointOptions.replaceChildren(...ids.map((id) => option(id))),
    ),
  ],
]);
/** The `observedVersionOf` each control's options were filled from. */
const filledVersions = new Map<HTMLElement, number>();
/** Controls skipped while focused: refreshed when they lose the focus. */
const staleOptions = new Set<HTMLElement>();

function refill(control: HTMLElement, { kind, fill }: OptionList): void {
  staleOptions.delete(control);
  filledVersions.set(control, store.observedVersionOf(kind));
  fill(store.observedValues(kind));
}

/**
 * The option lists, from the buffered messages' values, each refreshed only
 * when its values change and never under the focus (an open list, typing in
 * the charge point field). A selected value no longer observed stays
 * selectable.
 */
function refreshOptions(): void {
  if (store.observedVersion === optionsVersion) return;
  optionsVersion = store.observedVersion;
  for (const [control, list] of optionLists) {
    if (filledVersions.get(control) === store.observedVersionOf(list.kind)) continue;
    if (control === document.activeElement) staleOptions.add(control);
    else refill(control, list);
  }
}

for (const [control, list] of optionLists) {
  control.addEventListener("blur", () => {
    if (staleOptions.has(control)) refill(control, list);
  });
}

/** An `<option>`; without a label, the browser shows its value (a datalist suggestion). */
function option(value: string, label?: string): HTMLOptionElement {
  const element = label === undefined ? el("option") : el("option", undefined, label);
  element.value = value;
  return element;
}

function fillSelect(select: HTMLSelectElement, options: [value: string, label: string][]): void {
  const current = select.value;
  if (current !== "" && !options.some(([value]) => value === current)) {
    options.push([current, current === NO_TENANT ? NO_TENANT_LABEL : current]);
  }
  select.replaceChildren(
    option("", "Any"),
    ...options.map(([value, label]) => option(value, label)),
  );
  select.value = current;
}

for (const control of Object.values(filterUi)) {
  if (control instanceof HTMLSelectElement) control.addEventListener("change", filtersChanged);
  else if (control instanceof HTMLInputElement) control.addEventListener("input", filterTyped);
}
ui.filterReset.addEventListener("click", resetFilters);

// --- Pause, clear ---

function togglePause(): void {
  if (!store.paused) {
    store.pause();
  } else {
    const { added, evicted: out } = store.resume();
    for (const entry of added) pending.add(entry);
    evicted(out);
  }
  schedule();
}

/** Empties this page's list and held messages: the gateway and its archive are untouched. */
function clearList(): void {
  store.clear();
  deselect();
  rebuildDue = true;
  ui.actionStatus.textContent = "List cleared; the gateway and its archive are not affected.";
  schedule();
}

ui.pause.addEventListener("click", togglePause);
byId("clear").addEventListener("click", clearList);

// --- Export ---

const EXPORT_WARNING =
  "This file contains raw, unmasked OCPP data: RFID tags, authorization tokens, transaction ids and possibly personal data. Keep it private.";

function exportJsonl(kind: "trace" | "frame", entries: readonly Entry[], what: string): void {
  const count = entries.reduce(
    (n, e) => n + (e.kind === "trace" && e.doc.kind === kind ? 1 : 0),
    0,
  );
  if (count === 0) {
    ui.actionStatus.textContent = `Nothing to export: no ${what} in the list.`;
    return;
  }
  if (!window.confirm(`${EXPORT_WARNING}\n\nExport ${count.toLocaleString("en")} ${what}?`)) {
    ui.actionStatus.textContent = "Export cancelled.";
    return;
  }
  const blob = new Blob(jsonlLines(entries, kind), { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const link = el("a");
  link.href = url;
  link.download = exportFilename(kind, new Date());
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  ui.actionStatus.textContent = `Exported ${count.toLocaleString("en")} ${what} to ${link.download}.`;
}

byId("export-filtered").addEventListener("click", () =>
  // Exactly the listed rows: the frozen list while paused, not the filters evaluated again.
  exportJsonl("trace", listedEntries(store.entries(), isListed), "trace records (filtered)"),
);
byId("export-all").addEventListener("click", () =>
  exportJsonl("trace", store.entries(), "trace records"),
);
byId("export-frames").addEventListener("click", () =>
  exportJsonl("frame", store.entries(), "unparsed frames"),
);

// --- Rows ---

function rowFor(entry: Entry): HTMLTableRowElement {
  const row = el("tr");
  row.dataset.key = String(entry.key);
  if (entry.kind === "trace") row.tabIndex = 0;
  fillRow(row, entry);
  return row;
}

/** The message of the row an event happened in; none for a gap marker's row. */
function messageOf(event: Event): TraceEntry | undefined {
  const row = event.target instanceof Element ? event.target.closest("tr") : null;
  if (row?.parentElement !== ui.rows) return undefined;
  return messageRows.get(Number(row.dataset.key));
}

// One listener for every row: selecting by click, Enter or Space.
ui.rows.addEventListener("click", (event) => {
  const entry = messageOf(event);
  if (entry) select(entry);
});
ui.rows.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const entry = messageOf(event);
  if (!entry) return;
  event.preventDefault();
  select(entry);
});

/** The index of a message row's delivery cell (see `fillRow`). */
const DELIVERY_CELL = 6;

/**
 * Draws a changed entry again. A message only changes by its deliveries: its
 * row is left alone when the status it shows is the same, otherwise only the
 * status cell is replaced.
 */
function refreshRow(row: HTMLTableRowElement, entry: Entry): void {
  if (entry.kind === "gap") return fillRow(row, entry);
  const status = entry.summary.delivery;
  if (shownDelivery.get(row) === status) return;
  shownDelivery.set(row, status);
  row.cells[DELIVERY_CELL].replaceChildren(statusPill(status));
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
  // Each part wraps as a whole; the line breaks only between parts.
  const part = (className: string, value: string) => el("span", className, value);
  const details =
    s.type === "unparsed"
      ? [part("part reason", `unparsed: ${s.reason ?? NONE}`)]
      : [part("part message-id", s.messageId), " · ", part("part", `OCPP ${s.ocppVersion}`)];
  const session = part("part session", `session ${shortId(s.sessionId)}`);
  session.title = `Session ID ${s.sessionId}`;
  row.replaceChildren(
    el("td", "time", s.time),
    el(
      "td",
      "what",
      el("span", "cp", s.chargePointId),
      " ",
      action,
      el("span", "sub", ...details, " · ", session),
    ),
    el("td", "type", el("span", `pill type-${s.type.toLowerCase()}`, s.type)),
    el(
      "td",
      `direction ${s.direction}`,
      `${s.arrow} ${s.direction === "cp-to-csms" ? "to CSMS" : "to charger"}`,
    ),
    el("td", "tenant", s.tenant),
    el(
      "td",
      "source",
      el("span", "part", s.source),
      ...(s.ignored ? [el("span", "pill ignored", "ignored")] : []),
    ),
    el("td", "delivery", statusPill(s.delivery)),
  );
  shownDelivery.set(row, s.delivery);
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

/** Prism's tokens as spans and text nodes: never parsed as HTML. */
const domBuilder: Builder<Node> = {
  text: (value) => document.createTextNode(value),
  span: (className, children) => el("span", className, ...children),
};

/**
 * A value as pretty JSON, highlighted unless too large (then plain, with a
 * note). Built when the detail opens, never on a delivery update.
 */
function jsonBlock(value: unknown): HTMLElement[] {
  const pretty = json(value);
  const pre = el("pre", "code json");
  const tokens = value === undefined ? null : jsonTokens(pretty);
  if (tokens === null) {
    pre.textContent = pretty;
    return value !== undefined && pretty.length > HIGHLIGHT_MAX_CHARS
      ? [el("p", "note", "Highlighting disabled for this large payload."), pre]
      : [pre];
  }
  const fragment = document.createDocumentFragment();
  for (const node of buildTokens(tokens, domBuilder)) fragment.append(node);
  pre.append(fragment);
  return [pre];
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
        sections.push(section("Error details (JSON)", ...jsonBlock(trace.error.details)));
      }
    }
    if (trace.messageType !== "CALLERROR" || trace.payload !== undefined) {
      sections.push(section("Payload (JSON)", ...jsonBlock(trace.payload)));
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

  detailDeliveries = deliveriesSection(doc);
  sections.push(detailDeliveries);
  sections.push(section("Raw frame", el("pre", "code raw", captured.raw)));
  ui.detail.replaceChildren(...sections);
}

/**
 * A delivery update on the selected message replaces its Deliveries section
 * only: the payload is not rendered again, and the copy feedback and the
 * scroll position stay.
 */
function refreshDeliveries(entry: TraceEntry): void {
  if (!detailDeliveries?.isConnected) return renderDetail(entry);
  const next = deliveriesSection(entry.doc);
  detailDeliveries.replaceWith(next);
  detailDeliveries = next;
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

/** A received message enters the page here; paused, the store holds it unlisted. */
function ingest(doc: WireTraceDocument): void {
  const { added, evicted: out } = store.addTrace(doc);
  if (added) pending.add(added);
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
      if (filter.delivery !== "") refilter.set(entry.key, entry);
      if (entry === selected) detailDirty = true;
      break;
    }
    case "gap":
      addGap(store.addGap({ reason: "missed", at: iso(Date.now()), missed: event.dropped }));
      return;
  }
  schedule();
}

/** Paused, the store holds a new gap marker in place among the held messages. */
function addGap({ added, evicted: out }: AddResult<GapEntry>): void {
  if (added) pending.upsert(added);
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

showCounters();
void loadCapacity();
startLiveStream({
  onState: showState,
  onEvent,
  onLost: (at) => addGap(store.addGap({ reason: "disconnected", at: iso(at) })),
  onConnected: ({ reconnected, restarted }) => {
    if (!reconnected) return;
    const gap = store.closeGap(iso(Date.now()), restarted);
    // A gap not drawn yet is drawn in its latest state; a held one, on resume.
    if (gap) {
      pending.change(gap);
      schedule();
    }
  },
});
