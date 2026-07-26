// Node built-in test runner (v18+). Run:
//   node --test lib/generators/llm_meta_client/scaffold/templates/app/javascript/llm_meta_orchestrator.test.mjs
//
// Tests focus on the SSE parser — the piece most likely to have edge-case
// bugs (chunk boundaries, missing trailing newline, CRLF frames, event-less
// data frames). Integration with fetch() is covered manually via the demo
// page in the chat host.

import { test } from "node:test"
import assert from "node:assert/strict"

import { parseSseStream, dispatchLocalToolCalls } from "./llm_meta_orchestrator.js"

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
