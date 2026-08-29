import consumer from "channels/consumer"

// Global object to manage chat channel subscriptions
window.chatSubscription = null

function subscribeToChatChannel(chatId) {
  // Unsubscribe from existing subscription if any
  if (window.chatSubscription) {
    window.chatSubscription.unsubscribe()
  }

  if (!chatId) {
    return
  }

  window.chatSubscription = consumer.subscriptions.create(
    { channel: "ChatChannel", chat_id: chatId },
    {
      connected() {
        console.log("Connected to ChatChannel:", chatId)
      },

      disconnected() {
        console.log("Disconnected from ChatChannel")
      },

      received(data) {
        console.log("Received data from ChatChannel:", data)

        if (data.action === "new_message") {
          // Update message list
          const messagesList = document.getElementById("messages-list")
          if (messagesList && data.html) {
            messagesList.innerHTML = data.html

            // Scroll to bottom of messages
            const chatMessages = document.getElementById("chat-messages")
            if (chatMessages) {
              chatMessages.scrollTop = chatMessages.scrollHeight
            }
          }
        }
      }
    }
  )
}

// Expose globally
window.subscribeToChatChannel = subscribeToChatChannel

// Check chat ID and connect
function checkAndSubscribe() {
  const chatContainer = document.querySelector(".chat-container")
  if (chatContainer) {
    const chatId = chatContainer.dataset.chatId
    if (chatId) {
      subscribeToChatChannel(chatId)
    }
  }
}

// Connect on page load if chat ID exists
document.addEventListener("DOMContentLoaded", checkAndSubscribe)

// Support Turbo visits
document.addEventListener("turbo:load", checkAndSubscribe)

// Check after Turbo Streams update the screen
document.addEventListener("turbo:frame-load", checkAndSubscribe)

// Monitor data-chat-id changes using MutationObserver
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.type === "attributes" && mutation.attributeName === "data-chat-id") {
      checkAndSubscribe()
    }
  })
})

// Set up observer after DOMContentLoaded
document.addEventListener("DOMContentLoaded", () => {
  const chatContainer = document.querySelector(".chat-container")
  if (chatContainer) {
    observer.observe(chatContainer, {
      attributes: true,
      attributeFilter: ["data-chat-id"]
    })
  }
})



