import { Fragment, useState } from "react";
import { ArrowUpIcon, Loader2Icon } from "lucide-react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { HealthStrip } from "@/components/health-strip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Toaster } from "@/components/ui/sonner";

const API = "http://localhost:8000";

/** Fold one server event into the turn being streamed. */
const applyEvent = (turn, event) => {
  switch (event.type) {
    case "thinking":
      return { ...turn, status: "The model is thinking" };
    case "search_start":
      return {
        ...turn,
        status: null,
        searches: [...turn.searches, { query: event.query, running: true }],
      };
    case "search_done":
      return {
        ...turn,
        searches: turn.searches.map((search) =>
          search.running && search.query === event.query
            ? {
                query: event.query,
                ms: event.ms,
                results: event.results,
                duplicates: event.duplicates,
                dead: event.dead,
                running: false,
              }
            : search,
        ),
      };
    case "answer":
      return { ...turn, status: null, answer: event.answer, unretrieved: event.unretrieved };
    case "error":
      return { ...turn, status: null, error: event.error };
    default:
      return turn;
  }
};

/** Only pages that actually answered: these are the ones the model was given. */
const sourcesOf = (turn) =>
  (turn.searches ?? []).flatMap((search) => (search.results ?? []).filter((result) => !result.dead));

/** What the search returned but the model never saw, with the reason. */
const droppedOf = (turn) =>
  (turn.searches ?? []).reduce(
    (total, search) => ({
      duplicates: total.duplicates + (search.duplicates ?? 0),
      dead: total.dead + (search.dead ?? 0),
    }),
    { duplicates: 0, dead: 0 },
  );

/** DuckDuckGo occasionally returns something URL() will not parse. */
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// gfm covers tables, strikethrough and bare URLs — answers end in a citation list of bare
// URLs, and without it they stay unclickable text. breaks keeps a single newline a line
// break, which is what small models write instead of a blank line.
const MARKDOWN_PLUGINS = [remarkGfm, remarkBreaks];

/** The model writes markdown. Show it as markdown rather than as its source.
 *
 * react-markdown renders no raw HTML unless a rehype plugin puts it back, so an answer
 * built out of search results cannot inject markup into the page.
 */
const AnswerText = ({ children }) => (
  <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert prose-pre:bg-muted prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none">
    <Markdown
      remarkPlugins={MARKDOWN_PLUGINS}
      components={{
        a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
      }}
    >
      {children}
    </Markdown>
  </div>
);

function Search({ search }) {
  return (
    <details className="rounded-lg border bg-card px-3 py-2 text-sm">
      <summary className="cursor-pointer list-none text-muted-foreground marker:content-none">
        <span className="inline-flex items-center gap-2">
          {search.running && <Loader2Icon className="size-3.5 animate-spin" />}
          {search.running
            ? `Searching for “${search.query}”…`
            : `Searched for “${search.query}” — ${plural(search.results.length, "new result")} in ${search.ms} ms` +
              (search.duplicates ? `, ${search.duplicates} already seen` : "") +
              (search.dead ? `, ${plural(search.dead, "dead link")}` : "")}
        </span>
      </summary>

      <div className="mt-2 flex flex-col gap-2 border-t pt-2">
        {search.results?.map((result) => (
          <p key={result.url} className="flex flex-col gap-0.5">
            <a
              href={result.url}
              target="_blank"
              rel="noreferrer"
              className={
                result.dead
                  ? "text-muted-foreground line-through underline-offset-4 hover:underline"
                  : "underline-offset-4 hover:underline"
              }
            >
              {result.title || result.url}
            </a>
            <span className={result.dead ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {result.dead
                ? `Unreachable (${result.status ?? "no response"}) — not shown to the model`
                : result.snippet.slice(0, 180)}
            </span>
          </p>
        ))}
      </div>
    </details>
  );
}

function Answer({ turn }) {
  const sources = sourcesOf(turn);
  const dropped = droppedOf(turn);

  return (
    <div className="flex flex-col gap-3">
      {turn.status && (
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          {turn.status}…
        </p>
      )}

      {turn.searches?.map((search, index) => (
        <Search key={index} search={search} />
      ))}

      {turn.answer && <AnswerText>{turn.answer}</AnswerText>}

      {turn.unretrieved?.length > 0 && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs break-words text-destructive">
          {plural(turn.unretrieved.length, "link")} in this answer came from the model, not from a search
          result. Treat as invented: {turn.unretrieved.join(", ")}
        </p>
      )}

      {turn.answer && sources.length > 0 && (
        <ol className="flex list-none flex-col gap-1 text-sm">
          {sources.map((source, index) => (
            <li key={source.url} className="flex items-baseline gap-2">
              <span className="text-xs tabular-nums text-muted-foreground">{index + 1}.</span>
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-4 hover:underline"
              >
                {source.title || source.url}
              </a>
              <Badge variant="secondary" className="font-normal">
                {hostOf(source.url)}
                {source.status && source.status >= 400 ? ` · ${source.status}` : ""}
              </Badge>
            </li>
          ))}
        </ol>
      )}

      {turn.answer && (dropped.duplicates > 0 || dropped.dead > 0) && (
        <p className="text-xs text-muted-foreground">
          Dropped before the model saw them: {plural(dropped.duplicates, "duplicate")},{" "}
          {plural(dropped.dead, "dead link")}.
        </p>
      )}

      {turn.error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {turn.error}
        </p>
      )}
    </div>
  );
}

export default function App() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState([]);
  const [busy, setBusy] = useState(false);

  // The streaming turn is always the last one: the composer is disabled until it ends.
  const patchLast = (fn) =>
    setTurns((previous) => previous.map((turn, index) => (index === previous.length - 1 ? fn(turn) : turn)));

  const ask = async (event) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || busy) return;

    setQuestion("");
    setBusy(true);
    setTurns((previous) => [...previous, { question: text, searches: [], status: "Contacting the model" }]);

    try {
      const response = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!response.ok) throw new Error(`Server responded with ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // The last piece is whatever follows the final newline: an incomplete line.
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          patchLast((turn) => applyEvent(turn, event));
        }
      }
    } catch (error) {
      patchLast((turn) => ({ ...turn, status: null, error: error.message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col gap-3 px-4 pb-4">
      <header className="flex items-start justify-between gap-4 border-b py-3">
        <h1 className="text-sm font-semibold">Local search agent</h1>
        <HealthStrip api={API} />
      </header>

      <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollPreviousItemPeek={64}>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent aria-busy={busy} className="gap-4 pb-4">
              {turns.length === 0 && (
                <p className="m-auto max-w-sm text-balance text-center text-sm text-muted-foreground">
                  Ask something that needs fresh information. The model decides on its own whether to
                  search — watch the steps as they happen.
                </p>
              )}

              {turns.map((turn, index) => (
                <Fragment key={index}>
                  {/* Anchored on the question so the turn you asked stays pinned as the answer grows. */}
                  <MessageScrollerItem messageId={`${index}-question`} scrollAnchor>
                    <p className="ms-auto w-fit max-w-[85%] rounded-2xl bg-secondary px-3.5 py-2 text-sm">
                      {turn.question}
                    </p>
                  </MessageScrollerItem>
                  <MessageScrollerItem messageId={`${index}-answer`}>
                    <Answer turn={turn} />
                  </MessageScrollerItem>
                </Fragment>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <form className="flex gap-2" onSubmit={ask}>
        <Input
          value={question}
          placeholder="Ask something that needs fresh information"
          onChange={(event) => setQuestion(event.target.value)}
        />
        <Button type="submit" size="icon" disabled={busy || !question.trim()} aria-label="Ask">
          {busy ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon />}
        </Button>
      </form>

      <Toaster position="top-right" richColors closeButton />
    </div>
  );
}
