# frozen_string_literal: true

module LlmMetaClient
  module Generators
    class ScaffoldGenerator < Rails::Generators::Base
      include Rails::Generators::Migration

      source_root File.expand_path("templates", __dir__)

      def self.next_migration_number(dirname)
        next_migration_number = current_migration_number(dirname) + 1
        ActiveRecord::Migration.next_migration_number(next_migration_number)
      end

      def create_models
        template "app/models/chat.rb"
        template "app/models/message.rb"
      end

      def create_controllers
        template "app/controllers/chats_controller.rb"
        template "app/controllers/chat_streams_controller.rb"
        template "app/controllers/prompts_controller.rb"
        template "app/controllers/api/mcp_servers_controller.rb"
      end

      def create_views
        template "app/views/chats/new.html.erb"
        template "app/views/chats/edit.html.erb"
        template "app/views/chats/create.turbo_stream.erb"
        template "app/views/chats/update.turbo_stream.erb"
        template "app/views/chats/destroy.turbo_stream.erb"
        template "app/views/chats/_message.html.erb"
        template "app/views/chats/_streaming_message.html.erb"
        template "app/views/chats/_tool_call_message.html.erb"
        template "app/views/chats/_chat_sidebar.html.erb"
        template "app/views/chats/_messages_list.html.erb"
        template "app/views/shared/_quick_picks.html.erb"
        template "app/views/shared/_model_grid.html.erb"
        template "app/views/shared/_tool_selector_field.html.erb"
        template "app/views/shared/_generation_settings_field.html.erb"
        template "app/views/layouts/application.html.erb"
        template "app/views/layouts/_header.html.erb"
        template "app/views/layouts/_new_chat_button.html.erb"
        template "app/views/layouts/_sidebar.html.erb"
      end

      def create_javascript
        template "app/javascript/controllers/model_picker_controller.js"
        template "app/javascript/controllers/llm_toggle_controller.js"
        template "app/javascript/controllers/chats_form_controller.js"
        template "app/javascript/controllers/chat_title_edit_controller.js"
        template "app/javascript/controllers/tool_selector_controller.js"
        template "app/javascript/controllers/generation_settings_controller.js"
        template "app/javascript/controllers/message_stream_controller.js"
        copy_file "app/javascript/popover.js"
      end

      def create_initializer
        template "config/initializers/llm_service.rb"
      end

      def add_migrations
        migration_template "db/migrate/create_chats.rb", "db/migrate/create_chats.rb"
        migration_template "db/migrate/create_messages.rb", "db/migrate/create_messages.rb"
        migration_template "db/migrate/migrate_llm_uuid_to_prompt_executions.rb", "db/migrate/migrate_llm_uuid_to_prompt_executions.rb"
      end

      def configure_routes
        route <<-RUBY
          root "chats#new"

          resources :chats, only: [ :new, :create, :show, :destroy ] do
            collection do
              delete :clear
              post :start_new
              delete :batch_destroy
              post :download_selected_csv
            end
            member do
              patch :update_title
              get :download_csv
              post :add_prompt
            end
            resource :stream, only: [ :show ], controller: "chat_streams"
          end
          resources :prompts, only: [ :show, :destroy ]

          namespace :api do
            resources :mcp_servers, only: [ :index ], param: :uuid do
              get :tools, on: :member
            end
          end
        RUBY
      end

      def configure_importmap
        append_to_file "config/importmap.rb", <<~RUBY
          pin "controllers/history_controller", to: "controllers/history_controller.js"
          pin "popover", to: "popover.js"
        RUBY
      end

      def inject_helpers
        inject_into_class "app/controllers/application_controller.rb", "ApplicationController", "  include LlmMetaClient::Helpers\n"
        inject_into_module "app/helpers/application_helper.rb", "ApplicationHelper", "  include LlmMetaClient::Helpers\n"
      end

      def configure_asset_paths
        inject_into_class "config/application.rb", "Application", <<-RUBY
    # Add asset paths for prompt_navigator gem
    config.assets.paths << Rails.root.join("../prompt_navigator/app/assets/stylesheets")
    # Add asset paths for chat_manager gem
    config.assets.paths << Rails.root.join("../chat_manager/app/assets/stylesheets")
        RUBY
      end
    end
  end
end
