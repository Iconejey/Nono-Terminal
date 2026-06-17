# Nono-Terminal

Nono-Terminal is an Electron-based persistent terminal emulator integrated with an OpenAI AI assistant agent. It allows executing standard terminal commands side-by-side with natural language AI instructions. The agent can inspect your workspace, search your codebase, edit files using smart diffs, and run terminal commands to install and test code.

---

## Todo list

- /context slash command to view the current context window size and contents.

## Architecture & Technical Stack

Nono-Terminal separates the browser interface from your system using Electron IPC channels:

- **Renderer (Frontend):** Consists of `index.html`, `style.css`, and `window.js`. It utilizes custom styling with the Consolas font, Material Icons, and custom scrollbars.
- **IPC Bridge (`preload.js`):** Exposes safe, context-isolated IPC channels to the renderer.
- **Main Process (`main.js`):** Manages a single-instance app lock, spawns persistent shell processes (mapping them to `event.sender.id`), handles local tool executions, and orchestrates the OpenAI reasoning loop.

---

## Features

### 1. Persistent Terminal Execution

Spawns a persistent `/bin/bash` shell in the background. State features like environment variables, child processes, and current working directories (`$PWD`) are preserved between executions. Directory changes and command completions are detected automatically via tracking delimiters.

### 2. OpenAI SDK Agent Integration

The AI agent operates in a reasoning loop using the OpenAI SDK.

- **Available Tools:**
    - `execute_command(command)`: Runs a command in the persistent shell and streams outputs in real-time.
    - `read_file(path, start_line, end_line)`: Reads specific line ranges from a file.
    - `edit_file(path, search_content, replace_content)`: Performs unique search-and-replace edits.
    - `search_codebase(query)`: A native grep-like search across workspace text files.
    - `list_directory(path)`: Lists directory contents.
- **Abort & Retry:** Network calls feature a 30-second timeout wrapper (`callOpenAiWithRetry`) that retries up to 3 times on transient issues.
- **Context Truncation:** To manage context window size and costs, older `read_file` and `search_codebase` tool responses are automatically truncated as the conversation grows.
- **Error Loop Halting:** The agent will halt execution if a command or tool fails 3 consecutive times, preventing runaway loops.
- **Repo Map Context:** Generates a tree map of the repository (respecting `.gitignore`) and injects it into the agent upon start.

### 3. Advanced UI Controls

- **Reasoning Process Dropdowns:** Streams `<thinking>...</thinking>` reasoning blocks into a collapsible `<details>` element in the UI, keeping the main terminal view clean.
- **Unified Diff Markup:** Edits made via `edit_file` are displayed to the user as a colorized unified diff highlighting line additions in green and deletions in red.
- **Dynamic Prompt Chevron:** Automatically checks the input heuristic: if it looks like a natural language prompt, the prompt chevron turns purple (`var(--purple)`). If it looks like a shell command, the chevron remains green (`var(--green)`).
- **Output Collapse Modes:** Cycle through output states using `Ctrl+H`:
    - `Full` (Normal): Shows all command outputs.
    - `Collapsed`: Hides all outputs and replaces them with a line-count placeholder button (e.g., `[42 lines of output]`). Clicking a placeholder expands that specific output block.
    - `Last`: Collapses all historical command outputs but keeps the newest one expanded.

### 4. Interactive Autocomplete Slash Commands

Typing a `/` in the prompt opens an autocomplete popup box under the cursor.

- `ArrowUp` / `ArrowDown`: Navigates the suggestions.
- `Tab` / `Enter`: Autocompletes the highlighted suggestion.
- _Note:_ The suggestions popup automatically hides once you type a space to let you input arguments naturally.
    - `/api-key [key]`: Views or saves the API key for the current active provider locally to `~/.nono-terminal-config.json`.
    - `/clear`: Clears screen history.
    - `/exit`: Closes the current window.
    - `/model [name]`: Sets or views the active chat completions model (e.g. `/model gpt-4o-mini`).
    - `/models`: Fetches and lists all available models from the active provider using the `openai.models.list()` API.
    - `/provider [name] [base_url] [api_key]`: Views, registers, or changes the active API provider, supporting custom base URLs (e.g. OpenRouter, Groq, local Ollama).
    - `/providers`: Lists all registered API providers.
    - `/help`: Prints the list of available slash commands.

---

## Keyboard Shortcuts

- `Ctrl+R` / `Cmd+R`: Reloads the active window.
- `Ctrl+Shift+I` / `Cmd+Option+I`: Toggles Chromium Developer Tools.
- `Ctrl+H` / `Cmd+H`: Cycles output collapse modes (`Full` ➔ `Collapsed` ➔ `Last`).
- `Ctrl+C`: Interrupts running child processes (via `pkill -INT -P` against the shell PID) without closing the terminal shell.

---

## Installation & Running

### Dependencies

Ensure Node.js and dependencies are installed:

```bash
npm install
```

### Running on Arch Linux / Hyprland

To ensure Wayland compatibility, fractional display scaling, and correct GPU rendering under tiling managers like Hyprland, it is recommended to run Nono-Terminal using your system-installed `electron` binary:

```bash
# Run using system-wide Electron
electron .
```

or:

```bash
# Fallback to npm script (which calls system electron if npm local devDependencies are removed)
npm start
```
