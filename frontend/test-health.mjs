// Self-check for the health transition rules. No React, no network, no browser.
//
// Run:  node test-health.mjs

import assert from "node:assert/strict";

import { transitions } from "./lib/health.js";

const UP = { backend: { up: true }, ollama: { up: true } };

// Nothing changed: nothing is announced, however many times the poll runs.
assert.deepEqual(transitions(UP, UP), []);

// The first poll is not a transition — a service that starts down must not alarm.
assert.deepEqual(transitions({}, UP), []);
assert.deepEqual(transitions({}, { backend: { up: false, detail: "Failed to fetch" } }), []);

// Still down is not news either, or a dead Ollama would alarm every five seconds.
const noModel = { ...UP, ollama: { up: false, detail: "connection refused" } };
assert.deepEqual(transitions(noModel, noModel), []);

// Ollama stops: one alarm, carrying the reason the backend gave.
assert.deepEqual(transitions(UP, noModel), [
  { key: "ollama", label: "Model", down: true, detail: "connection refused" },
]);

// Reachable Ollama, unpulled model: down, with the command that fixes it.
const unpulled = transitions(UP, { ...UP, ollama: { up: false, detail: "not pulled — run: ollama pull x" } });
assert.match(unpulled[0].detail, /ollama pull/);

// The backend itself dies. Ollama is now unknown, not down, so exactly one thing is
// announced rather than two.
assert.deepEqual(transitions(UP, { backend: { up: false, detail: "Failed to fetch" } }), [
  { key: "backend", label: "Backend", down: true, detail: "Failed to fetch" },
]);

// Coming back is announced too, so a fixed service does not leave a stale red toast.
assert.deepEqual(transitions({ ...UP, ollama: { up: false } }, UP), [
  { key: "ollama", label: "Model", down: false },
]);

// Backend returns with Ollama still down: only the recovery, and no alarm for the service
// the page never saw up.
assert.deepEqual(
  transitions({ backend: { up: false } }, { ...UP, ollama: { up: false, detail: "refused" } }),
  [{ key: "backend", label: "Backend", down: false }],
);

// Both go at once. The backend is reported first, because it is the one to look at.
assert.deepEqual(
  transitions(UP, { backend: { up: false, detail: "Failed to fetch" }, ollama: { up: false } }).map(
    (change) => change.key,
  ),
  ["backend"],
);

console.log("ok");
