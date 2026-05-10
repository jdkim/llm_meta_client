# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-05-10

### Added

- Tool-call streaming end-to-end. `ServerQuery#stream` now accepts `tool_ids:` and yields a `tool_calls` event when the LLM decides to invoke MCP tools. Turn 1 (tool selection) runs synchronously; turn 2 (the follow-up after tool execution) is streamed.
- Scaffold renders a separate "🛠 Tool calls" bubble during streaming via the new `_tool_call_message.html.erb` partial. The Stimulus controller inserts it before the streaming bubble when `event: tool_calls` arrives, and removes it once the assistant message is saved (the saved bubble's combined markdown contains the tool-call section).
- `Chat#stream_assistant_response` accepts `tool_ids:` and threads them through. Persistence is unchanged — the saved `Message.response` includes a markdown "Tool calls" section appended to the response text, matching the existing synchronous shape.
- When `tool_ids` is non-empty, the system prompt is augmented with an instruction to explain tool errors rather than fail silently. Models that ignore the instruction are caught by a server-side fallback (see below).

### Changed

- Streaming error messages now parse `error` + `message` from the response body so users see context (e.g. "Rate limit exceeded — check your provider plan…") instead of a bare HTTP code. Mid-stream `event: error` payloads with codes like `rate_limit` get the same friendlier treatment.

### Notes

- Requires `llm_meta_server` with the matching tool-streaming additions: `LlmRbFacade.stream!` accepting `tools:` + `on_tool_calls:` and an `Api::ChatStreamsController` that emits the `tool_calls` SSE event. Server-side fixes that ship alongside this release: an Anthropic-tool-only-response rehydrator (Claude tool-only completions weren't surfacing through `Session#functions`), and a sink injection that emits MCP `isError: true` payloads as text deltas before turn 2 (Gemini sometimes returns nothing after a tool error and would otherwise leave the bubble blank).

## [1.2.0] - 2026-05-10

### Added

- End-to-end SSE streaming for chat completions:
  - `ServerQuery#stream` consumes SSE from the new `chat_streams` endpoint on `llm_meta_server` and yields parsed events. Returns the assembled content; absorbs upstream `done` markers and raises `ServerError` on upstream `error` events.
  - `Chat#stream_assistant_response` and `Chat#finalize_streamed_response` for streaming generation with persistence at stream close (assistant message saved only on success — disconnects mid-stream don't persist).
  - Scaffold now generates `ChatStreamsController`, `_streaming_message.html.erb` partial, `message_stream_controller.js` Stimulus controller, and a shared `_chat_sidebar.html.erb` partial. Routes add `resource :stream` nested under `chats`.
  - Streaming bubble swaps to the host-rendered `_message` partial on save, so any markdown / syntax-highlighting customization in the host's `_message.html.erb` applies post-stream.
  - `event: title` SSE event includes a turbo_stream snippet that updates the chat-sidebar in place when a brand-new chat gets its auto-generated title.

### Changed

- `ServerQuery` error messages parse the JSON response body from `llm_meta_server` and surface friendlier text (rate limits, auth errors, upstream unavailable) instead of bare `HTTP <code>`.
- Streaming endpoint v1 does not pass `tool_ids`. The synchronous `#call` path is unchanged and still supports tool calls.

### Notes

- The streaming endpoint requires `llm_meta_server` with the matching `chat_streams` route. SSE delivery through reverse proxies needs `proxy_buffering off` (nginx) or `flushpackets=on` + `SetEnv no-gzip 1` (Apache).

## [1.1.1] - 2026-04-22

### Added

- `ServerQuery#call` now surfaces tool calls from the LLM server response. When the response includes a `tool_calls` array, a markdown-formatted "Tool calls" section (name + JSON args) is appended to the returned content (separated by a horizontal rule). This lets host apps display which tools the LLM invoked without any schema or view changes; existing markdown renderers pick it up automatically. Previously, tool calls were silently dropped.

## [1.1.0] - 2026-04-22

### Changed

- Widen `prompt_navigator` dependency constraint from `~> 1.0` to `>= 1.0, < 3.0` so host apps can opt into `prompt_navigator` 2.0 (which requires Ruby 3.4.9+ and adds `PromptExecution.delete_set!`). Existing hosts on `prompt_navigator` 1.x keep resolving unchanged.

## [1.0.2] - 2026-03-27

### Added

- Add client-side validation for Generation Settings JSON

## [1.0.1] - 2026-03-25

### Fixed

- Fix: normalize Ollama llm_type in server resource options
- Fix: update branch_from_uuid after LLM response

### Changed

- Refactor: move llm_uuid and model from Chat to PromptExecution

## [1.0.0] - 2026-03-25

### Changed

- Replace generation settings UI from individual sliders to JSON textarea input
- Improve prompt execution branching logic to use `execution_id` instead of message UUID
- Use `find_by!` for proper 404 handling in controllers
- Use URL-based chat lookup in `chats#update` instead of session-based lookup
- Keep existing chat when switching model or LLM (update instead of creating new chat)
- Upgrade `prompt_navigator` dependency to `~> 1.0`
- Upgrade `chat_manager` dependency to `~> 1.0`

### Fixed

- Fix Turbo Stream history sidebar element ID mismatch (`history-content` → `history-sidebar`)
- Fix `next_ann` for proper history card rendering
- Wrap inline JavaScript in IIFE to prevent variable conflicts across Turbo Stream updates
- Fix scroll event listener duplication across Turbo navigations
- Validate generation settings JSON input before sending to LLM

## [0.6.1] - 2026-03-19

### Fixed

- Fix remaining `prompt_manager_prompt_execution` reference in chat model template (renamed to `prompt_navigator_prompt_execution`)

## [0.6.0] - 2026-03-18

### Changed

- Rename `prompt_manager` references to `prompt_navigator` across all scaffold templates (models, controllers, views, migrations, generator config)
- Refactor chat template to use `PromptExecution#build_context` instead of manual message iteration
- Update `prompt_navigator` gem to 0.3.0

## [0.5.0] - 2026-03-17

### Added

- Generation settings support:
  - `generation_settings` parameter in `ServerQuery` API layer for configuring LLM generation parameters
  - `generation_settings` threading through `Chat` model
  - `generation_settings` parameter extraction in `ChatsController`
  - Generation settings UI components for configuring parameters in chat forms

## [0.4.0] - 2026-03-11

### Added

- MCP (Model Context Protocol) tool selection support:
  - `ServerResource.fetch_mcp_servers` and `ServerResource.fetch_mcp_tools` for retrieving MCP server/tool data from the LLM service
  - `Api::McpServersController` with `index` and `tools` endpoints
  - API routes for MCP servers (`/api/mcp_servers` and `/api/mcp_servers/:uuid/tools`)
  - `tool_ids` parameter support through `ServerQuery`, `Chat` model, and `ChatsController`
  - Tool selector UI component (Stimulus controller + view partial) for selecting MCP tools in chat forms

### Changed

- Extracted `authenticated_get` helper in `ServerResource` to reduce duplication in authenticated API calls

### Security

- Escape HTML attribute values (`server.uuid`, `tool.id`) in tool selector to prevent XSS
- Use `CSS.escape()` for `querySelector` and `encodeURIComponent()` for fetch URLs to prevent selector/URL injection

## [0.3.0] - 2026-03-05

### Changed

- Update Ruby version requirement from 3.4.8 to 4.0.1
- Update gem dependencies to latest versions

## [0.2.0] - 2026-03-04

### Changed

- Switch configuration to use Rails credentials instead of environment variables

### Documentation

- Update README with architectural details, setup instructions, and Rails credentials usage

## [0.1.0] - 2026-02-27

### Added

- Rails Engine with core modules:
  - `ServerQuery` for making HTTP requests to LLM services
  - `ServerResource` for fetching available LLM options (OpenAI, Anthropic, Google, Ollama)
  - `Helpers` module integrating PromptNavigator and ChatManager helpers
  - `ChatManageable` and `HistoryManageable` concerns
  - Custom exceptions (`OllamaUnavailableError`, `ServerError`, `InvalidResponseError`, `EmptyResponseError`)
- Scaffold generator (`rails generate llm_meta_client:scaffold`):
  - Chat and Message models with migrations
  - ChatsController and PromptsController
  - Chat views with Turbo Stream support
  - Stimulus JavaScript controllers (llm_selector, chats_form, chat_title_edit)
  - LLM service initializer with configurable environment variables
  - Routes and importmap configuration
- Authentication generator (`rails generate llm_meta_client:authentication`):
  - User model with Devise and OmniAuth integration
  - Google OAuth2 sign-in support
  - OmniAuth callbacks and sessions controllers
  - Devise initializer and locale files
