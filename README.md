# Minimal local search agent

FastAPI + Ollama tool calling + DuckDuckGo, with a React page in front. No Docker, no
API keys.

## Layout

```
backend/main.py       the whole agent: /api/chat, /api/health, one web_search tool
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

- No streaming. The page waits for the full answer, which on a local model is several
  seconds of nothing. Add server-sent events once the loop works.
- One search engine. DuckDuckGo through `ddgs` is unofficial and rate-limits under load.
- No conversation history — each question starts fresh. Keep a message list in React state
  and send it whole to add follow-ups.
- No page fetching. The model only sees snippets, never full pages.

## Next step

The loop lives in the `for` block of `chat()` in `main.py`. Everything else is plumbing.
Once you can see `searches` populate in the UI, that's the point to add a second engine and
start comparing.
