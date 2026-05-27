module LlmMetaClient
  module Helpers
    include PromptNavigator::Helpers
    include ChatManager::Helpers

    # Pull a leading `![](data:mime;base64,DATA)` image off a user prompt
    # so it can be rendered as a plain <img> while the remaining text stays
    # plain. Returns [img_html_safe_or_nil, remaining_text]. Emits the tag
    # directly (no markdown helper required) so this works in any host.
    ATTACHED_IMAGE_HEAD = /\A!\[[^\]]*\]\(data:([^;]+);base64,([^\)]+)\)\s*\n*/m

    def split_attached_image_html(text)
      s = text.to_s
      m = s.match(ATTACHED_IMAGE_HEAD)
      return [ nil, s ] unless m
      img = tag.img(
        src: "data:#{m[1]};base64,#{m[2]}",
        alt: "",
        class: "user-attached-image"
      )
      [ img, s.sub(ATTACHED_IMAGE_HEAD, "") ]
    end
  end
end
