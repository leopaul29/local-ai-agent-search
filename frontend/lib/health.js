// The backend is first because it is the one that probes the other: when it is
// unreachable, nothing is known about Ollama either.
export const SERVICES = [
  { key: "backend", label: "Backend" },
  { key: "ollama", label: "Model" },
];

/**
 * The up/down changes between two health snapshots that are worth announcing.
 *
 * Changes only, never the current state: the first poll of a service that is already down
 * is not news, and a service that stays down must not re-alarm every five seconds.
 */
export const transitions = (before, after) => {
  // With the backend down, Ollama's state is unknown rather than false. One toast about
  // the backend beats a second one about the thing sitting behind it.
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
