# Architecture

Two diagrams. The first is what the pieces are and who talks to whom; the second is what
happens between pressing Enter and reading an answer. A Japanese version of both follows.

## Components

```mermaid
flowchart LR
    subgraph browser["Browser — localhost:5173"]
        App["App.jsx<br/>reads the NDJSON stream,<br/>folds each event into a turn"]
        Strip["HealthStrip<br/>polls /api/health"]
    end

    subgraph backend["FastAPI — localhost:8000"]
        Chat["/api/chat<br/>run_agent"]
        Api["/api/health"]
        Search["search_blocking<br/>ddgs, in a worker thread"]
        Check["check_alive<br/>HEAD, then GET on 405"]
        Verify["unretrieved_urls<br/>unsupported_citations"]
    end

    Ollama["Ollama — localhost:11434<br/>qwen3:1.7b, tool calling<br/>num_ctx 8192"]
    DDG["ddgs — 8 engines, rotated<br/>title, URL, 500-char snippet"]
    Pages["The result pages<br/>status code only, never read"]

    App -->|"POST question"| Chat
    Chat -->|"NDJSON, one event per line"| App
    Strip --> Api

    Chat <-->|"messages + web_search tool"| Ollama
    Chat --> Search
    Search --> DDG
    Chat --> Check
    Check --> Pages
    Chat --> Verify

    Api -.->|"is it up, is the model pulled"| Ollama
```

The dashed edge is a liveness probe, nothing more. Ollama is the only thing running
outside this repo: `ddgs` is a library inside the backend process, so there is no search
service to be up or down.

## One request, end to end

```mermaid
sequenceDiagram
    autonumber
    actor U as You
    participant P as Page
    participant A as run_agent
    participant M as Ollama
    participant D as ddgs
    participant W as Result pages

    U->>P: a question
    P->>A: POST /api/chat

    loop up to MAX_ITERATIONS (3) rounds
        A-->>P: thinking
        A->>M: system prompt + messages + web_search tool
        alt the model answers directly
            M-->>A: text, no tool_calls
        else the model calls the tool
            M-->>A: web_search(query)
            A-->>P: search_start
            A->>D: query
            D-->>A: 5 rows, title + URL + snippet
            Note over A: drop URLs already retrieved this turn
            A->>W: HEAD each new URL, in parallel
            W-->>A: status code
            Note over A: 404, 410 and unreachable are dead.<br/>403 and 429 are bot blocks, kept
            A-->>P: search_done + results, duplicates, dead
            A->>M: tool result: reachable rows only
        end
    end

    Note over A: budget spent? one last call with no tools,<br/>which forces text instead of another search
    Note over A: unretrieved_urls: URLs in the answer no search returned<br/>unsupported_citations: blocks whose cited snippet never names them
    A-->>P: answer + unretrieved + unsupported
    P-->>U: markdown answer, source list, warnings
```

What the model is given is the whole of what it knows: five titles and 500-character
snippets, about 600 tokens per search. No page is ever fetched, so the citation checks are
the only thing standing between a plausible sentence and a checked one.

---

# アーキテクチャ

図は二つ。一つ目は構成要素とその通信相手、二つ目は Enter を押してから答えが表示されるま
でに起きること。

## 構成要素

```mermaid
flowchart LR
    subgraph browser["ブラウザ — localhost:5173"]
        App["App.jsx<br/>NDJSON ストリームを読み、<br/>各イベントを 1 ターンに畳み込む"]
        Strip["HealthStrip<br/>/api/health を定期的に確認"]
    end

    subgraph backend["FastAPI — localhost:8000"]
        Chat["/api/chat<br/>run_agent"]
        Api["/api/health"]
        Search["search_blocking<br/>ddgs、ワーカースレッド上"]
        Check["check_alive<br/>HEAD、405 なら GET"]
        Verify["unretrieved_urls<br/>unsupported_citations"]
    end

    Ollama["Ollama — localhost:11434<br/>qwen3:1.7b、ツール呼び出し対応<br/>num_ctx 8192"]
    DDG["ddgs — 8 エンジンを巡回<br/>タイトル、URL、500 文字のスニペット"]
    Pages["検索結果のページ<br/>ステータスコードのみ、本文は読まない"]

    App -->|"質問を POST"| Chat
    Chat -->|"NDJSON、1 行 1 イベント"| App
    Strip --> Api

    Chat <-->|"メッセージ + web_search ツール"| Ollama
    Chat --> Search
    Search --> DDG
    Chat --> Check
    Check --> Pages
    Chat --> Verify

    Api -.->|"起動しているか、モデルは取得済みか"| Ollama
```

破線は死活監視だけを表す。このリポジトリの外で動くのは Ollama だけであり、`ddgs` は
バックエンドのプロセス内のライブラリなので、起動を確認すべき検索サービスは存在しない。

## リクエスト 1 件の流れ

```mermaid
sequenceDiagram
    autonumber
    actor U as 利用者
    participant P as 画面
    participant A as run_agent
    participant M as Ollama
    participant D as ddgs
    participant W as 結果ページ

    U->>P: 質問
    P->>A: POST /api/chat

    loop 最大 MAX_ITERATIONS (3) 回
        A-->>P: thinking
        A->>M: システムプロンプト + メッセージ + web_search ツール
        alt モデルが直接答える
            M-->>A: 本文のみ、tool_calls なし
        else モデルがツールを呼ぶ
            M-->>A: web_search(query)
            A-->>P: search_start
            A->>D: 検索語
            D-->>A: 5 件、タイトル + URL + スニペット
            Note over A: このターンで取得済みの URL は捨てる
            A->>W: 新しい URL を並列に HEAD
            W-->>A: ステータスコード
            Note over A: 404、410、到達不能はリンク切れ扱い。<br/>403 と 429 はボット拒否なので残す
            A-->>P: search_done + results、duplicates、dead
            A->>M: ツール結果: 到達できた行だけ
        end
    end

    Note over A: 回数を使い切ったら、ツールなしで最後に 1 回呼ぶ。<br/>再検索ではなく本文を書かせるため
    Note over A: unretrieved_urls: どの検索も返していない URL<br/>unsupported_citations: 引用先のスニペットが名前に触れていない塊
    A-->>P: answer + unretrieved + unsupported
    P-->>U: Markdown の回答、出典一覧、警告
```

モデルが持っている情報は、渡されたものがすべてである。タイトル 5 件と 500 文字のスニペッ
ト、検索 1 回あたり約 600 トークン。ページ本文は一度も取得しない。だから引用の検証だけが、
もっともらしい文と裏付けのある文とを分けている。
