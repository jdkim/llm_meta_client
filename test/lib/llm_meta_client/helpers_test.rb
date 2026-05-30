require "test_helper"

# Tests for the view-side helper that pulls a leading base64 data-URI
# image off a stored user prompt so it can be rendered as a plain <img>
# without going through a markdown processor (some hosts don't have one).
#
# Real concern: if this regex regresses, the chat UI shows the literal
# base64 string in place of the image on chat reload — that was the
# original bug the helper was added to fix.
class LlmMetaClient::HelpersTest < ActionView::TestCase
  include LlmMetaClient::Helpers

  test "returns [nil, text] when the input contains no leading image" do
    img, rest = split_attached_image_html("just a plain prompt")
    assert_nil img
    assert_equal "just a plain prompt", rest
  end

  test "extracts a leading image and returns the empty rest when nothing follows" do
    img, rest = split_attached_image_html("![](data:image/png;base64,AAA)")
    assert_match(/\A<img/, img)
    assert_includes img, 'src="data:image/png;base64,AAA"'
    assert_includes img, 'class="user-attached-image"'
    assert_includes img, 'alt=""'
    assert_equal "", rest
  end

  test "extracts the image and leaves the trailing prompt text intact" do
    img, rest = split_attached_image_html("![](data:image/png;base64,XYZ)describe this")
    assert_match(/\A<img/, img)
    assert_equal "describe this", rest
  end

  test "consumes whitespace and newlines between the image and the trailing text" do
    input = "![](data:image/png;base64,XYZ)\n\nwhat is in the image?"
    _img, rest = split_attached_image_html(input)
    assert_equal "what is in the image?", rest
  end

  test "preserves the original mime type in the rebuilt <img src>" do
    %w[image/png image/jpeg image/webp image/gif].each do |mime|
      img, _rest = split_attached_image_html("![](data:#{mime};base64,Q)")
      assert_includes img, "src=\"data:#{mime};base64,Q\"", "mime #{mime} not preserved"
    end
  end

  test "does NOT extract an image that isn't at the very start (regex is anchored to \\A)" do
    input = "prefix ![](data:image/png;base64,AAA)"
    img, rest = split_attached_image_html(input)
    assert_nil img
    assert_equal input, rest
  end

  test "only extracts the first image when two are stacked back-to-back" do
    input = "![](data:image/png;base64,AAA)![](data:image/jpeg;base64,BBB)"
    img, rest = split_attached_image_html(input)
    assert_includes img, "data:image/png;base64,AAA"
    # The second image remains in the trailing text so a downstream
    # markdown renderer can process it normally.
    assert_equal "![](data:image/jpeg;base64,BBB)", rest
  end

  test "tolerates alt text inside the markdown brackets" do
    img, rest = split_attached_image_html("![user upload](data:image/png;base64,AAA)caption")
    assert_match(/\A<img/, img)
    assert_includes img, "data:image/png;base64,AAA"
    assert_equal "caption", rest
  end

  test "returns [nil, ''] for blank and nil inputs without raising" do
    assert_equal [ nil, "" ], split_attached_image_html("")
    assert_equal [ nil, "" ], split_attached_image_html(nil)
  end
end
