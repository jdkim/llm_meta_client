// Node built-in test runner (v18+). Run:
//   node --test lib/generators/llm_meta_client/scaffold/templates/app/javascript/llm_meta_orchestrator.test.mjs
//
// Tests focus on the SSE parser — the piece most likely to have edge-case
// bugs (chunk boundaries, missing trailing newline, CRLF frames, event-less
// data frames). Integration with fetch() is covered manually via the demo
// page in the chat host.

import { test } from "node:test"
import assert from "node:assert/strict"

import { parseSseStream, dispatchLocalToolCalls, runChatLoop, callMcpTool, fetchMcpManifest } from "./llm_meta_orchestrator.js"

// --- fixtures --------------------------------------------------------------

function streamFrom(chunks) {
  // ReadableStream of Uint8Array chunks, mirroring what fetch() delivers.
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]))
      } else {
        controller.close()
      }
    },
  })
}

async function collect(stream) {
  const events = []
  for await (const e of parseSseStream(stream)) events.push(e)
  return events
}

// --- tests -----------------------------------------------------------------

test("parses a single named event with JSON data", async () => {
  const events = await collect(streamFrom([
    "event: text_delta\ndata: {\"delta\":\"hi\"}\n\n",
  ]))
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { name: "text_delta", data: { delta: "hi" } })
})

test("parses multiple events across a single chunk", async () => {
  const events = await collect(streamFrom([
    "event: text_delta\ndata: {\"delta\":\"a\"}\n\n" +
    "event: text_delta\ndata: {\"delta\":\"b\"}\n\n" +
    "event: done\ndata: {\"content\":\"ab\",\"finish_reason\":null}\n\n",
  ]))
  assert.equal(events.length, 3)
  assert.equal(events[0].data.delta, "a")
  assert.equal(events[1].data.delta, "b")
  assert.equal(events[2].name, "done")
  assert.equal(events[2].data.content, "ab")
})

test("handles events split ACROSS chunks (fetch delivers arbitrary boundaries)", async () => {
  // Break mid-field name, mid-JSON, and mid-frame delimiter.
  const events = await collect(streamFrom([
    "event: text_d",       // split mid field-name
    "elta\ndata: {\"del",   // split mid JSON key
    "ta\":\"chunk\"}\n",     // no blank line yet
    "\n",                   // frame terminator arrives in next chunk
    "event: done\ndata: {\"content\":\"chunk\",\"finish_reason\":null}\n\n",
  ]))
  assert.equal(events.length, 2)
  assert.equal(events[0].name, "text_delta")
  assert.equal(events[0].data.delta, "chunk")
  assert.equal(events[1].name, "done")
})

test("accepts CRLF frame delimiters (some proxies rewrite LF-only)", async () => {
  const events = await collect(streamFrom([
    "event: text_delta\r\ndata: {\"delta\":\"crlf\"}\r\n\r\n",
    "event: done\r\ndata: {\"content\":\"crlf\",\"finish_reason\":\"stop\"}\r\n\r\n",
  ]))
  assert.equal(events.length, 2)
  assert.equal(events[0].data.delta, "crlf")
  assert.equal(events[1].data.finish_reason, "stop")
})

test("event-less `data:` line defaults to name='message'", async () => {
  const events = await collect(streamFrom([
    "data: {\"x\":1}\n\n",
  ]))
  assert.equal(events.length, 1)
  assert.equal(events[0].name, "message")
  assert.deepEqual(events[0].data, { x: 1 })
})

test("comment lines (leading ':') are ignored (keepalive heartbeat frames)", async () => {
  const events = await collect(streamFrom([
    ": keepalive\n\n",
    "event: done\ndata: {\"content\":\"\",\"finish_reason\":null}\n\n",
  ]))
  // Comment-only frame yields no event.
  assert.equal(events.length, 1)
  assert.equal(events[0].name, "done")
})

test("multiple data: lines concatenate with \\n between them", async () => {
  const events = await collect(streamFrom([
    "event: text_delta\ndata: line1\ndata: line2\n\n",
  ]))
  assert.equal(events.length, 1)
  // Data is not valid JSON here → surfaces as _raw.
  assert.equal(events[0].data._raw, "line1\nline2")
  assert.ok(events[0].data._parseError)
})

test("empty stream yields no events (and doesn't hang)", async () => {
  const events = await collect(streamFrom([]))
  assert.equal(events.length, 0)
})

test("trailing frame without terminator is still flushed on stream close", async () => {
  // Some servers close the connection without a final blank line — recover.
  const events = await collect(streamFrom([
    "event: text_delta\ndata: {\"delta\":\"tail\"}",
  ]))
  assert.equal(events.length, 1)
  assert.equal(events[0].data.delta, "tail")
})

test("mixed heartbeat + real events (mirrors the actual smoke-1 body)", async () => {
  const smoke1 =
    "event: phase\ndata: {\"name\":\"thinking\"}\n\n" +
    "event: phase\ndata: {\"name\":\"thinking\"}\n\n" +
    ": keepalive\n\n" +
    ": keepalive\n\n" +
    "event: text_delta\ndata: {\"delta\":\"Hi\"}\n\n" +
    "event: text_delta\ndata: {\"delta\":\",\"}\n\n" +
    "event: text_delta\ndata: {\"delta\":\" how\"}\n\n" +
    "event: done\ndata: {\"content\":\"Hi, how\",\"finish_reason\":null}\n\n"

  const events = await collect(streamFrom([smoke1]))
  const names = events.map((e) => e.name)
  assert.deepEqual(names, [
    "phase", "phase", "text_delta", "text_delta", "text_delta", "done",
  ])
  assert.equal(events.at(-1).data.content, "Hi, how")
})

// ===========================================================================
// dispatchLocalToolCalls — Piece B
// ===========================================================================

test("invokes the matching aiAction with parsed arguments and returns dispatched result", async () => {
  const calls = []
  const aiActions = {
    add_dictionaries: (args) => { calls.push(["add", args]); return "ok" },
  }
  const { dispatched, skipped } = await dispatchLocalToolCalls(
    [{ id: "1", name: "add_dictionaries", arguments: { names: ["uberon"] } }],
    aiActions
  )
  assert.equal(skipped.length, 0)
  assert.equal(dispatched.length, 1)
  assert.deepEqual(dispatched[0].toolCall.arguments, { names: ["uberon"] })
  assert.equal(dispatched[0].value, "ok")
  assert.deepEqual(calls, [["add", { names: ["uberon"] }]])
})

test("skips tool_calls whose name isn't in aiActions (Piece D will handle them as remote MCP)", async () => {
  const aiActions = { add_dictionaries: () => {} }
  const { dispatched, skipped } = await dispatchLocalToolCalls(
    [
      { id: "1", name: "add_dictionaries", arguments: {} },
      { id: "2", name: "text_annotation",  arguments: { text: "..." } },
    ],
    aiActions
  )
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].toolCall.id, "1")
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].id, "2")
  assert.equal(skipped[0].name, "text_annotation")
})

test("invokes multiple aiActions in the order the LLM emitted them (sequential, not parallel)", async () => {
  const order = []
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))
  const aiActions = {
    a: async () => { order.push("a-start"); await delay(20); order.push("a-end") },
    b: async () => { order.push("b-start"); await delay(1);  order.push("b-end") },
  }
  await dispatchLocalToolCalls(
    [
      { id: "1", name: "a", arguments: {} },
      { id: "2", name: "b", arguments: {} },
    ],
    aiActions
  )
  // If parallel, "b-end" would land before "a-end". Sequential means a
  // completes fully before b starts.
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"])
})

test("captures an aiAction throw as .error on the dispatched entry, keeps going", async () => {
  const seen = []
  const aiActions = {
    boom:    () => { throw new Error("kablam") },
    survive: (args) => { seen.push(args); return "ok" },
  }
  const { dispatched } = await dispatchLocalToolCalls(
    [
      { id: "1", name: "boom",    arguments: {} },
      { id: "2", name: "survive", arguments: { x: 1 } },
    ],
    aiActions
  )
  assert.equal(dispatched.length, 2)
  assert.ok(dispatched[0].error instanceof Error)
  assert.equal(dispatched[0].error.message, "kablam")
  assert.equal(dispatched[1].value, "ok")
  assert.deepEqual(seen, [{ x: 1 }])
})

test("coerces arguments given as a JSON string (defensive against provider adapter drift)", async () => {
  let seen = null
  const aiActions = { set_semantic_threshold: (args) => { seen = args } }
  await dispatchLocalToolCalls(
    [{ id: "1", name: "set_semantic_threshold", arguments: '{"value":0.85}' }],
    aiActions
  )
  assert.deepEqual(seen, { value: 0.85 })
})

test("coerces null / undefined arguments to an empty object", async () => {
  const seen = []
  const aiActions = { submit_annotation: (args) => { seen.push(args) } }
  await dispatchLocalToolCalls(
    [
      { id: "1", name: "submit_annotation", arguments: null },
      { id: "2", name: "submit_annotation", arguments: undefined },
    ],
    aiActions
  )
  assert.deepEqual(seen, [{}, {}])
})

test("empty / missing toolCalls array is a no-op (returns empty dispatched + skipped)", async () => {
  const r1 = await dispatchLocalToolCalls([], { anything: () => {} })
  const r2 = await dispatchLocalToolCalls(undefined, { anything: () => {} })
  assert.deepEqual(r1, { dispatched: [], skipped: [] })
  assert.deepEqual(r2, { dispatched: [], skipped: [] })
})

test("non-function entries in aiActions are treated as absent (skipped, not thrown)", async () => {
  const aiActions = { add_dictionaries: "not a function" }
  const { dispatched, skipped } = await dispatchLocalToolCalls(
    [{ id: "1", name: "add_dictionaries", arguments: {} }],
    aiActions
  )
  // Broken schema declaration shouldn't crash the whole batch — Piece C's
  // page-side wiring is expected to catch this during page-boot validation.
  assert.equal(dispatched.length, 0)
  assert.equal(skipped.length, 1)
})

// ===========================================================================
// runChatLoop — Piece D (remote-tool round-trip loop)
// ===========================================================================
//
// Strategy: stub globalThis.fetch based on request URL. singleLlmCall runs
// end-to-end against the stubbed fetch (real SSE parser, real callback
// plumbing), so bugs in the fetch-shape are caught here alongside bugs in
// the loop logic itself.

// --- fetch stub helpers ----------------------------------------------------

function sseResponse(bodyStr) {
  return new Response(bodyStr, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  })
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

// Build a done-only SSE body (no tool_calls).
function sseDoneOnly(content) {
  return `event: done\ndata: ${JSON.stringify({ content, finish_reason: "stop" })}\n\n`
}

// Build an SSE body that emits N tool_calls, THEN a done frame.
function sseWithToolCalls(toolCalls, content = "") {
  const frames = toolCalls.map(
    (tc) => `event: tool_call\ndata: ${JSON.stringify({ tool_call: tc })}\n\n`
  ).join("")
  return frames +
    `event: done\ndata: ${JSON.stringify({ content, finish_reason: "tool_calls" })}\n\n`
}

// Route-table fetch stub. `routes` is a list of matchers; the first one
// whose URL predicate returns true wins. Each matcher's `respond` is called
// with the parsed request body and can return canned or dynamic responses.
function mockFetch(routes) {
  const calls = []
  const fn = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null
    calls.push({ url, method: init?.method || "GET", body })
    for (const r of routes) {
      if (r.matches(url)) return r.respond(body, calls.length)
    }
    throw new Error(`mockFetch: no route for ${url}`)
  }
  fn.calls = calls
  return fn
}

// Common opts every runChatLoop test uses.
const BASE_OPTS = {
  baseUrl:    "https://meta.test",
  apiKeyUuid: "test-key",
  modelName:  "test-model",
  messages:   [ { role: "user", content: "hi" } ]
}

async function withFetch(routes, fn) {
  const orig = globalThis.fetch
  const mock = mockFetch(routes)
  globalThis.fetch = mock
  try {
    return { result: await fn(mock), calls: mock.calls }
  } finally {
    globalThis.fetch = orig
  }
}

// --- tests -----------------------------------------------------------------

test("runChatLoop: zero tool_calls → single round, returns immediately", async () => {
  const { result, calls } = await withFetch(
    [ { matches: (u) => u.includes("/single_llm_calls"), respond: () => sseResponse(sseDoneOnly("hello there")) } ],
    (mock) => runChatLoop(BASE_OPTS)
  )
  assert.equal(result.rounds.length, 1)
  assert.equal(result.content, "hello there")
  assert.equal(result.dispatched.length, 0)
  assert.equal(result.skipped.length, 0)
  assert.equal(calls.length, 1)  // exactly one LLM call, no MCP proxy
})

test("runChatLoop: only local tool_calls → dispatch, no loop (locals never round-trip)", async () => {
  const aiActionCalls = []
  const aiActions = { add_dictionaries: (args) => { aiActionCalls.push(args) } }

  const { result, calls } = await withFetch(
    [ { matches: (u) => u.includes("/single_llm_calls"),
        respond: () => sseResponse(
          sseWithToolCalls([ { id: "c1", name: "add_dictionaries", arguments: { names: [ "uberon" ] } } ])
        ) } ],
    (mock) => runChatLoop({ ...BASE_OPTS, aiActions })
  )
  assert.equal(result.rounds.length, 1)
  assert.deepEqual(aiActionCalls, [ { names: [ "uberon" ] } ])
  assert.equal(result.dispatched.length, 1)
  assert.equal(result.dispatched[0].toolCall.name, "add_dictionaries")
  // Fire-and-forget: one LLM call, no follow-up.
  assert.equal(calls.filter((c) => c.url.includes("single_llm_calls")).length, 1)
})

test("runChatLoop: only remote tool_calls → POST to /mcp_tools/:id/call, feed result back, second round terminates", async () => {
  const remoteTools = [ { id: 42, name: "text_annotation" } ]
  let round = 0
  const { result, calls } = await withFetch(
    [
      { matches: (u) => u.includes("/single_llm_calls"),
        respond: () => {
          round++
          if (round === 1) {
            return sseResponse(sseWithToolCalls(
              [ { id: "c1", name: "text_annotation", arguments: { text: "the heart" } } ],
              ""  // no text, just tool_call
            ))
          }
          return sseResponse(sseDoneOnly("Found 3 anatomical entities."))
        } },
      { matches: (u) => u.includes("/mcp_tools/42/call"),
        respond: (body) => jsonResponse({ result: { denotations: [ { obj: "UBERON:0000948" } ] } }) }
    ],
    (mock) => runChatLoop({ ...BASE_OPTS, remoteTools })
  )
  assert.equal(result.rounds.length, 2, "two LLM rounds — request + synthesis")
  assert.equal(result.content, "Found 3 anatomical entities.")
  assert.equal(result.dispatched.length, 1)
  assert.deepEqual(result.dispatched[0].value, { denotations: [ { obj: "UBERON:0000948" } ] })
  // Two single_llm_calls + one mcp_tools call
  assert.equal(calls.filter((c) => c.url.includes("single_llm_calls")).length, 2)
  assert.equal(calls.filter((c) => c.url.includes("mcp_tools/42/call")).length, 1)

  // Second round's request MUST carry the assistant-with-tool_calls + tool-result messages
  const secondReq = calls.filter((c) => c.url.includes("single_llm_calls"))[1].body
  const roles = secondReq.messages.map((m) => m.role)
  assert.deepEqual(roles, [ "user", "assistant", "tool" ])
  assert.equal(secondReq.messages[1].tool_calls[0].name, "text_annotation")
  assert.equal(secondReq.messages[2].tool_call_id, "c1")
  assert.equal(secondReq.messages[2].name, "text_annotation")
})

test("runChatLoop: mixed local + remote → both dispatched, only remote triggers follow-up round", async () => {
  const remoteTools = [ { id: 99, name: "search_pubmed" } ]
  const aiActions = { set_semantic_threshold: () => "ok" }
  let round = 0
  const { result, calls } = await withFetch(
    [
      { matches: (u) => u.includes("/single_llm_calls"),
        respond: () => {
          round++
          if (round === 1) {
            return sseResponse(sseWithToolCalls([
              { id: "c1", name: "set_semantic_threshold", arguments: { value: 0.8 } },
              { id: "c2", name: "search_pubmed", arguments: { q: "diabetes" } }
            ]))
          }
          return sseResponse(sseDoneOnly("Done."))
        } },
      { matches: (u) => u.includes("/mcp_tools/99/call"),
        respond: () => jsonResponse({ result: "3 papers found" }) }
    ],
    (mock) => runChatLoop({ ...BASE_OPTS, aiActions, remoteTools })
  )
  assert.equal(result.rounds.length, 2)
  assert.equal(result.dispatched.length, 2)
  // The follow-up messages include BOTH local + remote tool_calls in the
  // assistant turn (server sees full record); only the remote gets a tool
  // result (locals are fire-and-forget).
  const secondReq = calls.filter((c) => c.url.includes("single_llm_calls"))[1].body
  assert.equal(secondReq.messages[1].tool_calls.length, 2)
  assert.equal(secondReq.messages.filter((m) => m.role === "tool").length, 1)
  assert.equal(secondReq.messages[2].name, "search_pubmed")
})

test("runChatLoop: unknown tool name → goes to skipped, doesn't loop, doesn't POST anywhere", async () => {
  const { result, calls } = await withFetch(
    [ { matches: (u) => u.includes("/single_llm_calls"),
        respond: () => sseResponse(sseWithToolCalls(
          [ { id: "c1", name: "totally_made_up", arguments: {} } ]
        )) } ],
    (mock) => runChatLoop(BASE_OPTS)
  )
  assert.equal(result.rounds.length, 1)
  assert.equal(result.dispatched.length, 0)
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].name, "totally_made_up")
  assert.equal(calls.filter((c) => c.url.includes("mcp_tools")).length, 0)
})

test("runChatLoop: remote dispatch failure is captured + fed back to LLM as an error string", async () => {
  const remoteTools = [ { id: 7, name: "flaky_tool" } ]
  let round = 0
  const { result, calls } = await withFetch(
    [
      { matches: (u) => u.includes("/single_llm_calls"),
        respond: () => {
          round++
          if (round === 1) {
            return sseResponse(sseWithToolCalls(
              [ { id: "c1", name: "flaky_tool", arguments: {} } ]
            ))
          }
          return sseResponse(sseDoneOnly("Understood — that tool failed."))
        } },
      { matches: (u) => u.includes("/mcp_tools/7/call"),
        respond: () => jsonResponse({ error: "MCP server connection failed", message: "boom" }, 502) }
    ],
    (mock) => runChatLoop({ ...BASE_OPTS, remoteTools })
  )
  assert.equal(result.rounds.length, 2)
  assert.equal(result.dispatched.length, 1)
  assert.ok(result.dispatched[0].error instanceof Error, "error captured on dispatched entry")
  // Second round DID happen — error was fed back so the LLM could react.
  const secondReq = calls.filter((c) => c.url.includes("single_llm_calls"))[1].body
  const toolMsg = secondReq.messages.find((m) => m.role === "tool")
  assert.ok(toolMsg.content.includes("error"), "tool message content mentions the error")
})

test("runChatLoop: hits maxRounds cap → returns with stopped_reason instead of hanging", async () => {
  // An LLM that never stops asking for remote tool_calls.
  const remoteTools = [ { id: 1, name: "never_enough" } ]
  const { result } = await withFetch(
    [
      { matches: (u) => u.includes("/single_llm_calls"),
        respond: () => sseResponse(sseWithToolCalls(
          [ { id: `c${Math.random()}`, name: "never_enough", arguments: {} } ]
        )) },
      { matches: (u) => u.includes("/mcp_tools/1/call"),
        respond: () => jsonResponse({ result: "here you go" }) }
    ],
    (mock) => runChatLoop({ ...BASE_OPTS, remoteTools, maxRounds: 3 })
  )
  assert.equal(result.rounds.length, 3)
  assert.match(result.stopped_reason, /max_rounds/)
})

// ===========================================================================
// Class 2 — well-known + direct MCP dispatch
// ===========================================================================

test("fetchMcpManifest: parses shape + resolves relative URLs against manifest origin", async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (url === "https://host.test/.well-known/mcp.json") {
      return new Response(JSON.stringify({
        servers: [ {
          name: "host-mcp", url: "/mcp",
          tools: [ { name: "annotate", description: "Annotate text.",
                     input_schema: { type: "object", properties: { text: { type: "string" } } } } ]
        } ]
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    throw new Error("unexpected URL " + url)
  }
  try {
    const tools = await fetchMcpManifest("https://host.test/.well-known/mcp.json")
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, "annotate")
    assert.equal(tools[0].endpoint, "https://host.test/mcp", "relative /mcp resolves to same origin")
    assert.equal(tools[0].description, "Annotate text.")
  } finally { globalThis.fetch = orig }
})

test("fetchMcpManifest: gracefully returns [] on 404 / network / parse error (no throw)", async () => {
  const orig = globalThis.fetch
  const cases = [
    async () => new Response("", { status: 404 }),
    async () => { throw new Error("network down") },
    async () => new Response("not json{", { status: 200, headers: { "Content-Type": "application/json" } })
  ]
  try {
    for (const fetchImpl of cases) {
      globalThis.fetch = fetchImpl
      const tools = await fetchMcpManifest("https://host.test/.well-known/mcp.json")
      assert.deepEqual(tools, [])
    }
  } finally { globalThis.fetch = orig }
})

test("fetchMcpManifest: accepts absolute URLs unchanged + supports inputSchema alias", async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    servers: [ {
      name: "elsewhere", url: "https://other.example/mcp",
      tools: [ { name: "search", description: "",
                 inputSchema: { type: "object" } } ]
    } ]
  }), { status: 200, headers: { "Content-Type": "application/json" } })
  try {
    const tools = await fetchMcpManifest("https://host.test/.well-known/mcp.json")
    assert.equal(tools[0].endpoint, "https://other.example/mcp")
    assert.deepEqual(tools[0].input_schema, { type: "object" })
  } finally { globalThis.fetch = orig }
})

test("callMcpTool: POSTs JSON-RPC tools/call and returns result on JSON response", async () => {
  const orig = globalThis.fetch
  let seenReq = null
  globalThis.fetch = async (url, init) => {
    seenReq = { url, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({
      jsonrpc: "2.0", id: seenReq.body.id,
      result: { content: [ { type: "text", text: "found 3 items" } ], isError: false }
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    const result = await callMcpTool({
      endpoint: "https://host.test/mcp",
      name: "annotate",
      args: { text: "the heart" }
    })
    assert.equal(seenReq.url, "https://host.test/mcp")
    assert.equal(seenReq.body.jsonrpc, "2.0")
    assert.equal(seenReq.body.method, "tools/call")
    assert.deepEqual(seenReq.body.params, { name: "annotate", arguments: { text: "the heart" } })
    assert.deepEqual(result.content, [ { type: "text", text: "found 3 items" } ])
  } finally { globalThis.fetch = orig }
})

test("callMcpTool: throws with error message when JSON-RPC returns an error", async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    jsonrpc: "2.0", id: 1,
    error: { code: -32601, message: "Method not found: tools/nope" }
  }), { status: 200, headers: { "Content-Type": "application/json" } })
  try {
    await assert.rejects(
      callMcpTool({ endpoint: "https://host.test/mcp", name: "nope", args: {} }),
      /Method not found/
    )
  } finally { globalThis.fetch = orig }
})

test("callMcpTool: throws with HTTP status when the endpoint returns non-2xx", async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response("Not Found", { status: 404 })
  try {
    await assert.rejects(
      callMcpTool({ endpoint: "https://host.test/mcp", name: "any", args: {} }),
      /HTTP 404/
    )
  } finally { globalThis.fetch = orig }
})

test("runChatLoop: dispatches Class 2 (hostWide) via direct MCP, NOT via meta-server proxy", async () => {
  const hostWideTools = [ {
    name: "text_annotation", description: "Annotate text",
    input_schema: { type: "object" },
    endpoint: "https://host.test/mcp"
  } ]
  let round = 0
  const { result, calls } = await withFetch(
    [
      { matches: (u) => u.includes("/single_llm_calls"),
        respond: () => {
          round++
          if (round === 1) {
            return sseResponse(sseWithToolCalls(
              [ { id: "c1", name: "text_annotation", arguments: { text: "the heart" } } ]
            ))
          }
          return sseResponse(sseDoneOnly("Found 3 anatomy terms."))
        } },
      { matches: (u) => u === "https://host.test/mcp",
        respond: (body) => jsonResponse({
          jsonrpc: "2.0", id: body.id,
          result: { content: [ { type: "text", text: "hit: UBERON:0000948" } ] }
        }) }
    ],
    (mock) => runChatLoop({ ...BASE_OPTS, hostWideTools })
  )

  assert.equal(result.rounds.length, 2, "two LLM rounds — request + synthesis")
  // Class 2 hit host directly, NOT via /api/mcp_tools/...
  assert.equal(calls.filter((c) => c.url === "https://host.test/mcp").length, 1)
  assert.equal(calls.filter((c) => c.url.includes("/mcp_tools/")).length, 0)
  // The wire request to the host was JSON-RPC-shaped.
  const mcpReq = calls.find((c) => c.url === "https://host.test/mcp")
  assert.equal(mcpReq.body.method, "tools/call")
  assert.deepEqual(mcpReq.body.params.arguments, { text: "the heart" })
  // Result flowed back to the LLM as a role:tool message.
  const secondReq = calls.filter((c) => c.url.includes("single_llm_calls"))[1].body
  const toolMsg = secondReq.messages.find((m) => m.role === "tool")
  assert.ok(toolMsg.content.includes("UBERON"))
})

test("runChatLoop: aiActions (Class 3) wins over hostWide (Class 2) when tool names collide", async () => {
  // Same name registered in BOTH classes; aiActions should be called, host
  // endpoint should NOT be hit.
  const aiActionCalls = []
  const aiActions = { snap: (args) => { aiActionCalls.push(args); return "local ok" } }
  const hostWideTools = [ {
    name: "snap", endpoint: "https://host.test/mcp",
    description: "", input_schema: { type: "object" }
  } ]

  const { result, calls } = await withFetch(
    [
      { matches: (u) => u.includes("/single_llm_calls"),
        respond: () => sseResponse(sseWithToolCalls(
          [ { id: "c1", name: "snap", arguments: { x: 1 } } ]
        )) },
      { matches: (u) => u === "https://host.test/mcp",
        respond: () => jsonResponse({ jsonrpc: "2.0", id: 1, result: "SHOULD NOT BE CALLED" }) }
    ],
    (mock) => runChatLoop({ ...BASE_OPTS, aiActions, hostWideTools })
  )
  assert.equal(result.rounds.length, 1, "Class 3 doesn't loop — no round-trip result")
  assert.deepEqual(aiActionCalls, [ { x: 1 } ])
  assert.equal(calls.filter((c) => c.url === "https://host.test/mcp").length, 0)
})

test("runChatLoop: hostWide (Class 2) wins over remote (Class 1) when tool names collide", async () => {
  // Class 2 is more direct (bypasses meta-server proxy). Precedence: Class 2 > Class 1.
  const hostWideTools = [ {
    name: "shared", endpoint: "https://host.test/mcp",
    description: "", input_schema: { type: "object" }
  } ]
  const remoteTools = [ { id: 99, name: "shared" } ]
  let round = 0

  const { calls } = await withFetch(
    [
      { matches: (u) => u.includes("/single_llm_calls"),
        respond: () => {
          round++
          if (round === 1) {
            return sseResponse(sseWithToolCalls(
              [ { id: "c1", name: "shared", arguments: {} } ]
            ))
          }
          return sseResponse(sseDoneOnly("Done."))
        } },
      { matches: (u) => u === "https://host.test/mcp",
        respond: (body) => jsonResponse({ jsonrpc: "2.0", id: body.id, result: "host wins" }) },
      { matches: (u) => u.includes("/mcp_tools/99/call"),
        respond: () => jsonResponse({ result: "SHOULD NOT BE CALLED" }) }
    ],
    (mock) => runChatLoop({ ...BASE_OPTS, hostWideTools, remoteTools })
  )
  assert.equal(calls.filter((c) => c.url === "https://host.test/mcp").length, 1)
  assert.equal(calls.filter((c) => c.url.includes("/mcp_tools/99/call")).length, 0)
})

test("runChatLoop: hostWide schemas are merged into local_tools sent to meta-server (so the LLM sees them)", async () => {
  const hostWideTools = [ {
    name: "annotate",
    description: "Annotate the current text",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: [ "text" ] },
    endpoint: "https://host.test/mcp"
  } ]
  const { calls } = await withFetch(
    [ { matches: (u) => u.includes("/single_llm_calls"),
        respond: () => sseResponse(sseDoneOnly("ok")) } ],
    (mock) => runChatLoop({ ...BASE_OPTS, hostWideTools })
  )
  const req = calls.find((c) => c.url.includes("single_llm_calls")).body
  const tool = (req.local_tools || []).find((t) => t.name === "annotate")
  assert.ok(tool, "hostWideTools[].name should appear in local_tools sent upstream")
  assert.equal(tool.description, "Annotate the current text")
  assert.deepEqual(tool.input_schema.required, [ "text" ])
})
