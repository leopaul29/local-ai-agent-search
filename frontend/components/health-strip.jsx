import { Fragment, useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { toast } from "sonner";

import { SERVICES, transitions } from "@/lib/health";
import { hostOf } from "@/lib/history";
import { Badge } from "@/components/ui/badge";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

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

/** The state of the chip, then every page the searches turned up this session. */
function SessionLog({ detail, history }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">SearXNG: {detail ?? WAITING}</p>

      <div className="flex flex-col gap-1 border-t pt-2">
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

      {/* Worth saying on the chip that shows them: these did not come from SearXNG. */}
      <p className="border-t pt-2 text-[0.7rem] text-muted-foreground">
        Returned by DuckDuckGo through <code>ddgs</code>. Nothing calls SearXNG yet, so this chip
        only reports whether the container is up.
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
        {SERVICES.map(({ key, label }) => {
          // The search chip opens the session log on hover; the other two say their state in
          // a native tooltip, which the card would only sit on top of.
          const opensLog = key === "searxng";
          const chip = (
            <Badge
              variant={health[key]?.up === false ? "destructive" : "outline"}
              title={opensLog ? undefined : (health[key]?.detail ?? WAITING)}
              className="gap-1.5 font-normal"
            >
              <span className={cn("size-1.5 rounded-full", dotClass(health[key]?.up))} />
              {label}
            </Badge>
          );

          return opensLog ? (
            <HoverCard key={key}>
              <HoverCardTrigger render={<span className="cursor-default" />}>{chip}</HoverCardTrigger>
              <HoverCardContent align="end" className="w-80">
                <SessionLog detail={health[key]?.detail} history={history} />
              </HoverCardContent>
            </HoverCard>
          ) : (
            <Fragment key={key}>{chip}</Fragment>
          );
        })}
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
