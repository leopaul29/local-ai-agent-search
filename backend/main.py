"""Minimal agent: FastAPI + Ollama tool calling + DuckDuckGo search.

Run with:  uvicorn main:app --reload --port 8000
"""

import asyncio
import json
import os
import re
import time
from collections import Counter

import httpx
from ddgs import DDGS
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3:8b")
MAX_ITERATIONS = 3
# Generous: qwen3:1.7b answering from five snippets runs mostly on the CPU, and at 180
# seconds two runs in five were cut off mid-answer and surfaced as a bare timeout.
OLLAMA_TIMEOUT = float(os.getenv("OLLAMA_TIMEOUT", "600"))
LINK_TIMEOUT = 6.0
# Short: the page polls /api/health on a timer, and a hung probe is a down service as
# far as the person watching the status strip is concerned.
HEALTH_TIMEOUT = 4.0
# A page that answers 404 or 410 is gone. 403 and 429 mean the site refuses to talk to a
# bot, which says nothing about whether the page exists, so those are kept.
DEAD_STATUSES = {404, 410}
# Markdown wrapping is not part of the URL: models emit **bold** links and `code` ones.
URL_IN_TEXT = re.compile(r"https?://[^\s)\]}>\"'`*]+")
WORD = re.compile(r"\w{3,}", re.UNICODE)
# Words this common across the retrieved snippets are the query itself coming back; they
# cannot tell one source apart from another, so they prove no attribution.
GENERIC_SHARE = 0.5
STOPWORDS = frozenset(
    "and are but for from has have here how its not the this that they was were what "
    "when where which who will with you your can also more most best top some any all "
    "one two three four five six seven eight nine ten".split()
)

SYSTEM_PROMPT = (
    "You are a research assistant with web access. "
    "Search only when the question needs current or external information; "
    "answer directly otherwise. "
    "When you use search results, cite them: after each item you mention, give the URL of "
    "the result it came from, on the same line as that item, copied character for "
    "character from the result. Choose the result whose title or snippet actually names "
    "the item. Never write a URL that did not appear in a result: if you have no source "
    "for something, say so instead of inventing a link."
)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web and return the top results.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    }
]

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str


def search_blocking(query: str, max_results: int = 5) -> list[dict]:
    """ddgs is synchronous, so this runs in a worker thread."""
    with DDGS() as ddgs:
        rows = list(ddgs.text(query, max_results=max_results))
    return [
        {
            "title": row.get("title", ""),
            "url": row.get("href", ""),
            # Truncated: full pages would blow a small model's context window.
            "snippet": (row.get("body") or "")[:500],
        }
        for row in rows
    ]


def normalize(url: str) -> str:
    """Compare URLs ignoring the differences that never change what page you land on."""
    return url.rstrip("/.,;:*`_").lower()


async def check_alive(client: httpx.AsyncClient, url: str) -> int | None:
    """Return the status code the URL answers with, or None when it cannot be reached.

    HEAD first, because it costs one round trip and no body. Sites that reject the method
    with 405 are retried with a streamed GET that is abandoned as soon as the status line
    arrives.
    """
    for method in ("HEAD", "GET"):
        try:
            async with client.stream(
                method, url, timeout=LINK_TIMEOUT, follow_redirects=True
            ) as response:
                if response.status_code != 405:
                    return response.status_code
        except Exception:
            return None
    return None


def is_dead(status: int | None) -> bool:
    # ponytail: a slow site that misses LINK_TIMEOUT is indistinguishable from a gone one
    # here. Split timeouts out from transport errors if good results start disappearing.
    return status is None or status in DEAD_STATUSES


def unretrieved_urls(answer: str, sources: dict[str, str]) -> list[str]:
    """URLs the answer states that no search ever returned — the model wrote them itself."""
    cited = {normalize(url) for url in URL_IN_TEXT.findall(answer)}
    return sorted(cited - sources.keys())


def words(text: str) -> set[str]:
    return {word for word in WORD.findall(text.lower()) if word not in STOPWORDS}


def blocks(text: str):
    """Split an answer into list items and paragraphs.

    Models write the name of a thing on one line and its link on an indented one below, so
    a link has to be judged against the whole item, not against the line it sits on. A
    blank line or a line starting at column zero opens a new block; anything indented
    continues the one above.
    """
    # ponytail: indentation is the only cue used. An answer that puts a name and its URL
    # in two unindented lines reads as two blocks and the URL looks unsupported.
    current = []
    for line in text.splitlines():
        if not line.strip() or (current and not line[:1].isspace()):
            if current:
                yield "\n".join(current)
            current = []
        if line.strip():
            current.append(line)
    if current:
        yield "\n".join(current)


def unsupported_citations(answer: str, sources: dict[str, str]) -> list[dict]:
    """Lines whose cited page never mentions what the line is about.

    The model saw nothing of a page but its title and snippet, so a name appearing in
    neither cannot have come from that page: the pairing is the model's own invention even
    though the URL is real. Words shared by most of the snippets are the query echoing
    back and attribute nothing, so only the rarer ones are asked for.
    """
    if not sources:
        return []

    frequency = Counter(word for text in sources.values() for word in words(text))
    generic = {word for word, count in frequency.items() if count > len(sources) * GENERIC_SHARE}

    gaps = []
    for block in blocks(answer):
        cited = [url for url in map(normalize, URL_IN_TEXT.findall(block)) if url in sources]
        if not cited:
            continue

        claim = words(URL_IN_TEXT.sub(" ", block)) - generic
        supported = set().union(*(words(sources[url]) for url in cited))
        if claim and not claim & supported:
            gaps.append({"claim": " ".join(block.split())[:160], "urls": cited})
    return gaps


async def check_ollama(client: httpx.AsyncClient) -> dict:
    """Reach Ollama and, when it cannot answer, say why in terms worth showing.

    A server that answers but has never pulled OLLAMA_MODEL counts as down — it cannot
    answer a question either — so it is raised like any other failure and comes back
    carrying the command that fixes it.
    """
    try:
        response = await client.get(f"{OLLAMA_HOST}/api/tags", timeout=HEALTH_TIMEOUT)
        response.raise_for_status()
        names = [model.get("name") for model in response.json().get("models", [])]
        if OLLAMA_MODEL not in names:
            raise RuntimeError(f"not pulled — run: ollama pull {OLLAMA_MODEL}")
        return {"up": True, "detail": OLLAMA_MODEL}
    except Exception as exc:
        return {"up": False, "detail": str(exc) or exc.__class__.__name__}


async def ask_ollama(client: httpx.AsyncClient, messages: list[dict], tools: list | None = None) -> dict:
    response = await client.post(
        f"{OLLAMA_HOST}/api/chat",
        json={
            "model": OLLAMA_MODEL,
            "messages": messages,
            "tools": tools or [],
            "stream": False,
            # The default context of 2048 silently truncates search results.
            "options": {"num_ctx": 8192},
        },
        timeout=OLLAMA_TIMEOUT,
    )
    response.raise_for_status()
    return response.json()["message"]


async def run_agent(question: str):
    """Yield one event per step so the browser can show progress as it happens."""
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": question},
    ]
    # Every URL any search has returned this turn: normalized URL to the only text the
    # model ever saw for it. Three purposes: the model never sees the same page twice, a
    # URL in the answer that is missing here was invented rather than retrieved, and a
    # claim can be checked against the snippet it is hung on.
    retrieved: dict[str, str] = {}

    async with httpx.AsyncClient() as client:
        for _ in range(MAX_ITERATIONS):
            yield {"type": "thinking"}
            message = await ask_ollama(client, messages, TOOLS)
            calls = message.get("tool_calls") or []

            if not calls:
                answer = message.get("content", "")
                yield {
                    "type": "answer",
                    "answer": answer,
                    "unretrieved": unretrieved_urls(answer, retrieved),
                    "unsupported": unsupported_citations(answer, retrieved),
                }
                return

            messages.append(message)
            for call in calls:
                arguments = call["function"]["arguments"]
                if isinstance(arguments, str):
                    arguments = json.loads(arguments)
                query = arguments.get("query", "")

                yield {"type": "search_start", "query": query}
                started = time.perf_counter()
                rows = await asyncio.to_thread(search_blocking, query)

                fresh = []
                for row in rows:
                    key = normalize(row["url"])
                    if row["url"] and key not in retrieved:
                        retrieved[key] = f"{row['title']} {row['snippet']}"
                        fresh.append(row)

                statuses = await asyncio.gather(
                    *(check_alive(client, row["url"]) for row in fresh)
                )
                for row, status in zip(fresh, statuses):
                    row["status"] = status
                    row["dead"] = is_dead(status)

                alive = [row for row in fresh if not row["dead"]]
                yield {
                    "type": "search_done",
                    "query": query,
                    "ms": round((time.perf_counter() - started) * 1000),
                    "results": fresh,
                    "duplicates": len(rows) - len(fresh),
                    "dead": len(fresh) - len(alive),
                }

                # Only reachable, not-yet-seen pages reach the model. Dead links stay in
                # the event above so the UI can show what was dropped and why.
                messages.append(
                    {
                        "role": "tool",
                        "content": json.dumps(
                            [
                                {key: row[key] for key in ("title", "url", "snippet")}
                                for row in alive
                            ]
                        ),
                    }
                )

        # Tool budget spent: ask for a final answer with tools switched off.
        yield {"type": "thinking"}
        message = await ask_ollama(client, messages)
        answer = message.get("content", "")
        yield {
            "type": "answer",
            "answer": answer,
            "unretrieved": unretrieved_urls(answer, retrieved),
            "unsupported": unsupported_citations(answer, retrieved),
        }


@app.post("/api/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    """Newline-delimited JSON: one event per line, flushed as the agent produces it."""

    async def lines():
        try:
            async for event in run_agent(request.message):
                yield json.dumps(event) + "\n"
        except Exception as exc:
            # Headers are already sent, so a 500 is no longer possible: report in-band.
            yield json.dumps({"type": "error", "error": str(exc) or exc.__class__.__name__}) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson")


@app.get("/api/health")
async def health() -> dict:
    """Whether a question can be answered at all, and what is broken when it cannot.

    Probed on every call rather than cached: the page polls this a few times a minute, and
    a stale "up" is worse than the one request it saves.
    """
    async with httpx.AsyncClient() as client:
        return {"ollama": {**await check_ollama(client), "url": OLLAMA_HOST}}
