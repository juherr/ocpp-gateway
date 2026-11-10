/**
 * The experimental page: the gateway's live stream shown in the Open OCPP
 * Trace standalone viewer. The transport, the SSE parser, the event decoder
 * and the connection state machine are the classic page's own
 * (../viewer/stream.ts, sse.ts, model.ts); this page only adds the mapping
 * to viewer entries (feed.ts) and mounts the viewer on the first hello, with
 * as many entries as the gateway buffers. Stream text is only ever set with
 * `textContent`; the viewer renders entries itself, inside a shadow root.
 */

import {
  type ExportScope,
  type JsonlExport,
  mount,
  type ViewerInstance,
} from "@open-ocpp-trace/viewer-standalone";
import { type ConnectionState, exportFilename } from "../viewer/model";
import { startLiveStream } from "../viewer/stream";
import { createGatewayFeed } from "./feed";

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`the page has no #${id} element`);
  return element;
}

const connection = byId("connection");
const notice = byId("notice");
const viewerHost = byId("viewer");

const COUNTERS = {
  received: byId("count-received"),
  listed: byId("count-listed"),
  pending: byId("count-pending"),
  evicted: byId("count-evicted"),
  droppedPending: byId("count-dropped-pending"),
  droppedByServer: byId("count-dropped-by-server"),
  deliveryUpdates: byId("count-delivery-updates"),
  ignoredUpdates: byId("count-ignored-updates"),
  invalid: byId("count-invalid"),
  skipped: byId("count-skipped"),
};

const STATE_LABELS: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  connected: "Live",
  disconnected: "Disconnected",
  reconnecting: "Reconnecting…",
  "auth-failed": "Authentication failed",
};

const EXPORT_WARNING =
  "This file contains raw, unmasked OCPP data: RFID tags, authorization tokens, transaction ids and possibly personal data. Keep it private.";

function showNotice(text: string | undefined): void {
  notice.hidden = text === undefined;
  notice.textContent = text ?? "";
}

function showState(state: ConnectionState, retryInMs?: number): void {
  connection.dataset["state"] = state;
  connection.textContent = STATE_LABELS[state];
  if (state === "disconnected") {
    const retry = retryInMs === undefined ? "" : `; retrying in ${Math.ceil(retryInMs / 1000)} s`;
    showNotice(`The live stream is down${retry}. Messages already shown stay available.`);
  } else if (state === "auth-failed") {
    showNotice(
      "Authentication failed: reload the page to enter your credentials again. Messages already shown stay available.",
    );
  } else if (state === "connected") {
    showNotice(undefined);
  }
}

/** Saves the export the user asked for, after the raw-data warning; frames and gaps are never in it. */
function download(exported: JsonlExport, scope: ExportScope): void {
  if (exported.recordCount === 0) {
    showNotice("Nothing to export: no trace record in this scope.");
    return;
  }
  if (!window.confirm(`${EXPORT_WARNING}\n\nExport ${exported.recordCount} trace records?`)) {
    return;
  }
  const url = URL.createObjectURL(new Blob([exported.text], { type: "application/x-ndjson" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = exportFilename("trace", new Date());
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const { unparsed, gap, invalid } = exported.skipped;
  showNotice(
    `Exported ${exported.recordCount} trace records (${scope}) to ${link.download}; left out ` +
      `${unparsed} unparsed frames, ${gap} gaps and ${invalid} invalid records.`,
  );
}

let viewer: ViewerInstance | undefined;
let maxEntries = 0;
let countersQueued = false;
const feed = createGatewayFeed();

const stream = startLiveStream(
  {
    onState: showState,
    onLost: (at) => feed.lost(at),
    onConnected(result, hello) {
      if (viewer === undefined) {
        // The viewer keeps as many entries as the gateway buffers. Its store
        // bounds are fixed when it is mounted, so a restart with another
        // buffer size keeps this one until the page is reloaded.
        maxEntries = hello.maxBufferedMessages;
        viewer = mount(viewerHost, { maxEntries, adapter: feed.adapter, onExport: download });
      } else if (result.restarted && hello.maxBufferedMessages !== maxEntries) {
        showNotice(
          `The gateway restarted with a buffer of ${hello.maxBufferedMessages} messages; ` +
            `this page keeps ${maxEntries} until it is reloaded.`,
        );
      }
      feed.connected(result, hello);
      queueCounters();
    },
    onEvent(event) {
      feed.event(event);
      queueCounters();
    },
  },
  // Relative to the page (served at …/next/), so a reverse proxy's base path is kept.
  { url: "../events" },
);

function queueCounters(): void {
  if (countersQueued) return;
  countersQueued = true;
  requestAnimationFrame(renderCounters);
}

function renderCounters(): void {
  countersQueued = false;
  const own = feed.counters();
  const stats = viewer?.getStats();
  const values: Record<keyof typeof COUNTERS, number> = {
    received: own.received,
    listed: stats?.listed ?? 0,
    pending: stats?.pending ?? 0,
    evicted: stats?.evicted ?? 0,
    droppedPending: stats?.droppedPending ?? 0,
    droppedByServer: own.droppedByServer,
    deliveryUpdates: own.deliveryUpdates,
    ignoredUpdates: own.ignoredUpdates + (stats?.unknownUpdates ?? 0) + (stats?.staleUpdates ?? 0),
    invalid: stats?.invalid ?? 0,
    skipped: stream.skipped,
  };
  for (const key of Object.keys(COUNTERS) as (keyof typeof COUNTERS)[]) {
    COUNTERS[key].textContent = values[key].toLocaleString("en");
  }
}

// The viewer's own actions (pause, resume, clear) change its counters too.
const refresh = setInterval(queueCounters, 1000);

addEventListener("pagehide", () => {
  clearInterval(refresh);
  stream.stop();
  viewer?.unmount();
});
