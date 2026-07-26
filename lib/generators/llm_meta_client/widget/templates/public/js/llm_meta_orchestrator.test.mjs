// Node built-in test runner (v18+). Run:
//   node --test lib/generators/llm_meta_client/scaffold/templates/app/javascript/llm_meta_orchestrator.test.mjs
//
// Tests focus on the SSE parser — the piece most likely to have edge-case
// bugs (chunk boundaries, missing trailing newline, CRLF frames, event-less
// data frames). Integration with fetch() is covered manually via the demo
// page in the chat host.

import { test } from "node:test"
import assert from "node:assert/strict"

import { parseSseStream, dispatchLocalToolCalls, runChatLoop } from "./llm_meta_orchestrator.js"

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
