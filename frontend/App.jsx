import { useState } from "react";

const API = "http://localhost:8000";

export default function App() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState([]);
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    const text = question.trim();
    if (!text || busy) return;

    setQuestion("");
    setBusy(true);
    try {
      const response = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!response.ok) throw new Error(`Server responded with ${response.status}`);
      const data = await response.json();
      setTurns((previous) => [...previous, { question: text, ...data }]);
    } catch (error) {
      setTurns((previous) => [...previous, { question: text, error: error.message }]);
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

      {busy && <p className="note">The model is thinking. This can take a while on a local machine.</p>}

      {turns.map((turn, index) => (
        <article key={index} className="turn">
          <p className="question">{turn.question}</p>

          {turn.searches?.map((search, searchIndex) => (
            <details key={searchIndex} className="search">
              <summary>
                Searched for “{search.query}” — {search.results.length} results in {search.ms} ms
              </summary>
              {search.results.map((result) => (
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
          {turn.error && <p className="error">{turn.error}</p>}
        </article>
      ))}
    </main>
  );
}
