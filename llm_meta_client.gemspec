require_relative "lib/llm_meta_client/version"

Gem::Specification.new do |spec|
  spec.name        = "llm_meta_client"
  spec.version     = LlmMetaClient::VERSION
  spec.authors     = [ "dhq_boiler" ]
  spec.email       = [ "dhq_boiler@live.jp" ]
  spec.homepage    = "https://github.com/dhq-boiler/llm_meta_client"
  spec.summary     = "A Rails Engine for integrating multiple LLM providers into your application."
  spec.description = "llm_meta_client provides a Rails Engine with scaffold and authentication generators for building LLM-powered chat applications. Supports OpenAI, Anthropic, Google, and Ollama providers."
  spec.license     = "Apache-2.0"

  spec.required_ruby_version = ">= 3.4"

  spec.metadata["allowed_push_host"] = "https://rubygems.org"
  spec.metadata["homepage_uri"] = spec.homepage
  spec.metadata["source_code_uri"] = "https://github.com/dhq-boiler/llm_meta_client/tree/main"
  spec.metadata["changelog_uri"] = "https://github.com/dhq-boiler/llm_meta_client/blob/main/CHANGELOG.md"

  spec.files = Dir.chdir(File.expand_path(__dir__)) do
    Dir["{app,config,db,lib}/**/*", "LICENSE", "Rakefile", "README.md", "CHANGELOG.md"]
  end

  spec.add_dependency "rails", "~> 8.1", ">= 8.1.1"
  spec.add_dependency "httparty", "~> 0.22"
  spec.add_dependency "prompt_navigator", ">= 1.0", "< 3.0"
  spec.add_dependency "chat_manager", "~> 1.0"
end
