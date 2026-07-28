import { writeFileSync } from "node:fs";
import { API_URL } from "../config.js";
import { loadApiKey } from "../credentials.js";
import { fail, muted, ok } from "../theme.js";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)}KB` : `${(kb / 1024).toFixed(1)}MB`;
}

export async function pull(): Promise<void> {
  const key = loadApiKey();
  const res = await fetch(`${API_URL}/v1/skill-packs/latest.zip`, {
    headers: { Authorization: `Bearer ${key}` },
  });

  if (res.status === 404) {
    console.log(muted("No skill pack yet."));
    return;
  }
  if (!res.ok) {
    console.error(fail(`Failed to download skill pack (${res.status}).`));
    process.exit(1);
  }

  const disposition = res.headers.get("Content-Disposition") ?? "";
  const rawFilename = disposition.match(/filename=([^;]+)/)?.[1]?.split(/[/\\]/).pop();
  // Content-Disposition's filename ends up in a filesystem write below — strip
  // any path components and reject "."/".." rather than trusting the header,
  // even though it's our own API today.
  const filename = rawFilename && rawFilename !== "." && rawFilename !== ".." ? rawFilename : "gnt-pack.zip";
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(filename, buffer);
  console.log(ok(`Saved ${filename} (${formatSize(buffer.length)})`));
}
