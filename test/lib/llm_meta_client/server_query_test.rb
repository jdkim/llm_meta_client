require "test_helper"

# Tests for the HTTP client that talks to llm_meta_server. This class is
# the only place llm_meta_client makes outbound calls, so it's the load-
# bearing surface for every consumer (test_service + production).
#
# WebMock stubs only the upstream meta-server; URL construction, request
# bodies, response parsing, SSE assembly, and error mapping all run for real.
class LlmMetaClient::ServerQueryTest < ActiveSupport::TestCase
  BASE = "https://meta-server.invalid"
  UUID = "key-uuid-123"
  MODEL = "gpt-5"
  TOKEN = "id-token"
  CHATS_URL = "#{BASE}/api/llm_api_keys/#{UUID}/models/#{MODEL}/chats"
  STREAM_URL = "#{BASE}/api/llm_api_keys/#{UUID}/models/#{MODEL}/chat_streams"

  setup do
    @query = LlmMetaClient::ServerQuery.new
  end

  # ----- #call (synchronous) -----

  test "#call posts to /chats with the Bearer header and returns the assistant message" do
    stub_request(:post, CHATS_URL)
      .with(headers: { "Authorization" => "Bearer #{TOKEN}", "Content-Type" => "application/json" })
      .to_return(status: 200, body: { response: { message: "hello back" } }.to_json,
                 headers: { "Content-Type" => "application/json" })

    result = @query.call(TOKEN, UUID, MODEL, "Some context", "what's up?")

    assert_equal "hello back", result
    assert_requested(:post, CHATS_URL) do |req|
      body = JSON.parse(req.body)
      body["prompt"].include?("Some context") && body["prompt"].include?("what's up?")
    end
  end

  test "#call omits the Authorization header when id_token is nil" do
    stub_request(:post, CHATS_URL).to_return(
      status: 200, body: { response: { message: "anon" } }.to_json,
      headers: { "Content-Type" => "application/json" }
    )

    @query.call(nil, UUID, MODEL, "ctx", "msg")

    assert_requested(:post, CHATS_URL) { |req| !req.headers.key?("Authorization") }
  end

  test "#call appends a Tool calls markdown section when tool_calls are returned" do
    stub_request(:post, CHATS_URL).to_return(
      status: 200,
      body: {
        response: {
          message: "Done.",
          tool_calls: [ { "id" => "c1", "name" => "lookup", "arguments" => { "q" => "x" } } ]
        }
      }.to_json,
      headers: { "Content-Type" => "application/json" }
    )

    result = @query.call(TOKEN, UUID, MODEL, "ctx", "msg")

    assert_includes result, "Done."
    assert_includes result, "**Tool calls**"
    assert_includes result, "`lookup`"
    assert_includes result, "{\"q\":\"x\"}"
  end

  test "#call raises EmptyResponseError when both message and tool_calls are absent" do
    stub_request(:post, CHATS_URL).to_return(
      status: 200, body: { response: { message: "" } }.to_json,
      headers: { "Content-Type" => "application/json" }
    )

    assert_raises(LlmMetaClient::Exceptions::EmptyResponseError) do
      @query.call(TOKEN, UUID, MODEL, "ctx", "msg")
    end
  end

  test "#call raises InvalidResponseError when the server returns non-JSON" do
    stub_request(:post, CHATS_URL).to_return(
      status: 200, body: "<html>not json</html>",
      headers: { "Content-Type" => "text/html" }
    )

    assert_raises(LlmMetaClient::Exceptions::InvalidResponseError) do
      @query.call(TOKEN, UUID, MODEL, "ctx", "msg")
    end
  end

  test "#call maps a 429 from the server to a Rate-limit error message" do
    stub_request(:post, CHATS_URL).to_return(
      status: 429,
      body: { error: "LLM API Rate limit exceeded", message: "Too many requests" }.to_json,
      headers: { "Content-Type" => "application/json" }
    )

    err = assert_raises(LlmMetaClient::Exceptions::ServerError) do
      @query.call(TOKEN, UUID, MODEL, "ctx", "msg")
    end
    assert_match(/Rate limit exceeded/, err.message)
    assert_match(/Too many requests/, err.message)
  end

  test "#call surfaces an expired-token error as a friendly re-sign-in prompt" do
    stub_request(:post, CHATS_URL).to_return(
      status: 400, body: { error: "Token has expired", message: "exp 1700000000" }.to_json,
      headers: { "Content-Type" => "application/json" }
    )

    err = assert_raises(LlmMetaClient::Exceptions::ServerError) do
      @query.call(TOKEN, UUID, MODEL, "ctx", "msg")
    end
    assert_match(/sign-in expired/i, err.message)
  end

  # ----- #stream (SSE) -----

  test "#stream parses SSE frames into events and assembles the deltas" do
    body = [
      sse("phase", { name: "thinking" }),
      sse("message", { delta: "Hello" }),
      sse("message", { delta: " world" }),
      sse("done", {})
    ].join

    stub_request(:post, STREAM_URL).to_return(
      status: 200, headers: { "Content-Type" => "text/event-stream" }, body: body
    )

    yielded = []
    result = @query.stream(TOKEN, UUID, MODEL, "ctx", "go") { |ev| yielded << ev }

    assert_equal "Hello world", result
    delta_events = yielded.select { |e| e[:event] == "message" }
    assert_equal [ "Hello", " world" ], delta_events.map { |e| e[:data]["delta"] }
    # phase was yielded through the "else" branch; done was absorbed.
    assert_includes yielded.map { |e| e[:event] }, "phase"
    refute_includes yielded.map { |e| e[:event] }, "done"
  end

  test "#stream raises ServerError on an event: error frame with the rate-limit code" do
    body = [
      sse("phase", { name: "thinking" }),
      sse("error", { code: "rate_limit", message: "slow down" })
    ].join

    stub_request(:post, STREAM_URL).to_return(
      status: 200, headers: { "Content-Type" => "text/event-stream" }, body: body
    )

    err = assert_raises(LlmMetaClient::Exceptions::ServerError) do
      @query.stream(TOKEN, UUID, MODEL, "ctx", "go") { }
    end
    assert_match(/Rate limit exceeded/, err.message)
    assert_match(/slow down/, err.message)
  end

  test "#stream raises ServerError when the HTTP status itself is non-success" do
    stub_request(:post, STREAM_URL).to_return(
      status: 502, body: { error: "Bad gateway" }.to_json,
      headers: { "Content-Type" => "application/json" }
    )

    err = assert_raises(LlmMetaClient::Exceptions::ServerError) do
      @query.stream(TOKEN, UUID, MODEL, "ctx", "go") { }
    end
    assert_match(/Bad gateway/, err.message)
  end

  test "#stream forwards an attached image and image_context as a structured body" do
    body = [
      sse("message", { delta: "ok" }),
      sse("done", {})
    ].join
    stub_request(:post, STREAM_URL).to_return(
      status: 200, headers: { "Content-Type" => "text/event-stream" }, body: body
    )

    @query.stream(TOKEN, UUID, MODEL, "unused-context", { prompt: "describe" },
                  image_context: [ { prompt: "p1", response: "r1" } ],
                  image: { mime: "image/png", data_b64: "AAA" }) { }

    assert_requested(:post, STREAM_URL) do |req|
      b = JSON.parse(req.body)
      b["prompt"] == "describe" &&
        b["image"] == { "mime" => "image/png", "data_b64" => "AAA" } &&
        b["image_context"].is_a?(Array) && b["image_context"].length == 1
    end
  end

  test "#stream forwards an attached document (PDF) as a top-level `document` field" do
    body = [ sse("message", { delta: "ok" }), sse("done", {}) ].join
    stub_request(:post, STREAM_URL).to_return(
      status: 200, headers: { "Content-Type" => "text/event-stream" }, body: body
    )

    @query.stream(TOKEN, UUID, MODEL, "ctx", "summarize this",
                  document: { mime: "application/pdf", data_b64: "JVBERi0x" }) { }

    assert_requested(:post, STREAM_URL) do |req|
      b = JSON.parse(req.body)
      b["document"] == { "mime" => "application/pdf", "data_b64" => "JVBERi0x" }
    end
  end

  test "#stream omits `document` from the body when the kwarg is not given" do
    body = [ sse("message", { delta: "ok" }), sse("done", {}) ].join
    stub_request(:post, STREAM_URL).to_return(
      status: 200, headers: { "Content-Type" => "text/event-stream" }, body: body
    )

    @query.stream(TOKEN, UUID, MODEL, "ctx", "hi") { }

    assert_requested(:post, STREAM_URL) do |req|
      b = JSON.parse(req.body)
      !b.key?("document")
    end
  end

  test "#call forwards an attached document (PDF) in the JSON body" do
    stub_request(:post, CHATS_URL).to_return(
      status: 200, body: { response: { message: "ok" } }.to_json,
      headers: { "Content-Type" => "application/json" }
    )

    @query.call(TOKEN, UUID, MODEL, "ctx", "read this paper",
                document: { mime: "application/pdf", data_b64: "JVBERi0x" })

    assert_requested(:post, CHATS_URL) do |req|
      b = JSON.parse(req.body)
      b["document"] == { "mime" => "application/pdf", "data_b64" => "JVBERi0x" }
    end
  end

  test "#call omits `document` when the kwarg is not given" do
    stub_request(:post, CHATS_URL).to_return(
      status: 200, body: { response: { message: "ok" } }.to_json,
      headers: { "Content-Type" => "application/json" }
    )

    @query.call(TOKEN, UUID, MODEL, "ctx", "hi")

    assert_requested(:post, CHATS_URL) do |req|
      b = JSON.parse(req.body)
      !b.key?("document")
    end
  end

  test "#stream yields thinking events to the caller without folding them into the assembled content" do
    body = [
      sse("thinking", { delta: "let me think" }),
      sse("thinking", { delta: " about this" }),
      sse("message", { delta: "Hello" }),
      sse("message", { delta: " world" }),
      sse("done", {})
    ].join

    stub_request(:post, STREAM_URL).to_return(
      status: 200, headers: { "Content-Type" => "text/event-stream" }, body: body
    )

    yielded = []
    result = @query.stream(TOKEN, UUID, MODEL, "ctx", "go") { |ev| yielded << ev }

    # The assembled return value reflects ONLY content deltas — thinking is ephemeral.
    assert_equal "Hello world", result

    # But thinking events were yielded through to the caller's block intact.
    thinking_deltas = yielded.select { |e| e[:event] == "thinking" }.map { |e| e[:data]["delta"] }
    assert_equal [ "let me think", " about this" ], thinking_deltas
  end

  test "#stream captures tool_calls events and folds them into the returned string" do
    body = [
      sse("message", { delta: "Using a tool..." }),
      sse("tool_calls", { tool_calls: [ { "id" => "c1", "name" => "lookup", "arguments" => { "q" => "x" } } ] }),
      sse("message", { delta: " done." }),
      sse("done", {})
    ].join

    stub_request(:post, STREAM_URL).to_return(
      status: 200, headers: { "Content-Type" => "text/event-stream" }, body: body
    )

    result = @query.stream(TOKEN, UUID, MODEL, "ctx", "go") { }

    assert_includes result, "Using a tool... done."
    assert_includes result, "**Tool calls**"
    assert_includes result, "`lookup`"
  end

  private

  def sse(event, data)
    "event: #{event}\ndata: #{data.to_json}\n\n"
  end
end
