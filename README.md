# Minimal local search agent

FastAPI + Ollama tool calling + web search, with a React page in front. No Docker, no
API keys, nothing to run but Ollama.

## Layout

```
ARCHITECTURE.md       component and request-flow diagrams, English then Japanese
backend/main.py       the whole agent: /api/chat, /api/health, one web_search tool
backend/test_stream.py  self-check for the event stream, no Ollama and no network
backend/.env          OLLAMA_HOST, OLLAMA_MODEL, OLLAMA_TIMEOUT; gitignored, copy .env.example
frontend/App.jsx      the transcript, the composer, the stream reader
frontend/components/health-strip.jsx  the up/down chips, the polling, the toast and the alarm
frontend/lib/health.js  which up/down changes are worth announcing — the part with a test
frontend/lib/history.js  the session URL log behind the search chip
frontend/test-health.mjs, test-history.mjs  self-checks for both, no React and no browser
frontend/components/ui/  shadcn components, generated; regenerate rather than edit
frontend/main.jsx     mounts it; index.html is Vite's entry point
agent.py              a multi-provider agent loop with none of its modules written
__init__.py           the provider registry those modules would live in
```

Only `backend/` and `frontend/` run today. `agent.py` and `__init__.py` are a second
generation sketched before the first one was finished: they import `ollama_client`,
`config`, `schemas` and four provider modules that do not exist. Treat them as notes,
not as code.

## Run it

Ollama first — the backend calls it and fails without it:

```powershell
winget install Ollama.Ollama     # or download from https://ollama.com/download
ollama serve                     # leave running; already running as a service on Windows
```

In a second terminal, pull the model named in `backend/.env` and keep that terminal to
check it answers:

```powershell
ollama pull qwen3:1.7b
ollama list                      # qwen3:1.7b should be there, ~1.4 GB
ollama run qwen3:1.7b "say hi"   # /bye to leave
```

Ollama listens on `http://localhost:11434`. Confirm it before starting the backend:

```powershell
curl.exe http://localhost:11434/api/tags
```

To use a different model, pull it and change `OLLAMA_MODEL` in `backend/.env` — it must
support tool calling, see below.

Backend:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env          # then edit it if Ollama is not on this machine

.venv\Scripts\uvicorn.exe main:app --reload --port 8000 --env-file .env
```

`--env-file` is uvicorn's own flag: it reads the file into the environment before importing
`main`, which is where `OLLAMA_HOST` and `OLLAMA_MODEL` are looked up. No dotenv call in the
code, and `.env` is gitignored.

On macOS or Linux the same steps are `source .venv/bin/activate`, then
`uvicorn main:app --reload --port 8000 --env-file .env`.

Check both dependencies are reachable before touching the frontend:

```bash
curl localhost:8000/api/health
```

See [Health](#health) for what it answers and what each failure means.

And check the agent loop itself without touching Ollama or the network:

```powershell
.venv\Scripts\python.exe test_stream.py
```

Frontend, in a second terminal:

```bash
cd frontend
pnpm install
pnpm dev
```

The page is Tailwind v4 plus [shadcn](https://ui.shadcn.com) on the Base UI registry, which
is why `@shadcn/react` pins React 19. `pnpm install` covers all of it; `components.json`
records the settings the generator used, so `pnpm dlx shadcn@latest add <name>` keeps
matching what is already there.

One check runs without a browser:

```bash
pnpm test
```

The lockfile is pnpm's. Running `npm install` here writes a second lockfile and the two
drift apart, so stay on pnpm or delete `pnpm-lock.yaml` first.

Open http://localhost:5173 and ask something that needs fresh information, like
"what changed in the latest FastAPI release".

## How the model decides to search

It is the model's call, not the code's. Every request sends the `web_search` tool
definition alongside the messages, and the model either emits a `tool_calls` entry or
answers straight away. `chat()` only reacts to what comes back — there is no keyword
check, no "if the question looks recent" heuristic anywhere in `main.py`.

Two things push that decision:

- The system prompt: *"Search only when the question needs current or external
  information; answer directly otherwise."*
- The tool description, `"Search the web and return the top results."` — the model reads it
  as documentation, so rewording it changes how often the tool fires.

So no, it does not search every time. "What is 2 + 2" comes back with no `tool_calls` and
the loop returns on the first pass. Small models get this wrong in both directions: they
skip a search they needed, or search for something they already knew. Watch the `thinking`
and `search_start` events in the UI to see which happened.

The loop runs at most `MAX_ITERATIONS` (3) rounds, so the model can search, read the
results, and search again with a better query. After that the budget is spent and the last
call goes out with the tool list empty, which forces a text answer.

## Live progress and sources

`/api/chat` streams newline-delimited JSON — one event per line, flushed as it happens,
rather than one JSON body at the end. The events:

| Event | Meaning |
| --- | --- |
| `{"type": "thinking"}` | A round started; the model is deciding what to do |
| `{"type": "search_start", "query"}` | The model called the tool; the search is running |
| `{"type": "search_done", "query", "ms", "results", "duplicates", "dead"}` | Results are in, already filtered |
| `{"type": "answer", "answer", "unretrieved", "unsupported", "ungrounded"}` | Final text; the stream ends here |
| `{"type": "error", "error"}` | Something failed mid-stream |

`error` is in-band because the response headers left with a 200 as soon as the first event
was written; an HTTP status can no longer be changed at that point.

The page reads the stream with `fetch` and a `ReadableStream` reader rather than
`EventSource`, which is GET-only. Each event is folded into the last turn by `applyEvent`
in `App.jsx`: a running search shows as *Searching for "…"*, then flips to the result count
and timing. Under the answer, `sourcesOf` lists every URL the model saw, deduplicated,
which is the citation list — independent of whether the model remembered to cite anything
itself.

The answer itself is markdown, so it goes through `react-markdown` rather than into a
`<pre>`: headings, lists and tables render, and `remark-gfm` turns the bare URLs the
model cites into links. No rehype plugin re-enables raw HTML, so nothing an answer
carries out of a search result can inject markup into the page.

Watch the raw stream from the terminal:

```powershell
curl.exe -N http://localhost:8000/api/chat -H "Content-Type: application/json" -d "{\"message\":\"what changed in the latest FastAPI release\"}"
```

## Health

A stopped Ollama and a stopped backend fail a question the same way, and the page cannot
tell them apart on its own. `/api/health` answers for the one thing that runs outside
this repo, so the status strip in the header can name what broke:

```json
{
  "ollama": {"up": false, "detail": "All connection attempts failed", "url": "http://localhost:11434"}
}
```

`detail` is the model name when Ollama is healthy, and the reason otherwise. A reachable
Ollama that has never pulled `OLLAMA_MODEL` counts as down — it cannot answer — and the
detail carries the `ollama pull` that fixes it.

The strip shows two chips, because the backend is the thing that probes the other:

| Chip | Green when | Red means |
| --- | --- | --- |
| Backend | `/api/health` answers | uvicorn is not running, or CORS is refusing the page |
| Model | Ollama answers and `OLLAMA_MODEL` is pulled | `ollama serve` is down, or the model was never pulled |

With the backend red the Model chip goes grey rather than red: its state is unknown, not
down.

Beside them sits a third chip that is not a probe: a magnifier and a count, because
`ddgs` runs inside the backend and has nothing separate to be up or down. Hovering it
opens the session log — every page a search returned since the tab was opened, most
recently seen first, deduplicated across questions, struck through when the link checker
found it dead. `historyOf` in `frontend/lib/history.js` builds it from the turns already
in React state, so nothing extra is stored and it resets on reload.

The page polls every 5 seconds and announces **changes only** — a toast plus a two-tone
alarm when something that was up goes down, a quieter toast when it comes back. A service
that was never up stays silent, so starting the page before Ollama does not alarm.
`transitions()` in `frontend/lib/health.js` is that rule, and `pnpm test` is its
self-check.

Browsers refuse to start audio until the tab has been clicked or typed in, so the very
first alarm on an untouched page is silent. The toast still appears.

## What the model actually gets

This is retrieval-augmented, but the retrieval is thinner than the phrase usually implies,
and it is worth being exact about what reaches the model.

A tool call comes back as a `role: "tool"` message appended to `messages`, and the next
call to Ollama carries the whole conversation, so the results are in the context the answer
is written from. That part is real. What is in them is five rows of *title, URL and the
first 500 characters of the search-result snippet* — about 2.4 KB, roughly 600 tokens, per
search. Nothing fetches a page. The model never reads a single one of the pages it cites.

Whether it uses them is not a matter of opinion, it is testable. The same question asked
with no search at all:

```powershell
.venv\Scripts\python.exe -c "import httpx; print(httpx.post('http://localhost:11434/api/chat', json={'model':'qwen3:1.7b','stream':False,'messages':[{'role':'user','content':'best gyoza restaurants in Shinjuku Tokyo. Name them.'}]}, timeout=600).json()['message']['content'])"
```

answers with Gyoza Nishinaka, Gyoza Yokocho, Gyoza Shokunin — plausible, confident and
absent from every search result. Through `/api/chat` the same question answers with Gyoza
no Fukuho, Gyopao Gyoza Shinjuku and Kakekomi Gyoza, all of which appear verbatim in the
snippets it was handed. The search results are doing the work.

So the ceiling is the snippet. A restaurant's opening hours, its address, whether it closed
last year: if that is not in the 500 characters DuckDuckGo returned, the model does not have
it, and anything it says about it comes from its weights. Fetching the pages and passing
their text is the change that would lift that ceiling, and it is not written.

**`ddgs` is not just DuckDuckGo.** Despite the name it is a metasearch client: version
9.16 rotates over Brave, DuckDuckGo, Google, Grokipedia, Mojeek, Startpage, Wikipedia and
Yahoo, and `backend="auto"` is the default. One engine rate-limiting you is therefore not
the outage it would be against a single source. It is still an unofficial scraper of
pages nobody promised to keep stable, and it breaks when they change.

## Why the sources can be trusted

Three separate problems, three separate fixes, all in `run_agent`.

**The same page kept coming back.** Two searches in one turn overlap, so results three to
five of the second search were already results one and two of the first. A `retrieved` set
of normalized URLs now spans the whole turn: a page the model has already been given is
never sent again. `duplicates` in the `search_done` event counts what was dropped.

**Dead links.** Every new URL is checked before the model sees it — `HEAD`, falling back to
a streamed `GET` for sites that answer 405, with a 6 second budget and all of a search's
URLs checked in parallel. Only 404, 410 and "could not be reached at all" count as dead;
403 and 429 mean the site refuses to talk to a bot, which says nothing about whether the
page exists. Dead results are cut from what goes to the model and kept in the event with
their status code, so the page can show them struck through with the reason.

**Hallucinated URLs.** A search result is real by construction — it came from DuckDuckGo,
not from the model. A URL in the *answer* is a different matter: the model writes that
text, and a plausible-looking `https://…/shinjuku-gyoza` is exactly the kind of thing it
invents. So every URL in the answer is matched against the set of URLs the searches
actually returned, and the ones with no match come back in `unretrieved`. The page prints
them under a warning. An empty `unretrieved` means every link in the answer is one the
search engine returned.

That last check is the honest answer to "how do I know it is not hallucinating": you do not
have to trust the model at all, because the citation list under the answer is built from
the search results, not from the text the model wrote.

The system prompt also tells the model to copy URLs character for character and never write
one it has not seen. That helps, and it is not evidence — `unretrieved` is.

**Right link, wrong thing.** A URL can be real, alive and retrieved and still be hung on
the wrong claim: the answer names a restaurant and cites a page that is about a different
one. `unretrieved` cannot see this, because the URL passes every test it applies.

What makes this checkable is that the model never saw the page. It saw a title and a
snippet, nothing else. So a name that appears in neither cannot have come from that page —
the pairing is the model's own, whatever the link is. `unsupported_citations` splits the
answer into markdown blocks, and for each block that cites a retrieved URL asks whether any
distinctive word of the block appears in that URL's title or snippet.

Distinctive is the load-bearing word. In an answer about gyoza in Shinjuku, *gyoza*,
*shinjuku* and *tokyo* are in every snippet and so attribute nothing; the name of the
restaurant is in one. Words appearing in more than half the snippets are therefore dropped
before the comparison, which leaves the names. A block whose remaining words are all
generic — a heading, a trailing source list — is never flagged, because it claims nothing.

Blocks rather than lines, because models write the name on one line and the link on an
indented one under it:

```
2. **Gyopao Gyoza Shinjuku**
   - **Highlights**: ranked first in Shinjuku 3 Chome
   - **Source**: [Link](https://…)
```

Line by line, the `Source` line names nothing and every answer in this shape gets flagged.
A blank line or a line starting at column zero opens a block; indentation continues it.

Verified against the live model rather than in the abstract: four runs of the Shinjuku
gyoza question flagged nothing, and the same answers with every cited URL swapped for
another retrieved one flagged the blocks whose names had moved.

**A name that was never retrieved.** The bluntest failure, and the last one to be caught.
The model writes a restaurant no snippet ever mentioned, then hangs a real retrieved URL
off it. `unretrieved` sees a valid URL and says nothing. `unsupported_citations` catches it
only if the block cites that URL directly.

`ungrounded_names` asks the question underneath: is this name in the search results at all?
Candidates are what a model actually writes names as — bold spans, and runs of two or more
capitalised words — minus bold spans followed by a colon, which are field labels
(`**Location**:`) rather than names. A candidate is reported when none of its distinctive
words appear anywhere in any snippet. If the name is not in the results, it came from the
training data, which on a small local model is years out of date.

Run against eight real answers to the Shinjuku gyoza question: six clean, and two carrying
`Kikunoi Gyoza` and `Nishijin Gyoza`, both invented, both written with a real retrieved URL
beside them. That answer had `unretrieved: []` and one `unsupported` block — the URLs were
genuine and the pairing check caught half of it. The name check caught both.

### What this still does not catch

- A claim the snippet happens to share a word with. The checks ask whether the source
  mentions the thing, not whether it supports the sentence.
- A single-word name that is also an ordinary word. It survives the distinctive-word filter
  only if the snippets never use that word in any sense.
- A page whose snippet names the restaurant while the page itself says something else.
  Only fetching and reading it would catch that, and nothing here reads pages.
- A restaurant that closed last year with its page still up.
- URLs the model mangles into another *live* page. Rare, and it would show as a link that
  works but does not match the name next to it.

## Secrets

One gitignored `.env`, with a committed `.env.example` beside it:

| File | Read by | Holds |
| --- | --- | --- |
| `backend/.env` | `uvicorn --env-file` | `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT` |

None of it is a secret today — it is host, model name and a timeout, all local. The file
is gitignored anyway, so pointing `OLLAMA_HOST` at a private machine later does not need
a second look at what git is tracking.

## Two things that will stop it working

**The model must support tool calling.** Most models accept the `tools` field and silently
ignore it, so the agent never searches and you get a confident answer from training data
instead. If `searches` comes back empty every time, this is why. Small models that do emit
tool calls: `qwen3:1.7b` (1.4 GB), `llama3.2:3b` (2 GB), `qwen2.5:3b` (1.9 GB). Below about
1.5 B parameters the tool calls start arriving malformed often enough to be a waste of time.

Check the model before blaming the agent:

```powershell
curl.exe http://localhost:11434/api/chat -d '{"model":"qwen3:1.7b","stream":false,"messages":[{"role":"user","content":"what is the weather in Paris right now"}],"tools":[{"type":"function","function":{"name":"web_search","description":"Search the web.","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}}]}'
```

A `tool_calls` key in the reply means the model works here. No `tool_calls` means pick
another model.

**The context window.** `num_ctx` is set to 8192 in `ask_ollama`. Ollama's default of 2048
is not enough to hold five search results plus the conversation, and it truncates without
any error.

## What this leaves out on purpose

- No token streaming. Progress events stream, but the answer arrives as one block: Ollama
  is called with `"stream": False`. Flip that and forward the chunks to type it out live.
- One search engine. DuckDuckGo through `ddgs` is unofficial and rate-limits under load.
- No page fetching, so link checking stops at the status code: alive is not the same as
  relevant, and a snippet is all the model ever reads.
- No conversation history — each question starts fresh. Keep a message list in React state
  and send it whole to add follow-ups.

## Next step

The loop lives in the `for` block of `chat()` in `main.py`. Everything else is plumbing.
Once you can see `searches` populate in the UI, that's the point to add a second engine and
start comparing.
