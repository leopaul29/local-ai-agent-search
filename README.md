# Minimal local search agent

FastAPI + Ollama tool calling + DuckDuckGo, with a React page in front. No Docker, no
API keys.

## Layout

```
backend/main.py       the whole agent: /api/chat, /api/health, one web_search tool
backend/test_stream.py  self-check for the event stream, no Ollama and no network
backend/.env          OLLAMA_HOST and OLLAMA_MODEL, gitignored; copy .env.example
.env                  SEARXNG_SECRET for Docker Compose, gitignored; copy .env.example
frontend/App.jsx      the whole UI
frontend/main.jsx     mounts it; index.html is Vite's entry point
agent.py              a multi-provider agent loop with none of its modules written
__init__.py           the provider registry those modules would live in
docker-compose.yml    SearXNG on :8080 — nothing calls it yet, so it is optional
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

Check the model is reachable before touching the frontend:

```bash
curl localhost:8000/api/health
```

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

The lockfile is pnpm's. Running `npm install` here writes a second lockfile and the two
drift apart, so stay on pnpm or delete `pnpm-lock.yaml` first.

Open http://localhost:5173 and ask something that needs fresh information, like
"what changed in the latest FastAPI release".

## SearXNG (optional)

Nothing in `backend/main.py` calls it yet — the agent searches through `ddgs`. Start it
only when you are ready to point the tool at a local engine.

Docker Desktop must be running. From the repo root:

```powershell
copy .env.example .env
python -c "import secrets; print(secrets.token_hex(32))"   # paste into SEARXNG_SECRET

docker compose up -d
```

Compose reads the root `.env` for `SEARXNG_SECRET` and refuses to start if it is missing.

```powershell
docker compose ps                 # searxng should be running on 0.0.0.0:8080
docker compose logs -f searxng    # ctrl-c to stop following
```

Open http://localhost:8080 to search by hand. The JSON API the agent would use is off by
default — `searxng/settings.yml` inherits `use_default_settings: true` and the defaults are
HTML only. Add a `search` block to that file:

```yaml
search:
  formats:
    - html
    - json
```

Then restart and check:

```powershell
docker compose restart searxng
curl.exe "http://localhost:8080/search?q=fastapi&format=json"
```

Stop it, keeping the config in `searxng/`:

```powershell
docker compose down
```

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
| `{"type": "search_done", "query", "ms", "results"}` | Results are in |
| `{"type": "answer", "answer"}` | Final text; the stream ends here |
| `{"type": "error", "error"}` | Something failed mid-stream |

`error` is in-band because the response headers left with a 200 as soon as the first event
was written; an HTTP status can no longer be changed at that point.

The page reads the stream with `fetch` and a `ReadableStream` reader rather than
`EventSource`, which is GET-only. Each event is folded into the last turn by `applyEvent`
in `App.jsx`: a running search shows as *Searching for "…"*, then flips to the result count
and timing. Under the answer, `sourcesOf` lists every URL the model saw, deduplicated,
which is the citation list — independent of whether the model remembered to cite anything
itself.

Watch the raw stream from the terminal:

```powershell
curl.exe -N http://localhost:8000/api/chat -H "Content-Type: application/json" -d "{\"message\":\"what changed in the latest FastAPI release\"}"
```

## Secrets

Two `.env` files, both gitignored, both with a committed `.env.example` beside them:

| File | Read by | Holds |
| --- | --- | --- |
| `backend/.env` | `uvicorn --env-file` | `OLLAMA_HOST`, `OLLAMA_MODEL` |
| `.env` | `docker compose` | `SEARXNG_SECRET` |

`searxng/settings.yml` is committed and must stay free of `secret_key`. SearXNG picks the
value up from `SEARXNG_SECRET` instead, which Compose passes in. Generate one with:

```powershell
python -c "import secrets; print(secrets.token_hex(32))"
```

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
- No conversation history — each question starts fresh. Keep a message list in React state
  and send it whole to add follow-ups.
- No page fetching. The model only sees snippets, never full pages.

## Next step

The loop lives in the `for` block of `chat()` in `main.py`. Everything else is plumbing.
Once you can see `searches` populate in the UI, that's the point to add a second engine and
start comparing.
