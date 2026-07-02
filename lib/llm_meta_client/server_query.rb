require "net/http"
require "uri"
require "json"

module LlmMetaClient
  class ServerQuery
    # Stream LLM responses incrementally. Yields each content delta event
    # ({ event: "message", data: { "delta" => "..." } }) and any tool_calls
    # event ({ event: "tool_calls", data: { "tool_calls" => [...] } }) to the
    # caller's block. Upstream "done" markers are absorbed (end-of-stream is
    # signaled by the block returning); upstream "error" events raise ServerError.
    # Returns the final assistant content. If tool calls fired, the returned
    # string mirrors the synchronous #call format (response + markdown
    # "Tool calls" section appended) so persistence stays consistent.
    def stream(id_token, api_key_uuid, model_id, context, user_content, tool_ids: [], generation_settings: {}, image_context: nil, image: nil, images: nil, document: nil)
      if image_context.present?
        prompt_text = user_content.is_a?(Hash) ? (user_content[:prompt] || user_content["prompt"]).to_s : user_content.to_s
        debug_log "Streaming image request to LLM: \n===>\n#{prompt_text}\n(with #{image_context.size} prior turn(s))\n===>"
        body = { prompt: prompt_text, image_context: image_context }
      else
        context_and_user_content = "Context:#{context}, User Prompt: #{user_content}"
        debug_log "Streaming request to LLM: \n===>\n#{context_and_user_content}\n===>"
        body = { prompt: context_and_user_content }
      end
      body[:tool_ids] = tool_ids if tool_ids.present?
      body[:generation_settings] = generation_settings if generation_settings.present?
      # images: ordered chronologically with the current turn's image last.
      # Legacy single `image:` is forwarded as a fallback for older callers.
      if images.present?
        body[:images] = images
      elsif image.present?
        body[:image] = image
      end
      # document: single-attachment PDF for the current turn. Server enforces
      # MIME (application/pdf) and a 10 MB cap; we just forward the payload.
      body[:document] = document if document.present?

      assembled = +""
      collected_tool_calls = []
      request_stream(api_key_uuid, id_token, model_id, body) do |event|
        case event[:event]
        when "message"
          assembled << event[:data]["delta"].to_s
          yield event if block_given?
        when "tool_calls"
          collected_tool_calls = event[:data]["tool_calls"] || []
          yield event if block_given?
        when "thinking"
          # Thinking-mode deltas (Ollama hybrid models): forwarded to the
          # caller for live rendering, but NOT folded into `assembled` —
          # only the final content is persisted as the assistant message.
          yield event if block_given?
        when "done"
          # End-of-stream marker from upstream; no-op here.
        when "error"
          raise Exceptions::ServerError, format_stream_error(event[:data])
        else
          yield event if block_given?
        end
      end

      collected_tool_calls.any? ? combine_with_tool_calls(assembled, collected_tool_calls) : assembled
    end

    def call(id_token, api_key_uuid, model_id, context, user_content, tool_ids: [], generation_settings: {}, document: nil)
      debug_log "Context: #{context}"
      context_and_user_content = "Context:#{context}, User Prompt: #{user_content}"
      debug_log "Request to LLM: \n===>\n#{context_and_user_content}\n===>"

      response = request(api_key_uuid, id_token, model_id, context_and_user_content, tool_ids, generation_settings, document: document)

      unless response.success?
        raise Exceptions::ServerError, build_error_message(response.code.to_i, response.parsed_response)
      end

      response_body = response.parsed_response

      raise Exceptions::InvalidResponseError, "LLM server returned non-JSON response" unless response_body.is_a?(Hash)

      content = response_body.dig("response", "message") || ""
      tool_calls = response_body.dig("response", "tool_calls")
      content = combine_with_tool_calls(content, tool_calls) if tool_calls.is_a?(Array) && tool_calls.any?

      raise Exceptions::EmptyResponseError, "LLM server returned empty response" if content.blank?

      debug_log "Response from LLM: \n<===\n#{content}\n<==>"

      content
    end

    private

    def debug_log(message)
      Rails.logger.info(message) if Rails.env.development?
    end

    def combine_with_tool_calls(message, tool_calls)
      tool_section = format_tool_calls(tool_calls)
      return tool_section if message.blank?
      "#{message}\n\n---\n\n#{tool_section}"
    end

    def format_tool_calls(tool_calls)
      lines = [ "**Tool calls**", "" ]
      tool_calls.each do |tc|
        name = tc["name"] || tc[:name] || "(unknown)"
        args = tc["arguments"] || tc[:arguments]
        args_str =
          case args
          when Hash, Array then args.to_json
          when nil then ""
          else args.to_s
          end
        lines << (args_str.empty? ? "- `#{name}`" : "- `#{name}` — `#{args_str}`")
      end
      lines.join("\n")
    end

    def request(api_key_uuid, id_token, model_id, user_content, tool_ids, generation_settings, document: nil)
      headers = { "Content-Type" => "application/json" }
      headers["Authorization"] = "Bearer #{id_token}" if id_token.present?

      body = { prompt: user_content.to_s }
      body[:tool_ids] = tool_ids if tool_ids.present?
      body[:generation_settings] = generation_settings if generation_settings.present?
      body[:document] = document if document.present?

      HTTParty.post(
        url(api_key_uuid, model_id),
        headers: headers,
        body: body.to_json,
        timeout: 300 # 5 minute timeout setting (both read and connect)
      )
    end

    def url(api_key_uuid, model_id)
      "#{Rails.application.config.llm_service_base_url}/api/llm_api_keys/#{api_key_uuid}/models/#{model_id}/chats"
    end

    def stream_url(api_key_uuid, model_id)
      "#{Rails.application.config.llm_service_base_url}/api/llm_api_keys/#{api_key_uuid}/models/#{model_id}/chat_streams"
    end

    def request_stream(api_key_uuid, id_token, model_id, body)
      uri = URI(stream_url(api_key_uuid, model_id))

      Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", read_timeout: 600) do |http|
        req = Net::HTTP::Post.new(uri)
        req["Content-Type"] = "application/json"
        req["Accept"] = "text/event-stream"
        req["Authorization"] = "Bearer #{id_token}" if id_token.present?
        req.body = body.to_json

        http.request(req) do |response|
          unless response.is_a?(Net::HTTPSuccess)
            body = JSON.parse(response.read_body.to_s) rescue nil
            raise Exceptions::ServerError, build_error_message(response.code.to_i, body)
          end

          buffer = +""
          response.read_body do |chunk|
            buffer << chunk.force_encoding("UTF-8")
            while (boundary = buffer.index("\n\n"))
              raw_event = buffer.slice!(0, boundary + 2)
              parsed = parse_sse_event(raw_event)
              yield parsed if parsed
            end
          end
        end
      end
    end

    # Format an `event: error` SSE payload from llm_meta_server into a
    # user-facing string. Payload shape: { "code" => "rate_limit", "message" => "..." }
    def format_stream_error(data)
      code = data["code"]
      message = data["message"]
      case code
      when "rate_limit"
        suffix = message.present? ? ": #{message}" : ""
        "Rate limit exceeded — check your provider plan or retry shortly#{suffix}"
      when "api_key_required"
        message.presence || "API key required for this model"
      else
        message.presence || "Upstream stream error"
      end
    end

    # Turn a non-success HTTP response from llm_meta_server into a user-facing
    # error string. The server returns JSON like
    #   { "error" => "LLM API Rate limit exceeded", "message" => "Too many requests" }
    # for known error classes; fall back to a generic message otherwise.
    def build_error_message(status_code, body)
      if body.is_a?(Hash)
        err = body["error"]
        msg = body["message"]
        return "Your sign-in expired. Please sign in again." if err.to_s.match?(/token has expired/i)
        return "#{err}: #{msg}" if err.present? && msg.present?
        return err if err.present?
        return msg if msg.present?
      end
      case status_code
      when 429 then "Rate limit exceeded — check your provider plan or retry shortly (HTTP 429)"
      when 401, 403 then "LLM service rejected the request (HTTP #{status_code}) — check your API key"
      when 502, 503, 504 then "LLM service is unavailable (HTTP #{status_code})"
      else "LLM server returned HTTP #{status_code}"
      end
    end

    def parse_sse_event(raw)
      event_name = "message"
      data_lines = []
      raw.each_line(chomp: true) do |line|
        next if line.empty?
        if line.start_with?("event:")
          event_name = line.sub(/^event:\s*/, "")
        elsif line.start_with?("data:")
          data_lines << line.sub(/^data:\s*/, "")
        end
      end
      return nil if data_lines.empty?

      data = JSON.parse(data_lines.join("\n"))
      { event: event_name, data: data }
    rescue JSON::ParserError
      nil
    end
  end
end
