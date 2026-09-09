// The backend is first because it is the one that probes the other two: when it is
// unreachable, nothing is known about them.
export const SERVICES = [
  { key: "backend", label: "Backend" },
  { key: "ollama", label: "Model" },
  { key: "searxng", label: "SearXNG" },
];

/**
 * The up/down changes between two health snapshots that are worth announcing.
 *
 * Changes only: a service that has never been up never nags, which matters because
 * SearXNG is optional and normally not running.
 */
export const transitions = (before, after) => {
  // With the backend down its probes are unknown rather than false. One toast about the
  // backend beats three about everything sitting downstream of it.
  const watched = after.backend?.up ? SERVICES : SERVICES.slice(0, 1);

  return watched.flatMap(({ key, label }) => {
    const was = before[key]?.up;
    const now = after[key]?.up;

    if (was === now) return [];
    if (was === true) return [{ key, label, down: true, detail: after[key]?.detail ?? "no answer" }];
    if (was === false && now === true) return [{ key, label, down: false }];
    return [];
  });
};
