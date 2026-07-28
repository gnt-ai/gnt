import open from "open";
import { API_URL } from "../config.js";
import { loadApiKey } from "../credentials.js";
import { dim, fail, muted, ok, spinner, text } from "../theme.js";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export async function connectSlack(): Promise<void> {
  const key = loadApiKey();

  const res = await fetch(`${API_URL}/v1/slack/install-url?origin=cli`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.error(fail(`Failed to start Slack connect (${res.status}).`));
    process.exit(1);
  }
  const { url } = await res.json();

  console.log(dim(url));
  try {
    await open(url);
  } catch {
    console.log(text("Couldn't open a browser automatically — open the URL above manually."));
  }
  const wait = spinner("Waiting for you to finish in the browser…");

  try {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const summary = await fetch(`${API_URL}/v1/brain/summary`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (summary.ok) {
        const data = await summary.json();
        if (data.slack_connected) {
          wait.stop(ok("Slack connected."));
          return;
        }
      }
    }
    wait.stop(muted("Still waiting — run `gnt status` once you've finished in the browser."));
  } catch (err) {
    wait.stop();
    throw err;
  }
}
