// Renderer process UI logic for Nono-Terminal
let command_history = [];
let history_index = -1;
let temp_input_text = '';

const slash_commands = [
	{ name: '/api-key', description: 'Configure API key for current provider' },
	{ name: '/clear', description: 'Clear terminal screen history' },
	{ name: '/exit', description: 'Close current window' },
	{ name: '/help', description: 'Show list of available commands' },
	{ name: '/model', description: 'Get or set chat completion model' },
	{ name: '/models', description: 'List available models from provider' },
	{ name: '/provider', description: 'View or set API provider and base URL' },
	{ name: '/providers', description: 'List all registered API providers' },
	{ name: '/shortcuts', description: 'List available keyboard shortcuts with descriptions' }
];

let selected_suggestion_index = 0;
let current_collapse_mode = 'full'; // 'full', 'collapsed', 'last', 'user'

let active_output_block = null;
let active_assistant_block = null;
let active_assistant_text = '';
let active_thinking_details = null;
let active_thinking_content = null;
let active_message_content = null;

let available_commands = new Set();

// Heuristic to detect if input represents a shell command vs AI prompt
function isShellCommand(text) {
	const trimmed = text.trim();
	if (!trimmed) return true;

	const first_word = trimmed.split(/\s+/)[0];

	if (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('/') || trimmed.startsWith('~/')) {
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
	if (typeof window.getSelection !== 'undefined' && typeof document.createRange !== 'undefined') {
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
	const container = document.getElementById('terminal-chat-container');
	if (current_collapse_mode === 'full') {
		current_collapse_mode = 'collapsed';
		container.className = 'mode-collapsed';
	} else if (current_collapse_mode === 'collapsed') {
		current_collapse_mode = 'last';
		container.className = 'mode-last';
	} else if (current_collapse_mode === 'last') {
		current_collapse_mode = 'user';
		container.className = 'mode-user';
	} else {
		current_collapse_mode = 'full';
		container.className = 'mode-full';
	}
}

// Filter and render slash command suggestions
function getFilteredSuggestions(query) {
	return slash_commands.filter(cmd => cmd.name.startsWith(query));
}

function renderSuggestions(filtered) {
	const suggestions_elem = document.getElementById('slash-suggestions');
	if (!suggestions_elem) return;

	if (filtered.length === 0) {
		suggestions_elem.style.display = 'none';
		return;
	}

	suggestions_elem.innerHTML = '';
	filtered.forEach((cmd, idx) => {
		const item = document.createElement('div');
		item.className = 'slash-suggestion-item' + (idx === selected_suggestion_index ? ' active' : '');
		item.innerHTML = `
      <span class="slash-suggestion-name">${cmd.name}</span>
      <span class="slash-suggestion-desc">${cmd.description}</span>
    `;
		item.addEventListener('click', () => {
			const input = document.getElementById('active-input');
			input.textContent = cmd.name + ' ';
			placeCaretAtEnd(input);
			hideSuggestions();
		});
		suggestions_elem.appendChild(item);
	});

	suggestions_elem.style.display = 'flex';
}

function hideSuggestions() {
	const suggestions_elem = document.getElementById('slash-suggestions');
	if (suggestions_elem) {
		suggestions_elem.style.display = 'none';
	}
	selected_suggestion_index = 0;
}

// Format unified diff to color additions and deletions
function formatDiffText(diff_text) {
	const lines = diff_text.split('\n');
	const formatted_lines = lines.map(line => {
		const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		if (line.startsWith('+')) {
			return `<span class="diff-added">${escaped}</span>`;
		} else if (line.startsWith('-')) {
			return `<span class="diff-deleted">${escaped}</span>`;
		} else if (line.startsWith(' ')) {
			return `<span class="diff-context">${escaped}</span>`;
		}
		return escaped;
	});
	return formatted_lines.join('\n');
}

// Parse thinking and message content from streamed LLM responses
function parseThinkingAndContent(text) {
	let thinking = '';
	let content = '';

	const start_idx = text.indexOf('<thinking>');
	const end_idx = text.indexOf('</thinking>');

	if (start_idx !== -1) {
		if (end_idx !== -1) {
			thinking = text.substring(start_idx + 10, end_idx);
			content = text.substring(0, start_idx) + text.substring(end_idx + 12);
		} else {
			thinking = text.substring(start_idx + 10);
			content = text.substring(0, start_idx);
		}
	} else {
		content = text;
	}

	return { thinking, content };
}

function updateThinkingSummary(details, content) {
	const summary = details.querySelector('summary');
	if (!summary) return;
	const lines = content.textContent.split('\n');
	const line_count = lines.length;
	if (details.open) {
		summary.textContent = 'Reasoning Process';
	} else {
		summary.textContent = `Reasoning Process (${line_count} line${line_count === 1 ? '' : 's'})`;
	}
}

// Helper to count lines and create a collapse placeholder
function addOutputPlaceholder(output_elem) {
	const lines = output_elem.textContent.split('\n');
	const line_count = lines.length;

	let placeholder = output_elem.nextElementSibling;
	if (!placeholder || !placeholder.classList.contains('output-placeholder')) {
		placeholder = document.createElement('div');
		placeholder.className = 'output-placeholder';
		output_elem.parentNode.insertBefore(placeholder, output_elem.nextSibling);

		placeholder.addEventListener('click', () => {
			if (output_elem.style.display === 'block' || output_elem.style.display === '') {
				output_elem.style.setProperty('display', 'none', 'important');
			} else {
				output_elem.style.setProperty('display', 'block', 'important');
			}
		});
	}

	placeholder.textContent = `[${line_count} line${line_count === 1 ? '' : 's'} of output]`;
}

// Create a new active prompt block at the bottom
function appendNewPromptBlock(cwd) {
	// Remove editing attributes from old active elements
	const old_input = document.getElementById('active-input');
	if (old_input) {
		old_input.removeAttribute('id');
		old_input.removeAttribute('contenteditable');
	}
	const old_suggestions = document.getElementById('slash-suggestions');
	if (old_suggestions) {
		old_suggestions.removeAttribute('id');
		old_suggestions.remove();
	}
	const old_chat_block = document.getElementById('active-chat-block');
	if (old_chat_block) {
		old_chat_block.removeAttribute('id');
	}

	// Append new active chat block
	const container = document.getElementById('terminal-chat-container');
	const chat_block = document.createElement('chat-block');
	chat_block.setAttribute('from', 'user');
	chat_block.id = 'active-chat-block';

	const pre_input = document.createElement('pre');
	pre_input.className = 'input';
	pre_input.id = 'active-input';
	pre_input.setAttribute('contenteditable', 'true');
	pre_input.setAttribute('spellcheck', 'false');

	const suggestions_div = document.createElement('div');
	suggestions_div.className = 'slash-suggestions';
	suggestions_div.id = 'slash-suggestions';

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
	input_elem.addEventListener('input', () => {
		const text = input_elem.textContent;

		// Toggle green/purple chevron based on shell command heuristics
		if (isShellCommand(text)) {
			input_elem.classList.remove('ai-prompt');
		} else {
			input_elem.classList.add('ai-prompt');
		}

		// Handle slash suggestions
		if (text.startsWith('/') && !text.includes(' ')) {
			const filtered = getFilteredSuggestions(text.split(/\s+/)[0]);
			selected_suggestion_index = 0;
			renderSuggestions(filtered);
		} else {
			hideSuggestions();
		}
	});

	input_elem.addEventListener('keydown', e => {
		const suggestions_elem = document.getElementById('slash-suggestions');
		const suggestions_visible = suggestions_elem && suggestions_elem.style.display === 'flex';
		const text = input_elem.textContent;
		const filtered = suggestions_visible ? getFilteredSuggestions(text.split(/\s+/)[0]) : [];

		if (suggestions_visible) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				selected_suggestion_index = (selected_suggestion_index + 1) % filtered.length;
				renderSuggestions(filtered);
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				selected_suggestion_index = (selected_suggestion_index - 1 + filtered.length) % filtered.length;
				renderSuggestions(filtered);
			} else if (e.key === 'Tab' || e.key === 'Enter') {
				e.preventDefault();
				const active_item = suggestions_elem.querySelector('.slash-suggestion-item.active');
				if (active_item) {
					const cmd_name = active_item.querySelector('.slash-suggestion-name').textContent;
					input_elem.textContent = cmd_name + ' ';
					placeCaretAtEnd(input_elem);
					hideSuggestions();
				}
			} else if (e.key === 'Escape') {
				e.preventDefault();
				hideSuggestions();
			}
		} else {
			// Shell history navigation
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				if (history_index === -1) {
					temp_input_text = input_elem.textContent;
				}
				if (command_history.length > 0) {
					history_index = history_index === -1 ? command_history.length - 1 : Math.max(0, history_index - 1);
					input_elem.textContent = command_history[history_index];
					placeCaretAtEnd(input_elem);
				}
			} else if (e.key === 'ArrowDown') {
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
			} else if (e.key === 'Enter') {
				e.preventDefault();
				submitInput(input_elem.textContent);
			}
		}
	});
}

// Submit prompt or command
function submitInput(text) {
	const trimmed = text.replace(/\xa0/g, ' ').trim();
	if (!trimmed) return;

	hideSuggestions();
	command_history.push(text);
	history_index = -1;

	// Make input static
	const input_elem = document.getElementById('active-input');
	if (input_elem) {
		input_elem.removeAttribute('contenteditable');
	}

	// Handle slash commands
	if (trimmed.startsWith('/')) {
		if (trimmed.startsWith('/clear')) {
			const container = document.getElementById('terminal-chat-container');
			container.innerHTML = '';
			window.api.executeSlashCommand(trimmed);
			return;
		} else if (trimmed.startsWith('/help')) {
			// Print help locally
			const container = document.getElementById('terminal-chat-container');
			const active_block = document.getElementById('active-chat-block');

			const out_pre = document.createElement('pre');
			out_pre.className = 'output';
			out_pre.textContent = `Available slash commands:
  /api-key <key>  - Configure and save API key for current provider
  /clear          - Clear terminal screen history
  /exit           - Close current window
  /help           - Print this help message
  /model [model]  - Set or view completing model (e.g. gpt-4o-mini)
  /models         - List available models from the current provider
  /provider       - View or set active API provider and custom base URL
  /providers      - List all registered API providers
  /shortcuts      - List available keyboard shortcuts with descriptions`;

			active_block.appendChild(out_pre);
			appendNewPromptBlock();
			return;
		} else if (trimmed.startsWith('/shortcuts')) {
			// Print shortcuts locally
			const container = document.getElementById('terminal-chat-container');
			const active_block = document.getElementById('active-chat-block');

			const out_pre = document.createElement('pre');
			out_pre.className = 'output';
			out_pre.textContent = `Available keyboard shortcuts:
  Ctrl+R (Cmd+R)        - Reload window
  Ctrl+Shift+I (Cmd+..) - Toggle Developer Tools
  Ctrl+Shift+D (Cmd+..) - Toggle Style Debug Mode
  Ctrl+H (Cmd+H)        - Cycle collapse modes (Full, Collapsed, Last-Only, User)
  Ctrl+L (Cmd+L)        - Clear terminal screen history
  Ctrl+C (Cmd+C)        - Interrupt active command execution (when no text selected)
  Arrow Up / Down       - Navigate input command history`;

			active_block.appendChild(out_pre);
			appendNewPromptBlock();
			return;
		}

		// Pass other slash commands to main
		const active_block = document.getElementById('active-chat-block');
		active_output_block = document.createElement('pre');
		active_output_block.className = 'output';
		active_block.appendChild(active_output_block);

		window.api.executeSlashCommand(trimmed);
		return;
	}

	// Check if AI Prompt or Shell Command
	if (isShellCommand(trimmed)) {
		const active_block = document.getElementById('active-chat-block');
		active_output_block = document.createElement('pre');
		active_output_block.className = 'output';
		active_block.appendChild(active_output_block);

		window.api.sendUserCommand(trimmed);
	} else {
		// Send to agent loop
		window.api.sendAgentPrompt(trimmed);
	}
}

// Global hotkeys
document.addEventListener('keydown', e => {
	// Ctrl+H to cycle collapse modes
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
		e.preventDefault();
		cycleCollapseMode();
	}
	// Ctrl+L to clear terminal screen
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
		e.preventDefault();
		submitInput('/clear');
	}
	// Ctrl+C to interrupt command execution
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
		if (window.getSelection().toString() === '') {
			e.preventDefault();
			window.api.sendInterrupt();
		}
	}
});

// Setup initial listeners
window.addEventListener('DOMContentLoaded', () => {
	// Focus the input when clicking the background
	document.addEventListener('click', e => {
		if (window.getSelection().toString() !== '') return;
		if (e.target.closest('a, button, summary, details, .output-placeholder, [contenteditable="true"]')) return;
		const active_input = document.getElementById('active-input');
		if (active_input) {
			placeCaretAtEnd(active_input);
		}
	});

	const active_input = document.getElementById('active-input');
	if (active_input) {
		setupInputListeners(active_input);
		active_input.focus();
	}

	// Request initial state on load/reload to restore session variables
	window.api.requestState();
});

// IPC listeners

window.api.onWindowInit(info => {
	console.log('Window initialized:', info);
	if (info.availableCommands) {
		available_commands = new Set(info.availableCommands);
	}
});

window.api.onShellOutput(data => {
	if (active_output_block) {
		active_output_block.textContent += data.text;
		window.scrollTo(0, document.body.scrollHeight);
	}
});

window.api.onShellComplete(info => {
	if (active_output_block) {
		addOutputPlaceholder(active_output_block);
	}
	active_output_block = null;
	appendNewPromptBlock(info.cwd);
});

// Agent messages and tool responses

window.api.onAgentStatus(status => {
	console.log('Agent status:', status);
});

window.api.onAgentChunk(info => {
	// Create assistant message block if needed
	if (!active_assistant_block) {
		const container = document.getElementById('terminal-chat-container');

		active_assistant_block = document.createElement('chat-block');
		active_assistant_block.setAttribute('from', 'assistant');

		active_message_content = document.createElement('pre');
		active_message_content.className = 'input msg';

		active_assistant_block.appendChild(active_message_content);
		container.appendChild(active_assistant_block);

		active_assistant_text = '';
		active_thinking_details = null;
		active_thinking_content = null;
	}

	active_assistant_text += info.text;

	// Parse reasoning / thinking blocks
	const parsed = parseThinkingAndContent(active_assistant_text);

	if (parsed.thinking) {
		if (!active_thinking_details) {
			active_thinking_details = document.createElement('details');
			active_thinking_details.className = 'thinking-details';
			active_thinking_details.setAttribute('open', 'true');

			const summary = document.createElement('summary');
			summary.textContent = 'Reasoning Process';

			active_thinking_content = document.createElement('pre');
			active_thinking_content.className = 'thinking-content';

			active_thinking_details.appendChild(summary);
			active_thinking_details.appendChild(active_thinking_content);

			active_thinking_details.addEventListener('toggle', () => {
				updateThinkingSummary(active_thinking_details, active_thinking_content);
			});

			active_assistant_block.insertBefore(active_thinking_details, active_message_content);
		}
		active_thinking_content.textContent = parsed.thinking;
		updateThinkingSummary(active_thinking_details, active_thinking_content);
	}

	if (parsed.content) {
		active_message_content.textContent = parsed.content;
	}

	window.scrollTo(0, document.body.scrollHeight);
});

window.api.onAgentToolStart(info => {
	// Clear any active streamed response blocks
	active_assistant_block = null;

	const container = document.getElementById('terminal-chat-container');
	const chat_block = document.createElement('chat-block');
	chat_block.setAttribute('from', 'assistant');

	if (info.name === 'execute_command') {
		// Show command as an input block
		const pre_input = document.createElement('pre');
		pre_input.className = 'input';
		pre_input.textContent = info.args.command;

		const pre_output = document.createElement('pre');
		pre_output.className = 'output';

		chat_block.appendChild(pre_input);
		chat_block.appendChild(pre_output);
		container.appendChild(chat_block);

		active_output_block = pre_output;
	} else {
		// Other tools (e.g. read_file, edit_file) shown as tool status lines
		const pre_status = document.createElement('pre');
		pre_status.className = 'input';
		pre_status.dataset.toolCallId = info.tool_call_id;

		let label = '';
		if (info.name === 'read_file') label = `Reading ${info.args.path}`;
		else if (info.name === 'edit_file') label = `Editing ${info.args.path}`;
		else if (info.name === 'search_codebase') label = `Searching codebase for "${info.args.query}"`;
		else if (info.name === 'list_directory') label = `Listing directory ${info.args.path || '.'}`;
		else label = `Running ${info.name}...`;

		pre_status.textContent = label;
		chat_block.appendChild(pre_status);
		container.appendChild(chat_block);
	}

	window.scrollTo(0, document.body.scrollHeight);
});

window.api.onAgentToolOutput(info => {
	// If we receive a colorized diff from edit_file, we output it under the tool line
	const container = document.getElementById('terminal-chat-container');
	const active_tool_elem = container.querySelector(`pre.input.msg[data-tool-call-id="${info.tool_call_id}"]`);

	if (active_tool_elem) {
		const parent = active_tool_elem.parentNode;
		let diff_pre = parent.querySelector('pre.output');
		if (!diff_pre) {
			diff_pre = document.createElement('pre');
			diff_pre.className = 'output';
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

window.api.onAgentToolComplete(info => {
	if (active_output_block) {
		addOutputPlaceholder(active_output_block);
	}
	active_output_block = null;
	window.scrollTo(0, document.body.scrollHeight);
});

window.api.onAgentComplete(() => {
	active_assistant_block = null;
	appendNewPromptBlock();
});
