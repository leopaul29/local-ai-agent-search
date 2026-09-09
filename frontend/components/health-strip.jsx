import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { SearchIcon } from "lucide-react";
import { toast } from "sonner";

import { SERVICES, transitions } from "@/lib/health";
import { hostOf } from "@/lib/history";
import { Badge } from "@/components/ui/badge";

const POLL_MS = 5000;
const WAITING = "waiting for the first probe";

// One context for the page. Browsers cap how many can exist at once, and a suspended one
// costs nothing, so it is kept rather than opened and closed per alarm.
let audio;

/** Two short descending tones. No audio file, so nothing to load before it can fire. */
const alarm = () => {
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (!Context) return;
  audio ??= new Context();

  // Browsers start a context suspended until the page has been interacted with. A
  // rejected resume means no sound this time, never a broken poll.
  audio.resume().catch(() => {});

  for (const [hertz, at] of [
    [880, 0],
    [560, 0.18],
  ]) {
    const start = audio.currentTime + at;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();

    oscillator.type = "triangle";
    oscillator.frequency.value = hertz;
    // Ramped rather than switched: a square edge on the gain is an audible click.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);

    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.18);
  }
};

const dotClass = (up) =>
  up === true
    ? "bg-emerald-500"
    : up === false
      ? "bg-destructive animate-pulse"
      : "bg-muted-foreground/40";

/** Every page the searches turned up this session. */
function SessionLog({ history }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium">
          {history.length === 0
            ? "No page seen yet this session"
            : `${history.length} page${history.length === 1 ? "" : "s"} seen this session`}
        </p>

        {/* Capped and scrollable: a long session would otherwise push the card off-screen. */}
        <ul className="flex max-h-64 list-none flex-col gap-1 overflow-y-auto">
          {history.map((page) => (
            <li key={page.url} className="flex flex-col">
              <a
                href={page.url}
                target="_blank"
                rel="noreferrer"
                title={page.url}
                className={cn(
                  "truncate text-xs underline-offset-4 hover:underline",
                  page.dead && "text-muted-foreground line-through",
                )}
              >
                {hostOf(page.url)}
              </a>
              <span className="truncate text-[0.7rem] text-muted-foreground">
                {page.dead ? `unreachable (${page.status ?? "no response"})` : page.title || page.url}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="border-t pt-2 text-[0.7rem] text-muted-foreground">
        Returned by <code>ddgs</code>, which rotates over Brave, DuckDuckGo, Google, Mojeek,
        Startpage, Wikipedia and Yahoo. Resets when the page reloads.
      </p>
    </div>
  );
}

/** Live up/down for every service a question depends on, polled on a timer. */
export function HealthStrip({ api, history = [] }) {
  const [health, setHealth] = useState({});
  const previous = useRef({});

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      let next;
      try {
        const response = await fetch(`${api}/api/health`);
        if (!response.ok) throw new Error(`responded with ${response.status}`);
        next = { backend: { up: true, detail: api }, ...(await response.json()) };
      } catch (error) {
        next = { backend: { up: false, detail: error.message } };
      }
      if (cancelled) return;

      for (const change of transitions(previous.current, next)) {
        if (change.down) {
          alarm();
          toast.error(`${change.label} went down`, {
            description: change.detail,
            duration: Infinity,
          });
        } else {
          toast.success(`${change.label} is back`);
        }
      }

      previous.current = next;
      setHealth(next);
    };

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api]);

  const broken = SERVICES.filter(({ key }) => health[key]?.up === false);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {SERVICES.map(({ key, label }) => (
          <Badge
            key={key}
            variant={health[key]?.up === false ? "destructive" : "outline"}
            title={health[key]?.detail ?? WAITING}
            className="gap-1.5 font-normal"
          >
            <span className={cn("size-1.5 rounded-full", dotClass(health[key]?.up))} />
            {label}
          </Badge>
        ))}

        {/* Not a probe: ddgs runs inside the backend, so there is nothing separate to be up
            or down. The count sits here because this is where you look to see what the
            searches did. Click to open: the log is a list of links, and a card that closes
            when the pointer leaves is a bad place to put links. */}
        <details className="relative">
          <summary className="list-none marker:content-none">
            <Badge
              variant="outline"
              className="cursor-pointer gap-1.5 font-normal"
              title="Pages seen this session"
            >
              <SearchIcon className="size-3" />
              {history.length}
            </Badge>
          </summary>
          <div className="absolute end-0 z-50 mt-1 w-80 rounded-lg bg-popover p-2.5 text-start text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <SessionLog history={history} />
          </div>
        </details>
      </div>

      {/* Spelled out as well as coloured: the point is to see which one broke without hovering. */}
      {broken.map(({ key, label }) => (
        <p
          key={key}
          className="max-w-md truncate text-end text-xs text-destructive"
          title={health[key].detail}
        >
          {label}: {health[key].detail}
        </p>
      ))}
    </div>
  );
}
