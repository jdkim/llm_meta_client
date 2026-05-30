require "test_helper"

# Tests for the REST helper that backs the UI's LLM / API-key / MCP-tool
# pickers. WebMock stubs only the upstream meta-server.
class LlmMetaClient::ServerResourceTest < ActiveSupport::TestCase
  BASE = "https://meta-server.invalid"
  TOKEN = "id-token"

  setup do
    # Quiet down expected error logs.
    @stderr_logger = ActiveSupport::Logger.new(StringIO.new)
    @original_logger = Rails.logger
    Rails.logger = @stderr_logger
  end

  teardown do
    Rails.logger = @original_logger
  end

  # ----- /api/llms responses (used by every flow) -----

  # Minimal LLM catalog reply. `family` is what the resource filters on for
  # Ollama; the other fields mirror real /api/llms output.
  def llms_body(families: %w[ollama])
    body = families.map do |family|
      {
        "family" => family,
        "uuid" => family == "ollama" ? "ollama-local" : "uuid-#{family}",
        "description" => "[#{family.capitalize}]",
        "llm_type" => family,
        "available_models" => [ { "value" => "m1", "label" => "M1" } ]
      }
    end
    { "llms" => body }.to_json
  end

  def llm_api_keys_body(types: %w[openai])
    keys = types.each_with_index.map do |t, i|
      {
        "uuid" => "key-#{t}-#{i}",
        "description" => "[#{t.capitalize}] personal",
        "llm_type" => t,
        "available_models" => [ { "value" => "x", "label" => "X" } ]
      }
    end
    { "llm_api_keys" => keys }.to_json
  end

  # ----- available_llm_options -----

  test "available_llm_options for a guest returns only Ollama in normalized shape" do
    stub_request(:get, "#{BASE}/api/llms").to_return(
      status: 200, body: llms_body(families: %w[ollama openai]),
      headers: { "Content-Type" => "application/json" }
    )

    options = LlmMetaClient::ServerResource.available_llm_options(nil)

    assert_equal 1, options.size
    o = options.first
    assert_equal "ollama", o[:llm_type]
    assert_includes o.keys, :uuid
    assert_includes o.keys, :description
    assert_includes o.keys, :available_models
    # Ensure the format helper stripped extra keys.
    refute_includes o.keys, :family
  end

  test "available_llm_options for a guest raises OllamaUnavailableError when /api/llms has no ollama" do
    stub_request(:get, "#{BASE}/api/llms").to_return(
      status: 200, body: llms_body(families: %w[openai]),
      headers: { "Content-Type" => "application/json" }
    )

    assert_raises(LlmMetaClient::Exceptions::OllamaUnavailableError) do
      LlmMetaClient::ServerResource.available_llm_options(nil)
    end
  end

  test "available_llm_options for an authed user returns API keys plus Ollama" do
    stub_request(:get, "#{BASE}/api/llms").to_return(
      status: 200, body: llms_body(families: %w[ollama]),
      headers: { "Content-Type" => "application/json" }
    )
    stub_request(:get, "#{BASE}/api/llm_api_keys")
      .with(headers: { "Authorization" => "Bearer #{TOKEN}" })
      .to_return(status: 200, body: llm_api_keys_body(types: %w[openai anthropic]),
                 headers: { "Content-Type" => "application/json" })

    options = LlmMetaClient::ServerResource.available_llm_options(TOKEN)
    types = options.map { |o| o[:llm_type] }

    assert_equal %w[openai anthropic ollama], types
  end

  test "available_llm_options silently drops Ollama when unavailable but keys are present" do
    stub_request(:get, "#{BASE}/api/llms").to_return(
      status: 200, body: llms_body(families: %w[openai]),  # no ollama
      headers: { "Content-Type" => "application/json" }
    )
    stub_request(:get, "#{BASE}/api/llm_api_keys")
      .to_return(status: 200, body: llm_api_keys_body(types: %w[openai]),
                 headers: { "Content-Type" => "application/json" })

    options = LlmMetaClient::ServerResource.available_llm_options(TOKEN)

    # Only the API key remains; the OllamaUnavailableError is swallowed
    # because the user still has at least one provider.
    assert_equal %w[openai], options.map { |o| o[:llm_type] }
  end

  test "available_llm_options re-raises OllamaUnavailableError when no keys are bound" do
    stub_request(:get, "#{BASE}/api/llms").to_return(
      status: 200, body: llms_body(families: %w[openai]),
      headers: { "Content-Type" => "application/json" }
    )
    stub_request(:get, "#{BASE}/api/llm_api_keys")
      .to_return(status: 200, body: { llm_api_keys: [] }.to_json,
                 headers: { "Content-Type" => "application/json" })

    assert_raises(LlmMetaClient::Exceptions::OllamaUnavailableError) do
      LlmMetaClient::ServerResource.available_llm_options(TOKEN)
    end
  end

  # ----- available_llm_families -----

  test "available_llm_families for a guest returns only the Ollama family" do
    stub_request(:get, "#{BASE}/api/llms").to_return(
      status: 200, body: llms_body(families: %w[ollama]),
      headers: { "Content-Type" => "application/json" }
    )

    families = LlmMetaClient::ServerResource.available_llm_families(nil)

    assert_equal 1, families.size
    assert_equal "Ollama", families.first[:name]
    assert_equal "ollama", families.first[:llm_type]
    assert families.first[:api_keys].is_a?(Array)
  end

  test "available_llm_families groups authed keys by llm_type with friendly display names + Ollama appended" do
    stub_request(:get, "#{BASE}/api/llms").to_return(
      status: 200, body: llms_body(families: %w[ollama]),
      headers: { "Content-Type" => "application/json" }
    )
    stub_request(:get, "#{BASE}/api/llm_api_keys")
      .to_return(status: 200,
                 body: { llm_api_keys: [
                   { "uuid" => "u1", "description" => "k1", "llm_type" => "openai", "available_models" => [] },
                   { "uuid" => "u2", "description" => "k2", "llm_type" => "openai", "available_models" => [] },
                   { "uuid" => "u3", "description" => "k3", "llm_type" => "anthropic", "available_models" => [] }
                 ] }.to_json,
                 headers: { "Content-Type" => "application/json" })

    families = LlmMetaClient::ServerResource.available_llm_families(TOKEN)
    by_type = families.index_by { |f| f[:llm_type] }

    assert_equal "OpenAI", by_type["openai"][:name]
    assert_equal 2, by_type["openai"][:api_keys].size
    assert_equal "Anthropic", by_type["anthropic"][:name]
    assert_equal 1, by_type["anthropic"][:api_keys].size
    assert_equal "Ollama", by_type["ollama"][:name]
  end

  test "available_llm_families falls back to capitalize for an unknown llm_type" do
    stub_request(:get, "#{BASE}/api/llms").to_return(
      status: 200, body: llms_body(families: %w[ollama]),
      headers: { "Content-Type" => "application/json" }
    )
    stub_request(:get, "#{BASE}/api/llm_api_keys").to_return(
      status: 200,
      body: { llm_api_keys: [
        { "uuid" => "u", "description" => "k", "llm_type" => "futureprovider", "available_models" => [] }
      ] }.to_json,
      headers: { "Content-Type" => "application/json" }
    )

    families = LlmMetaClient::ServerResource.available_llm_families(TOKEN)
    fp = families.find { |f| f[:llm_type] == "futureprovider" }
    assert_equal "Futureprovider", fp[:name]
  end

  # ----- fetch_mcp_servers -----

  test "fetch_mcp_servers returns [] for a guest without hitting the network" do
    assert_equal [], LlmMetaClient::ServerResource.fetch_mcp_servers(nil)
    assert_not_requested(:get, /#{BASE}/)
  end

  test "fetch_mcp_servers returns the mcp_servers array on success" do
    stub_request(:get, "#{BASE}/api/mcp_servers")
      .with(headers: { "Authorization" => "Bearer #{TOKEN}" })
      .to_return(status: 200,
                 body: { mcp_servers: [ { "uuid" => "s1", "name" => "alpha" } ] }.to_json,
                 headers: { "Content-Type" => "application/json" })

    result = LlmMetaClient::ServerResource.fetch_mcp_servers(TOKEN)
    assert_equal 1, result.size
    assert_equal "alpha", result.first["name"]
  end

  test "fetch_mcp_servers returns [] on non-success without raising" do
    stub_request(:get, "#{BASE}/api/mcp_servers").to_return(status: 500)

    assert_equal [], LlmMetaClient::ServerResource.fetch_mcp_servers(TOKEN)
  end

  test "fetch_mcp_servers swallows network errors and returns []" do
    stub_request(:get, "#{BASE}/api/mcp_servers").to_raise(SocketError.new("no DNS"))

    assert_equal [], LlmMetaClient::ServerResource.fetch_mcp_servers(TOKEN)
  end

  # ----- fetch_mcp_tools -----

  test "fetch_mcp_tools returns [] for a blank token or blank uuid (no network)" do
    assert_equal [], LlmMetaClient::ServerResource.fetch_mcp_tools(nil, "uuid")
    assert_equal [], LlmMetaClient::ServerResource.fetch_mcp_tools(TOKEN, "")
    assert_not_requested(:get, /#{BASE}/)
  end

  test "fetch_mcp_tools returns the tools array on success" do
    stub_request(:get, "#{BASE}/api/mcp_servers/srv-uuid/tools")
      .with(headers: { "Authorization" => "Bearer #{TOKEN}" })
      .to_return(status: 200,
                 body: { tools: [ { "name" => "t1" }, { "name" => "t2" } ] }.to_json,
                 headers: { "Content-Type" => "application/json" })

    result = LlmMetaClient::ServerResource.fetch_mcp_tools(TOKEN, "srv-uuid")
    assert_equal %w[t1 t2], result.map { |t| t["name"] }
  end

  test "fetch_mcp_tools returns [] on non-success" do
    stub_request(:get, "#{BASE}/api/mcp_servers/srv-uuid/tools").to_return(status: 502)

    assert_equal [], LlmMetaClient::ServerResource.fetch_mcp_tools(TOKEN, "srv-uuid")
  end

  test "fetch_mcp_tools swallows network errors" do
    stub_request(:get, "#{BASE}/api/mcp_servers/srv-uuid/tools").to_raise(Errno::ECONNREFUSED)

    assert_equal [], LlmMetaClient::ServerResource.fetch_mcp_tools(TOKEN, "srv-uuid")
  end
end
