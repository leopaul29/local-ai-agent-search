// Self-check for the session URL log. No React, no network, no browser.
//
// Run:  node test-history.mjs

import assert from "node:assert/strict";

import { historyOf } from "./lib/history.js";

const page = (url, extra = {}) => ({ url, title: url, snippet: "", dead: false, ...extra });
const turn = (...results) => ({ searches: [{ query: "q", results }] });

// Nothing asked yet, and turns that never searched: no log, no crash.
assert.deepEqual(historyOf([]), []);
assert.deepEqual(historyOf([{ question: "2 + 2", searches: [] }]), []);
assert.deepEqual(historyOf([{ question: "2 + 2" }]), []);

// Most recently seen first, so the pages in play sit at the top of the card.
assert.deepEqual(
  historyOf([turn(page("https://a"), page("https://b")), turn(page("https://c"))]).map((r) => r.url),
  ["https://c", "https://b", "https://a"],
);

// A URL a later question turns up again moves to the top rather than appearing twice.
assert.deepEqual(
  historyOf([turn(page("https://a"), page("https://b")), turn(page("https://a"))]).map((r) => r.url),
  ["https://a", "https://b"],
);

// Repeats keep the newer copy: a page that has since gone dead must not read as alive.
const [newest] = historyOf([turn(page("https://a")), turn(page("https://a", { dead: true, status: 404 }))]);
assert.equal(newest.dead, true);
assert.equal(newest.status, 404);

// Several searches inside one question all land in the log.
assert.equal(
  historyOf([{ searches: [{ results: [page("https://a")] }, { results: [page("https://b")] }] }]).length,
  2,
);

// Dead pages stay: the log is what the search returned, not what the model was given.
assert.equal(historyOf([turn(page("https://gone", { dead: true }))]).length, 1);

// A row with no URL is dropped rather than becoming an empty entry.
assert.deepEqual(historyOf([turn(page(""), page("https://a"))]).map((r) => r.url), ["https://a"]);

console.log("ok");
