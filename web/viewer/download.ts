/** Saves JSON Lines through a temporary `<a download>`, shared by both viewer pages. */
export function saveJsonl(parts: BlobPart[], filename: string): void {
  const url = URL.createObjectURL(new Blob(parts, { type: "application/x-ndjson" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
