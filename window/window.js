// Renderer process UI logic for Nono-Terminal
let command_history = [];
let history_index = -1;
let temp_input_text = "";
let current_cwd = "";
let active_editor_file_path = null;
let workspace_root = "";
let active_suggestions = [];
let open_command_cache = null;
let jar = null;

const slash_commands = [
  { name: "/clear", description: "Clear terminal screen history" },
  { name: "/code", description: "Open file in VS Code" },
  { name: "/exit", description: "Close current window" },
  { name: "/help", description: "Show list of available commands" },
  {
    name: "/mobile",
    description: "Share the current terminal UI with a mobile device via QR code",
  },
  { name: "/open", description: "Open a file in the inline editor" },
  {
    name: "/shortcuts",
    description: "List available keyboard shortcuts with descriptions",
  },
  {
    name: "/test-md",
    description:
      "Simulate AI responding with markdown-debug-example.md content to test/debug markdown styling",
  },
];

let selected_suggestion_index = 0;
let current_collapse_mode = "full"; // 'full', 'collapsed', 'last', 'user'

let active_output_block = null;
let active_assistant_block = null;
let active_assistant_text = "";
let active_thinking_details = null;
let active_thinking_content = null;
let active_message_content = null;

let available_commands = new Set();

// Heuristic to detect if input represents a shell command vs AI prompt
function isShellCommand(text) {
  if (text.includes("\n")) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) return true;

  const first_word = trimmed.split(/\s+/)[0];

  if (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~/")
  ) {
    return true;
  }

  if (available_commands.has(first_word)) {
    return true;
  }

  if (/[\x7C><&=;]/.test(trimmed)) {
    return true;
  }

  return false;
}

// Set caret position to end of contenteditable
function placeCaretAtEnd(el) {
  el.focus();
  if (
    typeof window.getSelection !== "undefined" &&
    typeof document.createRange !== "undefined"
  ) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// Cycle output collapse mode
function cycleCollapseMode() {
  const container = document.getElementById("terminal-chat-container");
  if (current_collapse_mode === "full") {
    current_collapse_mode = "collapsed";
    container.className = "mode-collapsed";
  } else if (current_collapse_mode === "collapsed") {
    current_collapse_mode = "last";
    container.className = "mode-last";
  } else if (current_collapse_mode === "last") {
    current_collapse_mode = "user";
    container.className = "mode-user";
  } else {
    current_collapse_mode = "full";
    container.className = "mode-full";
  }
}

// Filter and render slash command suggestions
function getFilteredSuggestions(query) {
  const matches = slash_commands.filter((cmd) => cmd.name.startsWith(query));
  // Store in active_suggestions so keydown navigation matches
  active_suggestions = matches;
  return matches;
}

function renderSuggestions(filtered) {
  active_suggestions = filtered;
  const suggestions_elem = document.getElementById("slash-suggestions");
  if (!suggestions_elem) return;

  if (filtered.length === 0) {
    suggestions_elem.style.display = "none";
    return;
  }

  suggestions_elem.innerHTML = "";
  filtered.forEach((cmd, idx) => {
    const item = document.createElement("div");
    item.className =
      "slash-suggestion-item" +
      (idx === selected_suggestion_index ? " active" : "");
    if (cmd.isDir) {
      item.setAttribute("data-is-dir", "true");
    }
    item.innerHTML = `
      <span class="slash-suggestion-name">${cmd.name}</span>
      <span class="slash-suggestion-desc">${cmd.description}</span>
    `;
    item.addEventListener("click", () => {
      const input = document.getElementById("active-input");
      const isCommand = cmd.name.startsWith("/");
      input.textContent = isCommand
        ? cmd.name + " "
        : "/open " + cmd.name + (cmd.isDir ? "/" : " ");
      placeCaretAtEnd(input);
      hideSuggestions();
      input.dispatchEvent(new Event("input"));
    });
    suggestions_elem.appendChild(item);
  });

  suggestions_elem.style.display = "flex";
}

function hideSuggestions() {
  const suggestions_elem = document.getElementById("slash-suggestions");
  if (suggestions_elem) {
    suggestions_elem.style.display = "none";
  }
  selected_suggestion_index = 0;
}

// Format unified diff to color additions and deletions
function formatDiffText(diff_text) {
  const lines = diff_text.split("\n");
  const formatted_lines = lines.map((line) => {
    const escaped = line
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    if (line.startsWith("+")) {
      return `<span class="diff-added">${escaped}</span>`;
    } else if (line.startsWith("-")) {
      return `<span class="diff-deleted">${escaped}</span>`;
    } else if (line.startsWith(" ")) {
      return `<span class="diff-context">${escaped}</span>`;
    }
    return escaped;
  });
  return formatted_lines.join("\n");
}

// Parse thinking and message content from streamed LLM responses
function parseThinkingAndContent(text) {
  let thinking = "";
  let content = "";

  const start_idx = text.indexOf("<thinking>");
  const end_idx = text.indexOf("</thinking>");

  if (start_idx !== -1) {
    if (end_idx !== -1) {
      thinking = text.substring(start_idx + 10, end_idx);
      content = text.substring(0, start_idx) + text.substring(end_idx + 11);
    } else {
      thinking = text.substring(start_idx + 10);
      content = text.substring(0, start_idx);
    }
  } else {
    content = text;
  }

  return { thinking: thinking.trim(), content: content.trim() };
}

function updateThinkingSummary(details, content) {
  const summary = details.querySelector("summary");
  if (!summary) return;
  const lines = content.textContent.split("\n");
  const line_count = lines.length;
  if (details.open) {
    summary.textContent = "Reasoning Process";
  } else {
    summary.textContent = `Reasoning Process (${line_count} line${line_count === 1 ? "" : "s"})`;
  }
}

// Helper to count lines and create a collapse placeholder
function addOutputPlaceholder(output_elem) {
  const lines = output_elem.textContent.split("\n");
  const line_count = lines.length;

  let placeholder = output_elem.nextElementSibling;
  if (!placeholder || !placeholder.classList.contains("output-placeholder")) {
    placeholder = document.createElement("div");
    placeholder.className = "output-placeholder";
    output_elem.parentNode.insertBefore(placeholder, output_elem.nextSibling);

    placeholder.addEventListener("click", () => {
      if (
        output_elem.style.display === "block" ||
        output_elem.style.display === ""
      ) {
        output_elem.style.setProperty("display", "none", "important");
      } else {
        output_elem.style.setProperty("display", "block", "important");
      }
    });
  }

  placeholder.textContent = `[${line_count} line${line_count === 1 ? "" : "s"} of output]`;
}

// Create a new active prompt block at the bottom
function appendNewPromptBlock(cwd) {
  // Remove editing attributes from old active elements
  const old_input = document.getElementById("active-input");
  if (old_input) {
    old_input.removeAttribute("id");
    old_input.removeAttribute("contenteditable");
  }
  const old_suggestions = document.getElementById("slash-suggestions");
  if (old_suggestions) {
    old_suggestions.removeAttribute("id");
    old_suggestions.remove();
  }
  const old_chat_block = document.getElementById("active-chat-block");
  if (old_chat_block) {
    old_chat_block.removeAttribute("id");
  }

  // Append new active chat block
  const container = document.getElementById("terminal-chat-container");
  const chat_block = document.createElement("chat-block");
  chat_block.setAttribute("from", "user");
  chat_block.id = "active-chat-block";

  const pre_input = document.createElement("pre");
  pre_input.className = "input chat-marker";
  pre_input.id = "active-input";
  pre_input.setAttribute("contenteditable", "true");
  pre_input.setAttribute("spellcheck", "false");

  const suggestions_div = document.createElement("div");
  suggestions_div.className = "slash-suggestions";
  suggestions_div.id = "slash-suggestions";

  chat_block.appendChild(pre_input);
  chat_block.appendChild(suggestions_div);
  container.appendChild(chat_block);

  setupInputListeners(pre_input);
  placeCaretAtEnd(pre_input);

  // Auto-scroll window to bottom
  window.scrollTo(0, document.body.scrollHeight);
}

// Handle inputs and keys on active prompt
function setupInputListeners(input_elem) {
  input_elem.addEventListener("input", () => {
    const text = input_elem.textContent;

    // Toggle green/purple chevron based on shell command heuristics
    if (isShellCommand(text)) {
      input_elem.classList.remove("ai-prompt");
    } else {
      input_elem.classList.add("ai-prompt");
    }

    // Handle slash suggestions
    if (text.startsWith("/open") || text.startsWith("/code")) {
      const cmdPrefix = text.startsWith("/open") ? "/open" : "/code";
      const query = text.substring(cmdPrefix.length).trim();
      handleOpenSuggestions(query, cmdPrefix);
    } else if (text.startsWith("/") && !text.includes(" ")) {
      const filtered = getFilteredSuggestions(text.split(/\s+/)[0]);
      selected_suggestion_index = 0;
      renderSuggestions(filtered);
      open_command_cache = null;
    } else {
      hideSuggestions();
      open_command_cache = null;
    }
  });

  input_elem.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertText", false, "\n");
      return;
    }

    const suggestions_elem = document.getElementById("slash-suggestions");
    const suggestions_visible =
      suggestions_elem && suggestions_elem.style.display === "flex";

    if (suggestions_visible) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        selected_suggestion_index =
          (selected_suggestion_index + 1) % active_suggestions.length;
        renderSuggestions(active_suggestions);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selected_suggestion_index =
          (selected_suggestion_index - 1 + active_suggestions.length) %
          active_suggestions.length;
        renderSuggestions(active_suggestions);
      } else if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const active_item = suggestions_elem.querySelector(
          ".slash-suggestion-item.active",
        );
        if (active_item) {
          const cmd_name = active_item.querySelector(
            ".slash-suggestion-name",
          ).textContent;
          const isDir = active_item.getAttribute("data-is-dir") === "true";
          const isCommand = cmd_name.startsWith("/");

          const active_suggestion =
            active_suggestions[selected_suggestion_index];
          const cmdPrefix =
            active_suggestion && active_suggestion.cmdPrefix
              ? active_suggestion.cmdPrefix
              : "/open";
          const suggestionCompletedText = isCommand
            ? cmd_name
            : cmdPrefix + " " + cmd_name;
          const currentInputText = input_elem.textContent.trim();

          if (
            e.key === "Enter" &&
            !isDir &&
            currentInputText === suggestionCompletedText
          ) {
            hideSuggestions();
            submitInput(input_elem.textContent, e.ctrlKey && e.shiftKey);
            return;
          }

          input_elem.textContent = isCommand
            ? cmd_name + " "
            : cmdPrefix + " " + cmd_name + (isDir ? "/" : " ");
          placeCaretAtEnd(input_elem);
          hideSuggestions();
          // Dispatch input event to refresh suggestions
          input_elem.dispatchEvent(new Event("input"));
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        hideSuggestions();
      }
    } else {
      // Shell history navigation
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (history_index === -1) {
          temp_input_text = input_elem.textContent;
        }
        if (command_history.length > 0) {
          history_index =
            history_index === -1
              ? command_history.length - 1
              : Math.max(0, history_index - 1);
          input_elem.textContent = command_history[history_index];
          placeCaretAtEnd(input_elem);
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (history_index !== -1) {
          if (history_index === command_history.length - 1) {
            history_index = -1;
            input_elem.textContent = temp_input_text;
          } else {
            history_index++;
            input_elem.textContent = command_history[history_index];
          }
          placeCaretAtEnd(input_elem);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        submitInput(input_elem.textContent, e.ctrlKey && e.shiftKey);
      }
    }
  });
}

// Submit prompt or command
function submitInput(text, usePro = false) {
  const trimmed = text.replace(/\xa0/g, " ").trim();
  if (!trimmed) return;

  hideSuggestions();
  command_history.push(text);
  history_index = -1;

  // Make input static
  const input_elem = document.getElementById("active-input");
  if (input_elem) {
    input_elem.removeAttribute("contenteditable");
  }

  // Handle slash commands
  if (trimmed.startsWith("/")) {
    if (trimmed.startsWith("/clear")) {
      const container = document.getElementById("terminal-chat-container");
      container.innerHTML = "";
      window.api.executeSlashCommand(trimmed);
      return;
    } else if (trimmed.startsWith("/help")) {
      // Print help locally
      const container = document.getElementById("terminal-chat-container");
      const active_block = document.getElementById("active-chat-block");

      const out_pre = document.createElement("pre");
      out_pre.className = "output";
      out_pre.textContent = `Available slash commands:
  /clear          - Clear terminal screen history
  /code [path]    - Open file in VS Code
  /exit           - Close current window
  /help           - Print this help message
  /mobile         - Share the current terminal UI with a mobile device via QR code
  /open [path]    - Open a file in the inline editor
  /shortcuts      - List available keyboard shortcuts with descriptions
  /test-md        - Simulate AI responding with markdown-debug-example.md content`;

      active_block.appendChild(out_pre);
      appendNewPromptBlock();
      return;
    } else if (trimmed.startsWith("/open")) {
      const pathArg = trimmed.substring(5).trim();
      handleOpenCommand(pathArg);
      return;
    } else if (trimmed.startsWith("/code")) {
      const pathArg = trimmed.substring(5).trim();
      handleCodeCommand(pathArg);
      return;
    } else if (trimmed.startsWith("/shortcuts")) {
      // Print shortcuts locally
      const container = document.getElementById("terminal-chat-container");
      const active_block = document.getElementById("active-chat-block");

      const out_pre = document.createElement("pre");
      out_pre.className = "output";
      out_pre.textContent = `Available keyboard shortcuts:
  Ctrl+R (Cmd+R)        - Reload window
  Ctrl+Shift+I (Cmd+..) - Toggle Developer Tools
  Ctrl+Shift+D (Cmd+..) - Toggle Style Debug Mode
  Ctrl+H (Cmd+H)        - Cycle collapse modes (Full, Collapsed, Last-Only, User)
  Ctrl+L (Cmd+L)        - Clear terminal screen history
  Ctrl+C (Cmd+C)        - Interrupt active command execution (when no text selected)
  Ctrl+Enter            - Insert line break in prompt (forces AI prompt mode)
  Ctrl+Shift+Enter      - Submit AI prompt using the 'pro' tier model config
  Arrow Up / Down       - Navigate input command history`;

      active_block.appendChild(out_pre);
      appendNewPromptBlock();
      return;
    } else if (trimmed.startsWith("/test-md")) {
      const active_block = document.getElementById("active-chat-block");
      const filePath = workspace_root
        ? `${workspace_root}/markdown-debug-example.md`
        : "markdown-debug-example.md";

      window.api.readFileContent(filePath).then((result) => {
        if (result.error) {
          const out_pre = document.createElement("pre");
          out_pre.className = "output";
          out_pre.textContent = `Error reading markdown-debug-example.md: ${result.error}`;
          active_block.appendChild(out_pre);
          appendNewPromptBlock();
        } else {
          simulateAgentResponse(result.content);
        }
      });
      return;
    }

    // Pass other slash commands to main
    const active_block = document.getElementById("active-chat-block");
    active_output_block = document.createElement("pre");
    active_output_block.className = "output";
    active_block.appendChild(active_output_block);

    window.api.executeSlashCommand(trimmed);
    return;
  }

  // Check if AI Prompt or Shell Command
  if (isShellCommand(text)) {
    const active_block = document.getElementById("active-chat-block");
    active_output_block = document.createElement("pre");
    active_output_block.className = "output";
    active_block.appendChild(active_output_block);

    window.api.sendUserCommand(trimmed);
  } else {
    // Create a waiting block to show loading state
    const container = document.getElementById("terminal-chat-container");

    active_assistant_block = document.createElement("chat-block");
    active_assistant_block.setAttribute("from", "assistant");

    active_message_content = document.createElement("div");
    active_message_content.className = "input msg waiting chat-marker";

    active_assistant_block.appendChild(active_message_content);
    container.appendChild(active_assistant_block);

    active_assistant_text = "";
    active_thinking_details = null;
    active_thinking_content = null;

    window.scrollTo(0, document.body.scrollHeight);

    // Send to agent loop
    window.api.sendAgentPrompt(trimmed, usePro);
  }
}

// Global hotkeys
document.addEventListener("keydown", (e) => {
  if (document.body.classList.contains("mobile-active")) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMobileModal();
      return;
    }
  }
  if (active_editor_file_path) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeEditor();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveEditorContent();
      return;
    }
  }

  // Ctrl+H to cycle collapse modes
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") {
    e.preventDefault();
    cycleCollapseMode();
  }
  // Ctrl+L to clear terminal screen
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
    e.preventDefault();
    submitInput("/clear");
  }
  // Ctrl+C to interrupt command execution
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
    if (window.getSelection().toString() === "") {
      e.preventDefault();
      window.api.sendInterrupt();
    }
  }
});

// Setup initial listeners
window.addEventListener("DOMContentLoaded", () => {
  if (window.marked) {
    window.marked.use({
      walkTokens(token) {
        if (token.type === "code") {
          const lang = token.lang ? token.lang.toLowerCase() : "";
          if (["ts", "typescript", "tsx"].includes(lang)) {
            token.lang = "javascript";
          } else if (["sh", "shell"].includes(lang)) {
            token.lang = "bash";
          } else if (
            ["go", "rust", "c", "cpp", "csharp", "java", "clike"].includes(lang)
          ) {
            token.lang = "clike";
          }
        }
      },
    });
  }

  // Focus the input when clicking the background
  document.addEventListener("click", (e) => {
    if (active_editor_file_path) return;
    if (window.getSelection().toString() !== "") return;
    if (
      e.target.closest(
        'a, button, summary, details, .output-placeholder, [contenteditable="true"], textarea',
      )
    )
      return;
    const active_input = document.getElementById("active-input");
    if (active_input) {
      placeCaretAtEnd(active_input);
    }
  });

  // Handle markdown file links on click
  document.addEventListener("click", (e) => {
    const link = e.target.closest("a");
    if (link) {
      const href = link.getAttribute("href");
      if (href && href.startsWith("file:")) {
        e.preventDefault();
        const filePath = href.substring(5); // Remove 'file:' prefix
        let resolvedPath = filePath;
        if (!filePath.startsWith("/") && workspace_root) {
          resolvedPath = workspace_root + "/" + filePath;
        }
        const useVsCode = e.ctrlKey || e.metaKey;
        if (useVsCode) {
          window.api.openInVsCode(resolvedPath).then((result) => {
            if (result.error) {
              alert("Failed to open in VS Code: " + result.error);
            }
          });
        } else {
          openEditor(resolvedPath);
        }
      }
    }
  });

  const active_input = document.getElementById("active-input");
  if (active_input) {
    setupInputListeners(active_input);
    active_input.focus();
  }

  // Setup Editor Event Listeners
  const editorCode = document.getElementById("editor-code");
  if (editorCode) {
    editorCode.addEventListener("scroll", () => {
      document.getElementById("editor-line-numbers").scrollTop =
        editorCode.scrollTop;
    });

    // Initialize CodeJar with Prism syntax highlighting
    jar = CodeJar(editorCode, (editor) => {
      if (window.Prism) {
        window.Prism.highlightElement(editor);
      }
    });

    // Update line numbers on edits
    jar.onUpdate((code) => {
      updateEditorLineNumbers(code);
    });
  }

  const saveBtn = document.getElementById("editor-btn-save");
  if (saveBtn) {
    saveBtn.addEventListener("click", saveEditorContent);
  }

  const closeBtn = document.getElementById("editor-btn-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", closeEditor);
  }

  const mobileCloseBtn = document.getElementById("mobile-btn-close");
  if (mobileCloseBtn) {
    mobileCloseBtn.addEventListener("click", closeMobileModal);
  }

  // Request initial state on load/reload to restore session variables
  window.api.requestState();
});

// IPC listeners

window.api.onWindowInit((info) => {
  console.log("Window initialized:", info);
  if (info.availableCommands) {
    available_commands = new Set(info.availableCommands);
  }
  current_cwd = info.cwd || "";
  workspace_root = info.cwd || "";

  if (info.historyHtml) {
    const container = document.getElementById("terminal-chat-container");
    const active_block = document.getElementById("active-chat-block");
    if (container && active_block) {
      // Remove any existing history elements to avoid duplicates
      const children = Array.from(container.children);
      children.forEach(child => {
        if (child.id !== "active-chat-block") {
          child.remove();
        }
      });
      
      // Prepend previous history right before the active block
      active_block.insertAdjacentHTML("beforebegin", info.historyHtml);
      window.scrollTo(0, document.body.scrollHeight);
    }
  }
});

window.api.onShowQrCode(({ url, qrCodeDataUrl }) => {
  const img = document.getElementById("qr-image");
  const link = document.getElementById("qr-url");
  if (img) img.src = qrCodeDataUrl;
  if (link) {
    link.href = url;
    link.textContent = url;
  }
  document.body.classList.add("mobile-active");
});

function closeMobileModal() {
  document.body.classList.remove("mobile-active");
}

window.api.onShellCommandStart(({ command }) => {
  const input_elem = document.getElementById("active-input");
  if (input_elem && input_elem.hasAttribute("contenteditable")) {
    input_elem.textContent = command;
    input_elem.removeAttribute("contenteditable");
    input_elem.classList.remove("ai-prompt");

    const active_block = document.getElementById("active-chat-block");
    active_output_block = document.createElement("pre");
    active_output_block.className = "output";
    active_block.appendChild(active_output_block);

    hideSuggestions();
  }
});

window.api.onAgentPromptStart(({ prompt, usePro }) => {
  const input_elem = document.getElementById("active-input");
  if (input_elem && input_elem.hasAttribute("contenteditable")) {
    input_elem.textContent = prompt;
    input_elem.removeAttribute("contenteditable");
    input_elem.classList.add("ai-prompt");

    const container = document.getElementById("terminal-chat-container");

    active_assistant_block = document.createElement("chat-block");
    active_assistant_block.setAttribute("from", "assistant");

    active_message_content = document.createElement("div");
    active_message_content.className = "input msg waiting chat-marker";

    active_assistant_block.appendChild(active_message_content);
    container.appendChild(active_assistant_block);

    active_assistant_text = "";
    active_thinking_details = null;
    active_thinking_content = null;

    window.scrollTo(0, document.body.scrollHeight);
    hideSuggestions();
  }
});

window.api.onShellOutput((data) => {
  if (active_output_block) {
    active_output_block.textContent += data.text;
    window.scrollTo(0, document.body.scrollHeight);
  }
});

window.api.onShellComplete((info) => {
  if (active_output_block) {
    addOutputPlaceholder(active_output_block);
  }
  active_output_block = null;
  if (info.cwd) {
    current_cwd = info.cwd;
  }
  appendNewPromptBlock(info.cwd);
});

// Agent messages and tool responses

window.api.onAgentStatus((status) => {
  console.log("Agent status:", status);
});

window.api.onAgentChunk((info) => {
  // Create assistant message block if needed
  if (!active_assistant_block) {
    const container = document.getElementById("terminal-chat-container");

    active_assistant_block = document.createElement("chat-block");
    active_assistant_block.setAttribute("from", "assistant");

    active_message_content = document.createElement("div");
    active_message_content.className = "input msg chat-marker";

    active_assistant_block.appendChild(active_message_content);
    container.appendChild(active_assistant_block);

    active_assistant_text = "";
    active_thinking_details = null;
    active_thinking_content = null;
  }

  active_assistant_text += info.text;

  // Parse reasoning / thinking blocks
  const parsed = parseThinkingAndContent(active_assistant_text);

  if (parsed.thinking) {
    if (!active_thinking_details) {
      active_thinking_details = document.createElement("details");
      active_thinking_details.className = "thinking-details";
      active_thinking_details.setAttribute("open", "true");

      const summary = document.createElement("summary");
      summary.className = "chat-marker";
      summary.textContent = "Reasoning Process";

      active_thinking_content = document.createElement("pre");
      active_thinking_content.className = "thinking-content";

      active_thinking_details.appendChild(summary);
      active_thinking_details.appendChild(active_thinking_content);

      active_thinking_details.addEventListener("toggle", () => {
        updateThinkingSummary(active_thinking_details, active_thinking_content);
      });

      active_assistant_block.insertBefore(
        active_thinking_details,
        active_message_content,
      );
    }
    active_thinking_content.textContent = parsed.thinking;
    updateThinkingSummary(active_thinking_details, active_thinking_content);
  }

  if (window.marked) {
    active_message_content.innerHTML = window.marked.parse(parsed.content);
    if (window.Prism) {
      window.Prism.highlightAllUnder(active_message_content);
    }
  } else {
    active_message_content.textContent = parsed.content;
  }

  // Automatically collapse reasoning/thinking block when real content starts coming
  if (
    parsed.content &&
    active_thinking_details &&
    active_thinking_details.open &&
    !active_thinking_details.dataset.collapsedAutomatically
  ) {
    active_thinking_details.open = false;
    active_thinking_details.dataset.collapsedAutomatically = "true";
  }

  window.scrollTo(0, document.body.scrollHeight);
});

window.api.onAgentToolStart((info) => {
  // Stop waiting state of current assistant message segment
  if (active_assistant_block && active_message_content) {
    if (active_message_content.classList.contains("waiting")) {
      active_message_content.classList.remove("waiting");
    }
    if (!active_message_content.textContent && !active_thinking_details) {
      active_assistant_block.remove();
    }
  }
  active_assistant_block = null;

  const container = document.getElementById("terminal-chat-container");
  const chat_block = document.createElement("chat-block");
  chat_block.setAttribute("from", "assistant");

  if (info.name === "execute_command") {
    // Show command as an input block
    const pre_input = document.createElement("pre");
    pre_input.className = "input chat-marker";
    pre_input.textContent = info.args.command;

    const pre_output = document.createElement("pre");
    pre_output.className = "output";

    chat_block.appendChild(pre_input);
    chat_block.appendChild(pre_output);
    container.appendChild(chat_block);

    active_output_block = pre_output;
  } else {
    // Other tools (e.g. read_file, edit_file) shown as tool status lines
    const pre_status = document.createElement("pre");
    pre_status.className = "input chat-marker";
    pre_status.dataset.toolCallId = info.tool_call_id;

    let label = "";
    if (info.name === "read_file") label = `Reading ${info.args.path}`;
    else if (info.name === "edit_file") label = `Editing ${info.args.path}`;
    else if (info.name === "search_codebase")
      label = `Searching codebase for "${info.args.query}"`;
    else if (info.name === "list_directory")
      label = `Listing directory ${info.args.path || "."}`;
    else label = `Running ${info.name}...`;

    pre_status.textContent = label;
    chat_block.appendChild(pre_status);
    container.appendChild(chat_block);
  }

  window.scrollTo(0, document.body.scrollHeight);
});

window.api.onAgentToolOutput((info) => {
  // If we receive a colorized diff from edit_file, we output it under the tool line
  const container = document.getElementById("terminal-chat-container");
  const active_tool_elem = container.querySelector(
    `pre.input[data-tool-call-id="${info.tool_call_id}"]`,
  );

  if (active_tool_elem) {
    const parent = active_tool_elem.parentNode;
    let diff_pre = parent.querySelector("pre.output");
    if (!diff_pre) {
      diff_pre = document.createElement("pre");
      diff_pre.className = "output";
      parent.appendChild(diff_pre);
    }
    // Set formatted diff text using safe innerHTML
    diff_pre.innerHTML = formatDiffText(info.text);
    addOutputPlaceholder(diff_pre);
  } else if (active_output_block) {
    active_output_block.textContent += info.text;
  }

  window.scrollTo(0, document.body.scrollHeight);
});

window.api.onAgentToolComplete((info) => {
  if (active_output_block) {
    addOutputPlaceholder(active_output_block);
  }
  active_output_block = null;
  window.scrollTo(0, document.body.scrollHeight);
});

window.api.onAgentComplete(() => {
  console.log("AI Response:", {
    raw: active_assistant_text,
    parsed: parseThinkingAndContent(active_assistant_text),
  });
  if (active_assistant_block && active_message_content) {
    active_message_content.classList.remove("waiting");
    if (!active_message_content.textContent && !active_thinking_details) {
      active_assistant_block.remove();
    }
  }
  active_assistant_block = null;
  appendNewPromptBlock();
});

// Interactive File Explorer & Code Editor Helpers
async function handleOpenSuggestions(query, commandName) {
  // Parse folder and file prefix from query
  let dirPath = ".";
  let filePrefix = query;

  const lastSlashIndex = query.lastIndexOf("/");
  if (lastSlashIndex !== -1) {
    dirPath = query.substring(0, lastSlashIndex);
    filePrefix = query.substring(lastSlashIndex + 1);
  }

  // Fetch directory list if not cached or if directory changed
  if (!open_command_cache || open_command_cache.dirPath !== dirPath) {
    const result = await window.api.readDir(dirPath);
    if (result && !result.error) {
      open_command_cache = {
        dirPath: dirPath,
        resolved: result.resolved,
        items: result.items,
      };
    } else {
      open_command_cache = null;
    }
  }

  if (open_command_cache && open_command_cache.items) {
    const matches = open_command_cache.items.filter((item) =>
      item.name.toLowerCase().startsWith(filePrefix.toLowerCase()),
    );

    const suggestions = matches.map((item) => {
      const pathPrefix =
        lastSlashIndex !== -1 ? query.substring(0, lastSlashIndex + 1) : "";
      return {
        name: pathPrefix + item.name,
        description: item.is_directory ? "Directory" : formatBytes(item.size),
        isDir: item.is_directory,
        cmdPrefix: commandName,
      };
    });

    selected_suggestion_index = Math.min(
      selected_suggestion_index,
      Math.max(0, suggestions.length - 1),
    );
    renderSuggestions(suggestions);
  } else {
    hideSuggestions();
  }
}

async function handleOpenCommand(pathArg) {
  if (!pathArg) return;
  openEditor(pathArg);
  appendNewPromptBlock(current_cwd);
}

async function handleCodeCommand(pathArg) {
  if (!pathArg) return;
  appendNewPromptBlock(current_cwd);
  const result = await window.api.openInVsCode(pathArg);
  if (result.error) {
    alert("Failed to open VS Code: " + result.error);
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

async function openEditor(filePath) {
  const editorCode = document.getElementById("editor-code");
  const lineNumbers = document.getElementById("editor-line-numbers");
  const pathSpan = document.getElementById("editor-file-path");
  const overlay = document.getElementById("editor-overlay");

  pathSpan.textContent = "Loading " + filePath + "...";
  if (jar) jar.updateCode("");
  lineNumbers.textContent = "1";

  document.body.classList.add("editor-active");

  const result = await window.api.readFileContent(filePath);
  if (result.error) {
    pathSpan.textContent = "Error: " + result.error;
    if (jar) jar.updateCode("Failed to load file content:\n" + result.error);
    return;
  }

  active_editor_file_path = result.resolved;
  pathSpan.textContent = result.resolved;

  // Detect language
  const ext = result.resolved.split(".").pop().toLowerCase();
  let lang = "clike";
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext))
    lang = "javascript";
  else if (["py"].includes(ext)) lang = "python";
  else if (["json"].includes(ext)) lang = "json";
  else if (["sh", "bash"].includes(ext)) lang = "bash";
  else if (["html", "xml", "svg"].includes(ext)) lang = "markup";
  else if (["css"].includes(ext)) lang = "css";
  else if (["md", "markdown"].includes(ext)) lang = "markdown";

  editorCode.className = "editor-code language-" + lang;

  if (jar) {
    jar.updateCode(result.content);
  }

  updateEditorLineNumbers(result.content);
  editorCode.focus();
}

function updateEditorLineNumbers(code) {
  const editorCode = document.getElementById("editor-code");
  const lineNumbers = document.getElementById("editor-line-numbers");

  if (!editorCode || !lineNumbers) return;

  const val =
    typeof code === "string"
      ? code
      : jar
        ? jar.toString()
        : editorCode.textContent;
  const lines = val.split("\n");
  const lineCount = lines.length;

  let numbers = [];
  for (let i = 1; i <= lineCount; i++) {
    numbers.push(i);
  }
  lineNumbers.textContent = numbers.join("\n");

  lineNumbers.scrollTop = editorCode.scrollTop;
}

function closeEditor() {
  const overlay = document.getElementById("editor-overlay");
  document.body.classList.remove("editor-active");
  active_editor_file_path = null;

  const activeInput = document.getElementById("active-input");
  if (activeInput) {
    activeInput.focus();
  }
}

async function saveEditorContent() {
  if (!active_editor_file_path) return;

  const editorCode = document.getElementById("editor-code");
  const saveBtn = document.getElementById("editor-btn-save");

  const originalText = saveBtn.innerHTML;
  saveBtn.disabled = true;
  saveBtn.innerHTML =
    '<span class="material-symbols-outlined" style="font-size: 1.2em;">sync</span> Saving...';

  const content = jar ? jar.toString() : editorCode.textContent;
  const result = await window.api.saveFileContent(
    active_editor_file_path,
    content,
  );
  saveBtn.disabled = false;

  if (result.error) {
    saveBtn.innerHTML =
      '<span class="material-symbols-outlined" style="font-size: 1.2em;">error</span> Error';
    alert("Failed to save file: " + result.error);
    setTimeout(() => {
      saveBtn.innerHTML = originalText;
    }, 2000);
  } else {
    if (result.formatted && result.formattedContent) {
      if (jar) {
        const pos = jar.save();
        jar.updateCode(result.formattedContent);
        try {
          jar.restore(pos);
        } catch (restoreErr) {
          console.warn("Failed to restore caret position:", restoreErr);
        }
      } else {
        editorCode.textContent = result.formattedContent;
      }
      updateEditorLineNumbers(result.formattedContent);
    }
    saveBtn.innerHTML =
      '<span class="material-symbols-outlined" style="font-size: 1.2em;">done</span> Saved';
    saveBtn.style.background = "var(--green)";
    saveBtn.style.color = "var(--black)";
    setTimeout(() => {
      saveBtn.innerHTML = originalText;
      saveBtn.style.background = "";
      saveBtn.style.color = "";
    }, 1500);
  }
}

function simulateAgentResponse(fullText) {
  const container = document.getElementById("terminal-chat-container");

  active_assistant_block = document.createElement("chat-block");
  active_assistant_block.setAttribute("from", "assistant");

  active_message_content = document.createElement("div");
  active_message_content.className = "input msg waiting chat-marker";

  active_assistant_block.appendChild(active_message_content);
  container.appendChild(active_assistant_block);

  active_assistant_text = "";
  active_thinking_details = null;
  active_thinking_content = null;

  window.scrollTo(0, document.body.scrollHeight);

  const chunkSize = 30;
  let currentIndex = 0;

  const intervalId = setInterval(() => {
    if (currentIndex >= fullText.length) {
      clearInterval(intervalId);

      if (active_assistant_block && active_message_content) {
        active_message_content.classList.remove("waiting");
      }
      active_assistant_block = null;
      appendNewPromptBlock();
      return;
    }

    const chunkText = fullText.slice(currentIndex, currentIndex + chunkSize);
    currentIndex += chunkSize;

    active_assistant_text += chunkText;
    const parsed = parseThinkingAndContent(active_assistant_text);

    if (parsed.thinking) {
      if (!active_thinking_details) {
        active_thinking_details = document.createElement("details");
        active_thinking_details.className = "thinking-details";
        active_thinking_details.setAttribute("open", "true");

        const summary = document.createElement("summary");
        summary.className = "chat-marker";
        summary.textContent = "Reasoning Process";

        active_thinking_content = document.createElement("pre");
        active_thinking_content.className = "thinking-content";

        active_thinking_details.appendChild(summary);
        active_thinking_details.appendChild(active_thinking_content);

        active_thinking_details.addEventListener("toggle", () => {
          updateThinkingSummary(
            active_thinking_details,
            active_thinking_content,
          );
        });

        active_assistant_block.insertBefore(
          active_thinking_details,
          active_message_content,
        );
      }
      active_thinking_content.textContent = parsed.thinking;
      updateThinkingSummary(active_thinking_details, active_thinking_content);
    }

    if (window.marked) {
      active_message_content.innerHTML = window.marked.parse(parsed.content);
      if (window.Prism) {
        window.Prism.highlightAllUnder(active_message_content);
      }
    } else {
      active_message_content.textContent = parsed.content;
    }

    if (
      parsed.content &&
      active_thinking_details &&
      active_thinking_details.open &&
      !active_thinking_details.dataset.collapsedAutomatically
    ) {
      active_thinking_details.open = false;
      active_thinking_details.dataset.collapsedAutomatically = "true";
    }

    window.scrollTo(0, document.body.scrollHeight);
  }, 15);
}
