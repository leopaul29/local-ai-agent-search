import { useState } from "react";

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
            ? { query: event.query, ms: event.ms, results: event.results, running: false }
            : search,
        ),
      };
    case "answer":
      return { ...turn, status: null, answer: event.answer };
    case "error":
      return { ...turn, status: null, error: event.error };
    default:
      return turn;
  }
};

/** Every result the model saw, deduplicated by URL, in the order they arrived. */
const sourcesOf = (turn) => {
  const byUrl = new Map();
  for (const search of turn.searches ?? [])
    for (const result of search.results ?? [])
      if (result.url && !byUrl.has(result.url)) byUrl.set(result.url, result);
  return [...byUrl.values()];
};

/** DuckDuckGo occasionally returns something URL() will not parse. */
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

export default function App() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState([]);
  const [busy, setBusy] = useState(false);

  // The streaming turn is always the last one: the composer is disabled until it ends.
  const patchLast = (fn) =>
    setTurns((previous) => previous.map((turn, index) => (index === previous.length - 1 ? fn(turn) : turn)));

  const ask = async () => {
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
    <main className="page">
      <h1>Local search agent</h1>

      <div className="composer">
        <input
          value={question}
          placeholder="Ask something that needs fresh information"
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && ask()}
        />
        <button onClick={ask} disabled={busy || !question.trim()}>
          {busy ? "Working" : "Ask"}
        </button>
      </div>

      {turns.map((turn, index) => (
        <article key={index} className="turn">
          <p className="question">{turn.question}</p>

          {turn.status && <p className="status">{turn.status}…</p>}

          {turn.searches?.map((search, searchIndex) => (
            <details key={searchIndex} className={search.running ? "search running" : "search"}>
              <summary>
                {search.running
                  ? `Searching for “${search.query}”…`
                  : `Searched for “${search.query}” — ${search.results.length} results in ${search.ms} ms`}
              </summary>
              {search.results?.map((result) => (
                <p key={result.url} className="result">
                  <a href={result.url} target="_blank" rel="noreferrer">
                    {result.title || result.url}
                  </a>
                  <span>{result.snippet.slice(0, 180)}</span>
                </p>
              ))}
            </details>
          ))}

          {turn.answer && <div className="answer">{turn.answer}</div>}

          {turn.answer && sourcesOf(turn).length > 0 && (
            <ol className="sources">
              {sourcesOf(turn).map((source) => (
                <li key={source.url}>
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.title || source.url}
                  </a>
                  <span>{hostOf(source.url)}</span>
                </li>
              ))}
            </ol>
          )}

          {turn.error && <p className="error">{turn.error}</p>}
        </article>
      ))}
    </main>
  );
}
