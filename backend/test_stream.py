"""Self-check for the /api/chat event stream. No Ollama, no network.

Run:  .venv\Scripts\python.exe test_stream.py
"""

import json

import main
from fastapi.testclient import TestClient


def collect(replies, question="anything", rows=None, statuses=None):
    """Drive the endpoint with a scripted sequence of Ollama replies and search rows.

    Nothing here touches the network: both Ollama and the link checker are replaced.
    """
    scripted = list(replies)

    async def fake_ask(client, messages, tools=None):
        sent.append(messages[-1])
        return scripted.pop(0)

    sent = []
    main.ask_ollama = fake_ask
    main.search_blocking = lambda query, max_results=5: [
        dict(row) for row in (rows or [{"title": "T", "url": "https://example.com", "snippet": "S"}])
    ]

    async def fake_check(client, url):
        return (statuses or {}).get(url, 200)

    main.check_alive = fake_check

    with TestClient(main.app) as client:
        with client.stream("POST", "/api/chat", json={"message": question}) as response:
            assert response.status_code == 200, response.status_code
            events = [json.loads(line) for line in response.iter_lines() if line.strip()]
    return events, sent


def tool_payload(sent):
    """What the last tool message actually handed to the model."""
    return json.loads([message for message in sent if message.get("role") == "tool"][-1]["content"])


TOOL_CALL = {
    "role": "assistant",
    "tool_calls": [{"function": {"name": "web_search", "arguments": {"query": "fastapi"}}}],
}

# No tool call: one thinking event, then the answer. The model never searched.
events, _ = collect([{"content": "42"}])
assert [event["type"] for event in events] == ["thinking", "answer"], events
assert events[-1]["answer"] == "42"

# One tool call, then an answer: the search bracket must arrive before the answer.
events, _ = collect([TOOL_CALL, {"content": "done"}])
assert [event["type"] for event in events] == [
    "thinking",
    "search_start",
    "search_done",
    "thinking",
    "answer",
], events
assert events[1]["query"] == "fastapi"
assert events[2]["results"][0]["url"] == "https://example.com"

# Arguments as a JSON string, which some models send instead of an object.
string_args = {"role": "assistant", "tool_calls": [{"function": {"arguments": '{"query": "x"}'}}]}
events, _ = collect([string_args, {"content": "done"}])
assert events[1]["query"] == "x", events

# Tool budget exhausted: the loop still ends on an answer, never on a dangling search.
events, _ = collect([TOOL_CALL] * main.MAX_ITERATIONS + [{"content": "forced"}])
assert events[-1] == {"type": "answer", "answer": "forced", "unretrieved": []}, events[-1]
assert sum(event["type"] == "search_done" for event in events) == main.MAX_ITERATIONS


# --- what the model is allowed to see -------------------------------------------------

THREE_ROWS = [
    {"title": "A", "url": "https://a.example/gyoza", "snippet": "a"},
    {"title": "B", "url": "https://b.example/gyoza", "snippet": "b"},
    {"title": "C", "url": "https://c.example/gyoza", "snippet": "c"},
]

# Two searches returning the same rows: the second must add nothing the model has seen.
events, sent = collect([TOOL_CALL, TOOL_CALL, {"content": "done"}], rows=THREE_ROWS)
done = [event for event in events if event["type"] == "search_done"]
assert len(done[0]["results"]) == 3 and done[0]["duplicates"] == 0, done[0]
assert done[1]["results"] == [] and done[1]["duplicates"] == 3, done[1]
assert tool_payload(sent) == [], "the second search re-sent pages the model already had"

# A 404 is dropped from the tool payload but stays in the event, flagged, so the UI can
# show what was thrown away.
events, sent = collect(
    [TOOL_CALL, {"content": "done"}],
    rows=THREE_ROWS,
    statuses={"https://b.example/gyoza": 404, "https://c.example/gyoza": None},
)
done = [event for event in events if event["type"] == "search_done"][0]
assert done["dead"] == 2 and len(done["results"]) == 3, done
assert [row["dead"] for row in done["results"]] == [False, True, True], done["results"]
assert [row["url"] for row in tool_payload(sent)] == ["https://a.example/gyoza"], tool_payload(sent)
assert "dead" not in tool_payload(sent)[0], "internal flags leaked into the model's context"

# A 403 is a bot block, not a missing page: it must survive.
events, sent = collect(
    [TOOL_CALL, {"content": "done"}], rows=THREE_ROWS, statuses={"https://a.example/gyoza": 403}
)
assert len(tool_payload(sent)) == 3, tool_payload(sent)

# --- invented URLs --------------------------------------------------------------------

answer = "Try https://a.example/gyoza and https://totally-made-up.example/shinjuku"
events, _ = collect([TOOL_CALL, {"content": answer}], rows=THREE_ROWS)
assert events[-1]["unretrieved"] == ["https://totally-made-up.example/shinjuku"], events[-1]

# A retrieved URL cited with a trailing slash is still the same page, not an invention.
events, _ = collect([TOOL_CALL, {"content": "see https://a.example/gyoza/."}], rows=THREE_ROWS)
assert events[-1]["unretrieved"] == [], events[-1]

# Markdown around a link is not part of it: **bold** must not read as an invented URL.
events, _ = collect(
    [TOOL_CALL, {"content": "**https://a.example/gyoza** and `https://b.example/gyoza`"}],
    rows=THREE_ROWS,
)
assert events[-1]["unretrieved"] == [], events[-1]

# With no search at all, every URL in the answer is the model's own.
events, _ = collect([{"content": "go to https://nowhere.example"}])
assert events[-1]["unretrieved"] == ["https://nowhere.example"], events[-1]

# A failure mid-stream is reported in-band: headers already went out with a 200.
async def boom(client, messages, tools=None):
    raise RuntimeError("ollama is down")


main.ask_ollama = boom
with TestClient(main.app) as client:
    with client.stream("POST", "/api/chat", json={"message": "hi"}) as response:
        events = [json.loads(line) for line in response.iter_lines() if line.strip()]
assert events[-1] == {"type": "error", "error": "ollama is down"}, events



# --- health probes --------------------------------------------------------------------

import asyncio


class FakeResponse:
    def __init__(self, payload=None, status=200):
        self.payload = payload
        self.status = status

    def raise_for_status(self):
        if self.status >= 400:
            raise RuntimeError(f"HTTP {self.status}")

    def json(self):
        return self.payload


class FakeClient:
    """One canned answer per URL. Anything else raises, like a refused connection."""

    def __init__(self, answers):
        self.answers = answers

    async def get(self, url, timeout=None):
        if url not in self.answers:
            raise RuntimeError("All connection attempts failed")
        return self.answers[url]


TAGS = f"{main.OLLAMA_HOST}/api/tags"
HEALTHZ = f"{main.SEARXNG_HOST}/healthz"

# The happy path: the service answers and the configured model is in the list.
pulled = FakeClient({TAGS: FakeResponse({"models": [{"name": main.OLLAMA_MODEL}]})})
assert asyncio.run(main.probe(pulled, TAGS, main.model_pulled)) == {
    "up": True,
    "detail": main.OLLAMA_MODEL,
}

# Ollama is running but the model was never pulled — down, with the command that fixes it.
empty = FakeClient({TAGS: FakeResponse({"models": []})})
result = asyncio.run(main.probe(empty, TAGS, main.model_pulled))
assert result["up"] is False and "ollama pull" in result["detail"], result

# Nothing listening: the reason reaches the page rather than an empty string.
result = asyncio.run(main.probe(FakeClient({}), HEALTHZ))
assert result["up"] is False and result["detail"], result

# A 5xx is down too, even though the connection itself succeeded.
result = asyncio.run(main.probe(FakeClient({HEALTHZ: FakeResponse(status=502)}), HEALTHZ))
assert result["up"] is False, result

print("ok")
