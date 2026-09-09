"""Minimal agent: FastAPI + Ollama tool calling + DuckDuckGo search.

Run with:  uvicorn main:app --reload --port 8000
"""

import asyncio
import json
import os
import time

import httpx
from ddgs import DDGS
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3:8b")
MAX_ITERATIONS = 3

SYSTEM_PROMPT = (
    "You are a research assistant with web access. "
    "Search only when the question needs current or external information; "
    "answer directly otherwise. Cite the URLs you used at the end of your answer."
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
        timeout=180.0,
    )
    response.raise_for_status()
    return response.json()["message"]


async def run_agent(question: str):
    """Yield one event per step so the browser can show progress as it happens."""
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": question},
    ]

    async with httpx.AsyncClient() as client:
        for _ in range(MAX_ITERATIONS):
            yield {"type": "thinking"}
            message = await ask_ollama(client, messages, TOOLS)
            calls = message.get("tool_calls") or []

            if not calls:
                yield {"type": "answer", "answer": message.get("content", "")}
                return

            messages.append(message)
            for call in calls:
                arguments = call["function"]["arguments"]
                if isinstance(arguments, str):
                    arguments = json.loads(arguments)
                query = arguments.get("query", "")

                yield {"type": "search_start", "query": query}
                started = time.perf_counter()
                results = await asyncio.to_thread(search_blocking, query)
                yield {
                    "type": "search_done",
                    "query": query,
                    "ms": round((time.perf_counter() - started) * 1000),
                    "results": results,
                }
                messages.append({"role": "tool", "content": json.dumps(results)})

        # Tool budget spent: ask for a final answer with tools switched off.
        yield {"type": "thinking"}
        message = await ask_ollama(client, messages)
        yield {"type": "answer", "answer": message.get("content", "")}


@app.post("/api/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    """Newline-delimited JSON: one event per line, flushed as the agent produces it."""

    async def lines():
        try:
            async for event in run_agent(request.message):
                yield json.dumps(event) + "\n"
        except Exception as exc:
            # Headers are already sent, so a 500 is no longer possible: report in-band.
            yield json.dumps({"type": "error", "error": str(exc)}) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson")


@app.get("/api/health")
async def health() -> dict:
    async with httpx.AsyncClient() as client:
        try:
            await client.get(f"{OLLAMA_HOST}/api/tags", timeout=5.0)
            return {"ollama": True, "model": OLLAMA_MODEL}
        except Exception as exc:
            return {"ollama": False, "error": str(exc)}
