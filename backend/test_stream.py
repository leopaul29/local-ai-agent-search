"""Self-check for the /api/chat event stream. No Ollama, no network.

Run:  .venv\Scripts\python.exe test_stream.py
"""

import json

import main
from fastapi.testclient import TestClient


def collect(replies, question="anything"):
    """Drive the endpoint with a scripted sequence of Ollama replies."""
    scripted = list(replies)

    async def fake_ask(client, messages, tools=None):
        return scripted.pop(0)

    main.ask_ollama = fake_ask
    main.search_blocking = lambda query, max_results=5: [
        {"title": "T", "url": "https://example.com", "snippet": "S"}
    ]

    with TestClient(main.app) as client:
        with client.stream("POST", "/api/chat", json={"message": question}) as response:
            assert response.status_code == 200, response.status_code
            return [json.loads(line) for line in response.iter_lines() if line.strip()]


TOOL_CALL = {
    "role": "assistant",
    "tool_calls": [{"function": {"name": "web_search", "arguments": {"query": "fastapi"}}}],
}

# No tool call: one thinking event, then the answer. The model never searched.
events = collect([{"content": "42"}])
assert [event["type"] for event in events] == ["thinking", "answer"], events
assert events[-1]["answer"] == "42"

# One tool call, then an answer: the search bracket must arrive before the answer.
events = collect([TOOL_CALL, {"content": "done"}])
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
events = collect([string_args, {"content": "done"}])
assert events[1]["query"] == "x", events

# Tool budget exhausted: the loop still ends on an answer, never on a dangling search.
events = collect([TOOL_CALL] * main.MAX_ITERATIONS + [{"content": "forced"}])
assert events[-1] == {"type": "answer", "answer": "forced"}, events[-1]
assert sum(event["type"] == "search_done" for event in events) == main.MAX_ITERATIONS

# A failure mid-stream is reported in-band: headers already went out with a 200.
async def boom(client, messages, tools=None):
    raise RuntimeError("ollama is down")


main.ask_ollama = boom
with TestClient(main.app) as client:
    with client.stream("POST", "/api/chat", json={"message": "hi"}) as response:
        events = [json.loads(line) for line in response.iter_lines() if line.strip()]
assert events[-1] == {"type": "error", "error": "ollama is down"}, events

print("ok")
