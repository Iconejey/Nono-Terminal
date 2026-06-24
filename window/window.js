// Renderer process UI logic for Nono-Terminal
const is_mobile = !window.api || !window.api.isElectron;

function showCancelButton() {
	const btn = document.getElementById('cancel-task-btn');
	if (btn) {
		btn.style.display = 'inline-flex';
	}
}

function hideCancelButton() {
	const btn = document.getElementById('cancel-task-btn');
	if (btn) {
		btn.style.display = 'none';
	}
}

let isScanning = false;
let scanAbortController = null;

function renderConnectionOverlay(statusText, windowsList = []) {
	const body = document.getElementById('connection-body');
	if (!body) return;
	body.innerHTML = '';

	if (windowsList.length === 0) {
		body.innerHTML = `<div class="diff-empty-msg">${statusText}</div>`;
		return;
	}

	const section = document.createElement('div');
	section.className = 'diff-section';
	section.innerHTML = `<div class="diff-section-header">Discovered Sessions</div>`;

	const list = document.createElement('div');
	list.className = 'diff-list';

	windowsList.forEach(w => {
		const item = document.createElement('div');
		item.className = 'diff-item';
		item.style.cursor = 'pointer';
		item.style.display = 'flex';
		item.style.flexDirection = 'column';
		item.style.alignItems = 'flex-start';
		item.style.padding = '14px 18px';
		item.style.gap = '4px';
		item.style.width = '100%';
		item.style.boxSizing = 'border-box';
		item.style.marginBottom = '8px';

		item.innerHTML = `
      <div style="font-weight: bold; color: var(--purple); font-size: 1.05em; font-family: monospace;">Host: ${w.ip}:${w.port}</div>
      <div style="color: var(--white); font-size: 0.95em; font-family: monospace;">Window ID: ${w.id}</div>
      <div style="color: var(--gray-light); font-size: 0.85em; font-family: monospace;">Started: ${w.timeStr}</div>
      <div style="color: var(--gray); font-size: 0.8em; font-family: monospace; word-break: break-all; margin-top: 4px;">Path: ${w.cwd}</div>
    `;

		const connectFn = () => {
			item.style.pointerEvents = 'none';
			item.style.opacity = '0.6';
			const hostDiv = item.firstElementChild;
			if (hostDiv) hostDiv.textContent = 'Linking...';

			window.api
				.connectToHost(w.ip, w.port, w.id)
				.then(() => {
					saveKnownHost(w.ip, w.port);
					document.body.classList.remove('conn-active');
				})
				.catch(err => {
					item.style.pointerEvents = 'auto';
					item.style.opacity = '1';
					if (hostDiv) hostDiv.textContent = `Host: ${w.ip}:${w.port}`;
					alert('Failed to connect: ' + err.message);
				});
		};

		item.addEventListener('click', () => {
			connectFn();
		});

		list.appendChild(item);
	});

	section.appendChild(list);
	body.appendChild(section);
}

function getTargetUrl(ip, port) {
	if (ip.startsWith('http://') || ip.startsWith('https://')) {
		return ip;
	}
	const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
	const hasPort = ip.includes(':');
	const protocol = (window.location.protocol === 'https:' && !isIp) ? 'https' : 'http';
	if (hasPort || isIp || ip === 'localhost') {
		return `${protocol}://${ip}${hasPort ? '' : ':' + port}`;
	}
	return `${protocol}://${ip}`;
}

function saveKnownHost(ip, port) {
	try {
		let known = JSON.parse(localStorage.getItem('nono_known_hosts')) || [];
		if (!Array.isArray(known)) known = [];
		known = known.filter(h => h.ip !== ip || h.port !== port);
		known.unshift({ ip, port });
		if (known.length > 10) known = known.slice(0, 10);
		localStorage.setItem('nono_known_hosts', JSON.stringify(known));
	} catch (e) {
		console.error('Failed to save known host:', e);
	}
}

async function startSubnetScan(ignoreKnown = false) {
	if (isScanning) {
		if (scanAbortController) {
			scanAbortController.abort();
		}
	}
	isScanning = true;
	window.discoveredWindows = [];

	document.body.classList.add('conn-active');
	renderConnectionOverlay('Scanning local network...');

	const getSubnetsToScan = () => {
		const host = window.location.hostname;
		const subnets = ['192.168.1', '192.168.0', '192.168.2', '10.0.0'];
		const match = host.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
		if (match && !host.startsWith('127.')) {
			const localSubnet = match[1];
			if (!subnets.includes(localSubnet)) {
				subnets.unshift(localSubnet);
			}
		}
		return subnets;
	};

	const subnets = getSubnetsToScan();
	const portsToCheck = [13737, 13738, 13739];
	const totalIps = 254;

	scanAbortController = new AbortController();
	let serverFound = false;

	// Try known hosts first for instant PWA loading
	if (!ignoreKnown) {
		let knownHosts = [];
		try {
			const saved = JSON.parse(localStorage.getItem('nono_known_hosts')) || [];
			if (saved.length === 0) {
				const oldIp = localStorage.getItem('nono_ip');
				const oldPort = localStorage.getItem('nono_port');
				if (oldIp && oldPort) {
					saved.push({ ip: oldIp, port: oldPort });
				}
			}
			knownHosts = saved;
		} catch (e) {
			// ignore
		}

		if (knownHosts.length > 0) {
			renderConnectionOverlay('Checking known hosts...');
			const knownBatch = knownHosts.map(async (host) => {
				if (serverFound || (window.api && window.api.windowId)) return;
				try {
					const baseUrl = getTargetUrl(host.ip, host.port);
					const res = await fetch(`${baseUrl}/api/active-windows`, {
						signal: scanAbortController.signal
					});
					if (res.ok) {
						const data = await res.json();
						if (data.windows && data.windows.length > 0) {
							serverFound = true;
							scanAbortController.abort(); // Cancel other pending requests
							data.windows.forEach(w => {
								const timeStr = w.startTime ? new Date(w.startTime).toLocaleString() : 'Unknown';
								const exists = window.discoveredWindows.some(d => d.ip === host.ip && d.port === host.port && d.id === w.id);
								if (!exists) {
									window.discoveredWindows.push({
										ip: host.ip,
										port: host.port,
										id: w.id,
										timeStr,
										cwd: w.cwd
									});
								}
							});
							renderConnectionOverlay('', window.discoveredWindows);
						}
					}
				} catch (e) {
					// ignore
				}
			});
			try {
				await Promise.all(knownBatch);
			} catch (e) {
				// ignore
			}
		}
	}

	for (const subnet of subnets) {
		if (serverFound || (window.api && window.api.windowId)) break;

		renderConnectionOverlay(`Scanning subnet ${subnet}.*...`);
		const batchSize = 30;

		for (let i = 1; i <= totalIps; i += batchSize) {
			if (serverFound || (window.api && window.api.windowId)) break;
			const batch = [];

			for (let j = i; j < i + batchSize && j <= totalIps; j++) {
				const ip = `${subnet}.${j}`;
				for (const p of portsToCheck) {
					batch.push(
						(async () => {
							if (serverFound || (window.api && window.api.windowId)) return;
							try {
								const res = await fetch(`http://${ip}:${p}/api/active-windows`, {
									signal: scanAbortController.signal
								});
								if (res.ok) {
									const data = await res.json();
									if (data.windows && data.windows.length > 0) {
										serverFound = true;
										scanAbortController.abort(); // Cancel other pending requests

										data.windows.forEach(w => {
											const timeStr = w.startTime ? new Date(w.startTime).toLocaleString() : 'Unknown';
											const exists = window.discoveredWindows.some(d => d.ip === ip && d.port === p && d.id === w.id);
											if (!exists) {
												window.discoveredWindows.push({
													ip,
													port: p,
													id: w.id,
													timeStr,
													cwd: w.cwd
												});
											}
										});

										renderConnectionOverlay('', window.discoveredWindows);
									}
								}
							} catch (e) {
								// ignore
							}
						})()
					);
				}
			}
			try {
				await Promise.all(batch);
			} catch (e) {
				// ignore
			}
		}
	}

	isScanning = false;
	if (!serverFound) {
		renderConnectionOverlay('Scan complete. No active Nono-Terminal servers found.');
	}
}

function logMobileEvent(type, ...args) {
	if (console[type]) {
		console[type](...args);
	} else {
		console.log(...args);
	}
	if (is_mobile && window.api && window.api.sendMobileLog) {
		const serializedArgs = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a)));
		window.api.sendMobileLog(type, serializedArgs);
	}
}
let command_history = [];
let history_index = -1;
let temp_input_text = '';
let current_cwd = '';
let active_editor_file_path = null;
let workspace_root = '';
let active_suggestions = [];
let open_command_cache = null;
let jar = null;
let editor_mode = 'edit';
let editor_file_lang = 'clike';
let is_dirty = false;
let is_loading_file = false;
let opened_from_changes = false;
let home_dir_global = '';
let pinned_dirs_global = [];

// Register custom diff language for Prism if not present
if (window.Prism && !window.Prism.languages.diff) {
	window.Prism.languages.diff = {
		coord: /^@@.*@@$/m,
		deleted: /^\-.*$/m,
		inserted: /^\+.*$/m
	};
}

const slash_commands = [
	{ name: '/clear', description: 'Clear terminal screen history' },
	{ name: '/code', description: 'Open file in VS Code' },
	{
		name: '/changes',
		description: 'Show Git changed files categorized by staged/unstaged status'
	},
	{ name: '/exit', description: 'Close current window' },
	{ name: '/fullscreen', description: 'Toggle fullscreen mode for the window' },
	{ name: '/help', description: 'Show list of available commands' },
	{ name: '/host', description: 'Show local server origin to copy/paste in Chrome flags' },
	{ name: '/open', description: 'Open a file in the inline editor' },
	{ name: '/type', description: 'Enter typing mode to send text to the remote computer' },
	{ name: '/key-shortcut', description: 'Trigger a keyboard shortcut on the remote computer (e.g. /key-shortcut shift+ctrl+b)' },
	{
		name: '/add-pin',
		description: 'Pin a directory to bookmarks (defaults to current directory if no path specified)'
	},
	{
		name: '/pins',
		description: 'Switch to a pinned directory (autocompletes pinned directories)'
	},
	{
		name: '/unpin',
		description: 'Unpin a directory (autocompletes pinned directories)'
	},
	{
		name: '/screen',
		description: 'Toggle computer screen sharing/streaming (mobile only)'
	},
	{
		name: '/shortcuts',
		description: 'List available keyboard shortcuts with descriptions'
	},
	{
		name: '/test-md',
		description: 'Simulate AI responding with markdown-debug-example.md content to test/debug markdown styling'
	},
	{
		name: '/update',
		description: 'Erase cache storage and refresh the app'
	}
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
	if (text.includes('\n')) {
		return false;
	}
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
	const matches = slash_commands.filter(cmd => cmd.name.startsWith(query));
	// Store in active_suggestions so keydown navigation matches
	active_suggestions = matches;
	return matches;
}

function renderSuggestions(filtered) {
	active_suggestions = filtered;
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
		if (cmd.isDir) {
			item.setAttribute('data-is-dir', 'true');
		}
		const colorStyle = cmd.gitStatusColor ? `style="color: ${cmd.gitStatusColor} !important;"` : '';
		item.innerHTML = `
      <span class="slash-suggestion-name" ${colorStyle}>${cmd.name}</span>
      <span class="slash-suggestion-desc">${cmd.description}</span>
    `;
		item.addEventListener('click', () => {
			if (cmd.isConnectionItem) {
				hideSuggestions();
				window.api
					.connectToHost(cmd.ip, cmd.port, cmd.winId)
					.then(() => {
						saveKnownHost(cmd.ip, cmd.port);
						appendTerminalSystemMessage('Connected successfully.');
					})
					.catch(err => {
						appendTerminalSystemMessage('Connection failed: ' + err.message);
					});
				return;
			}
			const input = document.getElementById('active-input');
			const isCommand = cmd.name.startsWith('/');
			const prefix = cmd.cmdPrefix || '/open';
			input.textContent = isCommand ? cmd.name + ' ' : prefix + ' ' + cmd.name + (cmd.isDir ? '/' : ' ');
			placeCaretAtEnd(input);
			hideSuggestions();
			input.dispatchEvent(new Event('input'));
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
	if (old_input && !old_input.textContent.trim()) {
		// Existing active input is already empty. Do not create a new one.
		if (!old_input.hasAttribute('contenteditable')) {
			old_input.setAttribute('contenteditable', 'true');
		}
		placeCaretAtEnd(old_input);
		return;
	}
	if (old_input) {
		old_input.removeAttribute('id');
		old_input.removeAttribute('contenteditable');
	}
	const old_suggestions = document.getElementById('slash-suggestions');
	if (old_suggestions) {
		old_suggestions.removeAttribute('id');
		old_suggestions.remove();
	}
	const old_send_btn = document.getElementById('send-type-btn');
	if (old_send_btn) {
		old_send_btn.removeAttribute('id');
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
	pre_input.className = 'input chat-marker';
	pre_input.id = 'active-input';
	pre_input.setAttribute('contenteditable', 'true');
	pre_input.setAttribute('spellcheck', 'false');
	pre_input.setAttribute('autocapitalize', 'none');
	pre_input.setAttribute('autocorrect', 'off');

	const send_btn = document.createElement('button');
	send_btn.className = 'send-type-btn';
	send_btn.id = 'send-type-btn';
	send_btn.innerHTML = '<span class="material-symbols-outlined">send</span>';

	const suggestions_div = document.createElement('div');
	suggestions_div.className = 'slash-suggestions';
	suggestions_div.id = 'slash-suggestions';

	chat_block.appendChild(pre_input);
	chat_block.appendChild(send_btn);
	chat_block.appendChild(suggestions_div);
	container.appendChild(chat_block);

	setupInputListeners(pre_input);
	placeCaretAtEnd(pre_input);

	// Auto-scroll window to bottom
	window.scrollTo(0, document.body.scrollHeight);
}

// Trigger Connection Suggestions for PWA remote client discovery mode
function triggerConnectionSuggestions() {
	const activeInput = document.getElementById('active-input');
	if (!activeInput) return;
	const text = activeInput.textContent.trim().toLowerCase();

	let query = text;
	if (query.startsWith('connect')) {
		query = query.substring(7).trim();
	}

	const matches = (window.discoveredWindows || [])
		.filter(w => !query || w.cwd.toLowerCase().includes(query) || String(w.id).includes(query) || w.ip.includes(query))
		.map(w => ({
			name: `connect ${w.ip} ${w.id}`,
			description: `Window #${w.id} | Started: ${w.timeStr} | Path: ${w.cwd}`,
			isConnectionItem: true,
			ip: w.ip,
			port: w.port,
			winId: w.id
		}));

	active_suggestions = matches;
	renderSuggestions(matches);
}

function handleSendTypeText() {
	const input_elem = document.getElementById('active-input');
	if (input_elem) {
		const text = input_elem.textContent;
		if (text && window.api.injectText) {
			window.api.injectText(text);
			input_elem.textContent = '';
			placeCaretAtEnd(input_elem);
		}
	}
}

// Handle inputs and keys on active prompt
function setupInputListeners(input_elem) {
	const send_btn = input_elem.parentElement ? input_elem.parentElement.querySelector('.send-type-btn') : null;
	if (send_btn) {
		send_btn.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			handleSendTypeText();
		});
	}

	input_elem.addEventListener('focus', () => {
		if (is_mobile && window.api && !window.api.windowId) {
			triggerConnectionSuggestions();
		}
	});

	input_elem.addEventListener('click', e => {
		if (input_elem.classList.contains('multi-line') || input_elem.classList.contains('typing-mode')) {
			const rect = input_elem.getBoundingClientRect();
			const clickX = e.clientX - rect.left;
			const style = window.getComputedStyle(input_elem);
			const paddingLeft = parseFloat(style.paddingLeft) || 24;
			if (clickX < paddingLeft) {
				e.preventDefault();
				e.stopPropagation();
				input_elem.classList.remove('multi-line');
				input_elem.classList.remove('typing-mode');
				placeCaretAtEnd(input_elem);
				return;
			}
		}
		if (is_mobile && window.api && !window.api.windowId) {
			triggerConnectionSuggestions();
		}
	});

	input_elem.addEventListener('mousemove', e => {
		if (input_elem.classList.contains('multi-line') || input_elem.classList.contains('typing-mode')) {
			const rect = input_elem.getBoundingClientRect();
			const clickX = e.clientX - rect.left;
			const style = window.getComputedStyle(input_elem);
			const paddingLeft = parseFloat(style.paddingLeft) || 24;
			if (clickX < paddingLeft) {
				input_elem.style.cursor = 'pointer';
			} else {
				input_elem.style.cursor = 'text';
			}
		} else {
			input_elem.style.cursor = '';
		}
	});

	input_elem.addEventListener('input', () => {
		const text = input_elem.textContent.replace(/\xa0/g, ' ');

		if (text.startsWith('/key-shortcut ') || text.startsWith('/key-shorcut ')) {
			const cmdLen = text.startsWith('/key-shortcut ') ? 14 : 13;
			const arg = text.substring(cmdLen);
			if (arg.includes(' ') || arg.includes('\xa0')) {
				const cleanArg = arg.replace(/[\s\xa0]+/g, '+');
				input_elem.textContent = text.startsWith('/key-shortcut ') ? `/key-shortcut ${cleanArg}` : `/key-shorcut ${cleanArg}`;
				placeCaretAtEnd(input_elem);
				input_elem.dispatchEvent(new Event('input'));
				return;
			}
		}

		if (text === '!') {
			input_elem.textContent = '';
			input_elem.classList.add('multi-line');
			placeCaretAtEnd(input_elem);
			// Dispatch input event to refresh suggestions/heuristics
			input_elem.dispatchEvent(new Event('input'));
			return;
		}

		if (is_mobile && window.api && !window.api.windowId) {
			triggerConnectionSuggestions();
			return;
		}

		// Toggle green/purple chevron based on shell command heuristics
		if (isShellCommand(text)) {
			input_elem.classList.remove('ai-prompt');
		} else {
			input_elem.classList.add('ai-prompt');
		}

		// Handle slash suggestions
		if (text.startsWith('/open') || text.startsWith('/code')) {
			const cmdPrefix = text.startsWith('/open') ? '/open' : '/code';
			const query = text.substring(cmdPrefix.length).trim();
			handleOpenSuggestions(query, cmdPrefix);
		} else if (text.startsWith('/pins')) {
			const query = text.substring(5).trim();
			handlePinsSuggestions(query, '/pins');
		} else if (text.startsWith('/unpin')) {
			const query = text.substring(6).trim();
			handlePinsSuggestions(query, '/unpin');
		} else if (text.startsWith('/key-shortcut') || text.startsWith('/key-shorcut')) {
			const cmdLen = text.startsWith('/key-shortcut') ? 13 : 12;
			const query = text.substring(cmdLen).trim();
			if (text.charAt(cmdLen) === ' ') {
				handleKeyShortcutSuggestions(query);
			} else {
				hideSuggestions();
			}
		} else if (text.startsWith('/') && !text.includes(' ')) {
			const filtered = getFilteredSuggestions(text.split(/\s+/)[0]);
			selected_suggestion_index = 0;
			renderSuggestions(filtered);
			open_command_cache = null;
		} else {
			hideSuggestions();
			open_command_cache = null;
		}
	});

	input_elem.addEventListener('keydown', e => {
		if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey) {
			e.preventDefault();
			input_elem.classList.add('multi-line');
			document.execCommand('insertText', false, '\n');
			return;
		}

		const suggestions_elem = document.getElementById('slash-suggestions');
		const suggestions_visible = suggestions_elem && suggestions_elem.style.display === 'flex';

		if (suggestions_visible) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				selected_suggestion_index = (selected_suggestion_index + 1) % active_suggestions.length;
				renderSuggestions(active_suggestions);
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				selected_suggestion_index = (selected_suggestion_index - 1 + active_suggestions.length) % active_suggestions.length;
				renderSuggestions(active_suggestions);
			} else if (e.key === 'Tab' || e.key === 'Enter') {
				e.preventDefault();
				const active_item = suggestions_elem.querySelector('.slash-suggestion-item.active');
				if (active_item) {
					const active_suggestion = active_suggestions[selected_suggestion_index];

					if (active_suggestion && active_suggestion.isConnectionItem) {
						hideSuggestions();
						window.api
							.connectToHost(active_suggestion.ip, active_suggestion.port, active_suggestion.winId)
							.then(() => {
								saveKnownHost(active_suggestion.ip, active_suggestion.port);
								appendTerminalSystemMessage('Connected successfully.');
							})
							.catch(err => {
								appendTerminalSystemMessage('Connection failed: ' + err.message);
							});
						return;
					}

					if (active_suggestion && active_suggestion.isKeyShortcutItem) {
						const normalizedInput = input_elem.textContent.replace(/\xa0/g, ' ');
						const cmdPrefix = normalizedInput.startsWith('/key-shortcut') ? '/key-shortcut' : '/key-shorcut';
						const suggestionCompletedText = `${cmdPrefix} ${active_suggestion.name}`;
						const currentInputText = normalizedInput.trim();

						if (e.key === 'Enter' && currentInputText.toLowerCase() === suggestionCompletedText.toLowerCase()) {
							hideSuggestions();
							submitInput(input_elem.textContent, e.ctrlKey && e.shiftKey);
							return;
						}

						input_elem.textContent = suggestionCompletedText;
						placeCaretAtEnd(input_elem);
						hideSuggestions();
						input_elem.dispatchEvent(new Event('input'));
						return;
					}

					const cmd_name = active_suggestion.name;
					const isDir = !!active_suggestion.isDir;
					const isCommand = cmd_name.startsWith('/');
					const cmdPrefix = active_suggestion && active_suggestion.cmdPrefix ? active_suggestion.cmdPrefix : '/open';
					const suggestionCompletedText = isCommand ? cmd_name : cmdPrefix + ' ' + cmd_name;
					const currentInputText = input_elem.textContent.replace(/\xa0/g, ' ').trim();

					if (e.key === 'Enter' && !isDir && currentInputText.toLowerCase() === suggestionCompletedText.toLowerCase()) {
						hideSuggestions();
						submitInput(input_elem.textContent, e.ctrlKey && e.shiftKey);
						return;
					}

					input_elem.textContent = isCommand ? cmd_name + ' ' : cmdPrefix + ' ' + cmd_name + (isDir ? '/' : ' ');
					placeCaretAtEnd(input_elem);
					hideSuggestions();
					// Dispatch input event to refresh suggestions
					input_elem.dispatchEvent(new Event('input'));
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
				if (input_elem.classList.contains('multi-line') || input_elem.classList.contains('typing-mode')) {
					document.execCommand('insertText', false, '\n');
				} else {
					submitInput(input_elem.textContent, e.ctrlKey && e.shiftKey);
				}
			} else if (e.key === 'Escape') {
				if (input_elem.classList.contains('multi-line') || input_elem.classList.contains('typing-mode')) {
					e.preventDefault();
					input_elem.classList.remove('multi-line');
					input_elem.classList.remove('typing-mode');
				}
			}
		}
	});
}

// Submit prompt or command
function submitInput(text, usePro = false) {
	const trimmed = text.replace(/\xa0/g, ' ').trim();
	if (!trimmed) return;

	if (is_mobile && window.api && !window.api.windowId) {
		const input_elem = document.getElementById('active-input');
		if (input_elem) {
			input_elem.textContent = '';
			placeCaretAtEnd(input_elem);
		}
		const parts = trimmed.split(/\s+/);
		if (parts[0] === 'connect' && parts.length >= 2) {
			const ip = parts[1];
			const winId = parts[2] || '1';
			appendTerminalSystemMessage(`Attempting connection to ${ip}:13737 (Window #${winId})...`);
			window.api
				.connectToHost(ip, '13737', winId)
				.then(() => {
					saveKnownHost(ip, '13737');
					appendTerminalSystemMessage('Connected successfully.');
				})
				.catch(err => {
					appendTerminalSystemMessage('Connection failed: ' + err.message);
				});
		} else {
			appendTerminalSystemMessage(`Unknown command: "${trimmed}". Select a suggestion or type: connect [ip] [window_id]`);
		}
		return;
	}

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
  /add-pin [path] - Pin a directory (defaults to current dir)
  /changes        - Show Git changed files (staged and changes)
  /clear          - Clear terminal screen history
  /code [path]    - Open file in VS Code
  /exit           - Close current window
  /fullscreen     - Toggle fullscreen mode
  /help           - Print this help message
  /mobile         - Share the current terminal UI with a mobile device via QR code
  /open [path]    - Open a file in the inline editor
  /pins [name]    - Switch to a pinned directory
  /type           - Enter typing mode to send text to the remote computer
  /key-shortcut [keys] - Trigger a keyboard shortcut on the remote computer (e.g. /key-shortcut shift+ctrl+b)
  /unpin [name]   - Unpin a directory
  /shortcuts      - List available keyboard shortcuts with descriptions
  /test-md        - Simulate AI responding with markdown-debug-example.md content
  /update         - Erase cache storage and refresh the app`;

			active_block.appendChild(out_pre);
			appendNewPromptBlock();
			return;
		} else if (trimmed.startsWith('/type')) {
			const activeInput = document.getElementById('active-input');
			if (activeInput) {
				activeInput.textContent = '';
				activeInput.classList.add('typing-mode');
				activeInput.setAttribute('contenteditable', 'true');
				placeCaretAtEnd(activeInput);
			}
			return;
		} else if (trimmed.startsWith('/key-shortcut') || trimmed.startsWith('/key-shorcut')) {
			const parts = trimmed.split(/\s+/);
			const arg = parts.slice(1).join('+');
			if (arg) {
				if (window.api.injectKeyShortcut) {
					window.api.injectKeyShortcut(arg);
				}
				const container = document.getElementById('terminal-chat-container');
				const active_block = document.getElementById('active-chat-block');
				const out_pre = document.createElement('pre');
				out_pre.className = 'output';
				out_pre.textContent = `Keyboard shortcut injected: ${arg}`;
				active_block.appendChild(out_pre);
				appendNewPromptBlock(current_cwd);
			} else {
				const container = document.getElementById('terminal-chat-container');
				const active_block = document.getElementById('active-chat-block');
				const out_pre = document.createElement('pre');
				out_pre.className = 'output';
				out_pre.textContent = 'Error: No keyboard shortcut specified. Usage: /key-shortcut shift+ctrl+b';
				active_block.appendChild(out_pre);
				appendNewPromptBlock(current_cwd);
			}
			return;
		} else if (trimmed.startsWith('/changes')) {
			openDiffOverlay();
			appendNewPromptBlock(current_cwd);
			return;
		} else if (trimmed.startsWith('/pins')) {
			const arg = trimmed.substring(5).trim();
			if (!arg) {
				const container = document.getElementById('terminal-chat-container');
				const active_block = document.getElementById('active-chat-block');

				const out_pre = document.createElement('pre');
				out_pre.className = 'output';
				if (pinned_dirs_global.length === 0) {
					out_pre.textContent = 'No pinned directories.';
				} else {
					out_pre.textContent = 'Pinned directories:\n' + pinned_dirs_global.map(dir => `  ${dir}`).join('\n');
				}
				active_block.appendChild(out_pre);
				appendNewPromptBlock(current_cwd);
				return;
			}

			const clean_arg = arg.replace(/[/\\]$/, '');
			const match = pinned_dirs_global.find(dir => {
				const parts = dir.split(/[/\\]/);
				const dir_name = parts.pop() || parts.pop() || dir;
				return dir_name.toLowerCase() === clean_arg.toLowerCase() || dir.toLowerCase() === clean_arg.toLowerCase();
			});

			if (match) {
				window.api.sendUserCommand(`cd "${match}"`);
			} else {
				const container = document.getElementById('terminal-chat-container');
				const active_block = document.getElementById('active-chat-block');

				const out_pre = document.createElement('pre');
				out_pre.className = 'output';
				out_pre.textContent = `Error: No matching pinned directory found for "${arg}".`;
				active_block.appendChild(out_pre);
				appendNewPromptBlock(current_cwd);
			}
			return;
		} else if (trimmed.startsWith('/unpin')) {
			const arg = trimmed.substring(6).trim();
			if (!arg) {
				const container = document.getElementById('terminal-chat-container');
				const active_block = document.getElementById('active-chat-block');

				const out_pre = document.createElement('pre');
				out_pre.className = 'output';
				out_pre.textContent = 'Usage: /unpin <directory_name_or_path>';
				active_block.appendChild(out_pre);
				appendNewPromptBlock(current_cwd);
				return;
			}

			const clean_arg = arg.replace(/[/\\]$/, '');
			const match = pinned_dirs_global.find(dir => {
				const parts = dir.split(/[/\\]/);
				const dir_name = parts.pop() || parts.pop() || dir;
				return dir_name.toLowerCase() === clean_arg.toLowerCase() || dir.toLowerCase() === clean_arg.toLowerCase();
			});

			if (match) {
				window.api.unpinDir(match).then(result => {
					const container = document.getElementById('terminal-chat-container');
					const active_block = document.getElementById('active-chat-block');

					const out_pre = document.createElement('pre');
					out_pre.className = 'output';
					if (result.success) {
						out_pre.textContent = `Successfully unpinned directory: ${match}`;
					} else {
						out_pre.textContent = `Error: ${result.error || 'Failed to unpin'}`;
					}
					active_block.appendChild(out_pre);
					appendNewPromptBlock(current_cwd);
				});
			} else {
				const container = document.getElementById('terminal-chat-container');
				const active_block = document.getElementById('active-chat-block');

				const out_pre = document.createElement('pre');
				out_pre.className = 'output';
				out_pre.textContent = `Error: No matching pinned directory found for "${arg}".`;
				active_block.appendChild(out_pre);
				appendNewPromptBlock(current_cwd);
			}
			return;
		} else if (trimmed.startsWith('/fullscreen')) {
			if (is_mobile) {
				const container = document.getElementById('terminal-chat-container');
				const active_block = document.getElementById('active-chat-block');
				const out_pre = document.createElement('pre');
				out_pre.className = 'output';

				if (!document.fullscreenElement && !document.webkitFullscreenElement) {
					const enterFS = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen || document.documentElement.msRequestFullscreen;
					if (enterFS) {
						enterFS.call(document.documentElement);
						out_pre.textContent = 'Mobile view is now fullscreen.';
					} else {
						out_pre.textContent = 'Fullscreen is not supported on this mobile device/browser.';
					}
				} else {
					const exitFS = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
					if (exitFS) {
						exitFS.call(document);
						out_pre.textContent = 'Mobile view is now windowed.';
					} else {
						out_pre.textContent = 'Failed to exit fullscreen.';
					}
				}
				active_block.appendChild(out_pre);
				appendNewPromptBlock(current_cwd);
				return;
			}
		} else if (trimmed === '/screen') {
			if (!is_mobile) {
				const container = document.getElementById('terminal-chat-container');
				const active_block = document.getElementById('active-chat-block');

				const out_pre = document.createElement('pre');
				out_pre.className = 'output';
				out_pre.textContent = 'Error: The /screen command is only available on mobile devices connection.';
				active_block.appendChild(out_pre);
				appendNewPromptBlock(current_cwd);
				return;
			}

			const container_elem = document.getElementById('screen-stream-container');
			if (container_elem) {
				const is_visible = window.getComputedStyle(container_elem).display !== 'none';
				if (is_visible) {
					container_elem.style.display = 'none';
					document.body.classList.remove('screen-active');
					if (window.api.stopScreenStream) {
						window.api.stopScreenStream();
					}

					// Reset crop and zoom variables
					currentStreamCrop = { x: 0, y: 0, w: 1, h: 1 };
					currentTargetCrop = { x: 0, y: 0, w: 1, h: 1 };
					stateHistory = [
						{
							time: Date.now(),
							crop: { x: 0, y: 0, w: 1, h: 1 },
							cursor: { x: 0.5, y: 0.5 }
						}
					];
					zoomScale = 1.0;
					normX = 0.5;
					normY = 0.5;
					viewX = 0.5;
					viewY = 0.5;
					const bgImg = document.getElementById('screen-stream-bg');
					if (bgImg) {
						bgImg.src = '';
						bgImg.style.display = 'none';
					}
					updateScreenTransform();

					// WebRTC Mobile cleanup
					if (mobilePeerConnection) {
						mobilePeerConnection.close();
						mobilePeerConnection = null;
						mobileInputChannel = null;
					}
					if (webrtcTimeout) {
						clearTimeout(webrtcTimeout);
						webrtcTimeout = null;
					}
					receivedFrameCrops = [];
					lastFrameMetadata = null;
					mediaTimeOffset = null;
					rtpTimestampOffset = null;
					streamStartTime = null;
					offsetVotes = new Map();
					mediaOffsetVotes = new Map();
					isWaitingForNewFrame = false;
					if (pendingResumeTimeout) {
						clearTimeout(pendingResumeTimeout);
						pendingResumeTimeout = null;
					}

					const videoElem = document.getElementById('screen-stream-video');
					if (videoElem) {
						videoElem.srcObject = null;
						videoElem.style.display = 'none';
						videoElem.classList.remove('waiting');
					}

					container_elem.style.display = 'none';
					container_elem.classList.remove('waiting');
					document.body.classList.remove('screen-active');

					appendTerminalSystemMessage('Screen stream stopped.');
					appendNewPromptBlock(current_cwd);
				} else {
					container_elem.style.display = 'block';
					container_elem.classList.add('waiting');
					document.body.classList.add('screen-active');

					// Reset crop and zoom variables
					currentStreamCrop = { x: 0, y: 0, w: 1, h: 1 };
					currentTargetCrop = { x: 0, y: 0, w: 1, h: 1 };
					stateHistory = [
						{
							time: Date.now(),
							crop: { x: 0, y: 0, w: 1, h: 1 },
							cursor: { x: 0.5, y: 0.5 }
						}
					];
					zoomScale = 1.0;
					normX = 0.5;
					normY = 0.5;
					viewX = 0.5;
					viewY = 0.5;
					const bgImg = document.getElementById('screen-stream-bg');
					if (bgImg) {
						bgImg.src = '';
						bgImg.style.display = 'none';
					}
					receivedFrameCrops = [];
					lastFrameMetadata = null;
					mediaTimeOffset = null;
					rtpTimestampOffset = null;
					streamStartTime = null;
					offsetVotes = new Map();
					mediaOffsetVotes = new Map();
					isWaitingForNewFrame = false;
					if (pendingResumeTimeout) {
						clearTimeout(pendingResumeTimeout);
						pendingResumeTimeout = null;
					}
					updateScreenTransform();

					const video = document.getElementById('screen-stream-video');
					if (video) {
						video.style.display = 'block';
						video.classList.add('waiting');
					}

					if (window.api.startScreenStream) {
						window.api.startScreenStream();
					}

					// Set a watchdog timeout: if WebRTC isn't connected in 5 seconds, show error and stop stream
					if (webrtcTimeout) clearTimeout(webrtcTimeout);
					webrtcTimeout = setTimeout(() => {
						if (!mobilePeerConnection || (mobilePeerConnection.iceConnectionState !== 'connected' && mobilePeerConnection.iceConnectionState !== 'completed')) {
							logMobileEvent('log', 'Mobile WebRTC: Connection timeout, stopping screen share');
							appendTerminalSystemMessage('Error: WebRTC connection timed out. Screen sharing failed.', true);
							container_elem.style.display = 'none';
							document.body.classList.remove('screen-active');
							if (window.api.stopScreenStream) {
								window.api.stopScreenStream();
							}
							if (mobilePeerConnection) {
								mobilePeerConnection.close();
								mobilePeerConnection = null;
								mobileInputChannel = null;
							}
						}
					}, 8000);

					appendTerminalSystemMessage('Screen stream started.');
					appendNewPromptBlock(current_cwd);
				}
			}
			return;
		} else if (trimmed.startsWith('/open')) {
			const pathArg = trimmed.substring(5).trim();
			handleOpenCommand(pathArg);
			return;
		} else if (trimmed.startsWith('/code')) {
			const pathArg = trimmed.substring(5).trim();
			handleCodeCommand(pathArg);
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
  Ctrl+Enter            - Insert line break in prompt (forces AI prompt mode)
  Ctrl+Shift+Enter      - Submit AI prompt using the 'pro' tier model config
  Arrow Up / Down       - Navigate input command history`;

			active_block.appendChild(out_pre);
			appendNewPromptBlock();
			return;
		} else if (trimmed.startsWith('/test-md')) {
			const active_block = document.getElementById('active-chat-block');
			const filePath = workspace_root ? `${workspace_root}/markdown-debug-example.md` : 'markdown-debug-example.md';

			window.api.readFileContent(filePath).then(result => {
				if (result.error) {
					const out_pre = document.createElement('pre');
					out_pre.className = 'output';
					out_pre.textContent = `Error reading markdown-debug-example.md: ${result.error}`;
					active_block.appendChild(out_pre);
					appendNewPromptBlock();
				} else {
					simulateAgentResponse(result.content);
				}
			});
			return;
		} else if (trimmed.startsWith('/update')) {
			const active_block = document.getElementById('active-chat-block');
			const out_pre = document.createElement('pre');
			out_pre.className = 'output';
			out_pre.textContent = 'Erasing cache storage and refreshing the app...';
			active_block.appendChild(out_pre);

			(async () => {
				try {
					if ('serviceWorker' in navigator) {
						const registrations = await navigator.serviceWorker.getRegistrations();
						for (const registration of registrations) {
							await registration.unregister();
						}
					}
					if ('caches' in window) {
						const keys = await caches.keys();
						await Promise.all(keys.map(key => caches.delete(key)));
					}
				} catch (err) {
					console.error('Error erasing cache:', err);
				} finally {
					window.location.reload();
				}
			})();
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
	if (isShellCommand(text)) {
		const active_block = document.getElementById('active-chat-block');
		active_output_block = document.createElement('pre');
		active_output_block.className = 'output';
		active_block.appendChild(active_output_block);

		window.api.sendUserCommand(trimmed);
	} else {
		// Create a waiting block to show loading state
		const container = document.getElementById('terminal-chat-container');

		active_assistant_block = document.createElement('chat-block');
		active_assistant_block.setAttribute('from', 'assistant');

		active_message_content = document.createElement('div');
		active_message_content.className = 'input msg waiting chat-marker';

		active_assistant_block.appendChild(active_message_content);
		container.appendChild(active_assistant_block);

		active_assistant_text = '';
		active_thinking_details = null;
		active_thinking_content = null;

		window.scrollTo(0, document.body.scrollHeight);

		// Send to agent loop
		window.api.sendAgentPrompt(trimmed, usePro);
	}
}

// Global hotkeys
document.addEventListener('keydown', e => {
	if (document.body.classList.contains('mobile-active')) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closeMobileModal();
			return;
		}
	}
	if (document.body.classList.contains('diff-active')) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closeDiffOverlay();
			return;
		}
	}
	if (active_editor_file_path) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closeEditor();
			return;
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
			e.preventDefault();
			saveEditorContent();
			return;
		}
	}

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

function appendTerminalSystemMessage(text, isError = false) {
	const container = document.getElementById('terminal-chat-container');
	const active_block = document.getElementById('active-chat-block');

	const chatBlock = document.createElement('chat-block');
	chatBlock.setAttribute('from', 'user');

	const systemBlock = document.createElement('pre');
	systemBlock.className = 'output';
	systemBlock.textContent = text;

	chatBlock.appendChild(systemBlock);

	if (active_block) {
		container.insertBefore(chatBlock, active_block);
	} else {
		container.appendChild(chatBlock);
	}
	window.scrollTo(0, document.body.scrollHeight);
}

// Setup initial listeners
window.addEventListener('DOMContentLoaded', () => {
	if (window.marked) {
		window.marked.use({
			walkTokens(token) {
				if (token.type === 'code') {
					const lang = token.lang ? token.lang.toLowerCase() : '';
					if (['ts', 'typescript', 'tsx'].includes(lang)) {
						token.lang = 'javascript';
					} else if (['sh', 'shell'].includes(lang)) {
						token.lang = 'bash';
					} else if (['go', 'rust', 'c', 'cpp', 'csharp', 'java', 'clike'].includes(lang)) {
						token.lang = 'clike';
					}
				}
			}
		});
	}

	// Focus the input when clicking the terminal element
	document.addEventListener('click', e => {
		if (active_editor_file_path) return;
		if (window.getSelection().toString() !== '') return;

		// The terminal input should be focused ONLY when clicking on the terminal element
		if (!e.target.closest('#terminal-chat-container')) return;

		if (e.target.closest('a, button, summary, details, .output-placeholder, [contenteditable="true"], textarea')) return;
		const active_input = document.getElementById('active-input');
		if (active_input) {
			placeCaretAtEnd(active_input);
		}
	});

	// Handle markdown file links on click
	document.addEventListener('click', e => {
		const link = e.target.closest('a');
		if (link) {
			const href = link.getAttribute('href');
			if (href && href.startsWith('file:')) {
				e.preventDefault();
				const filePath = href.substring(5); // Remove 'file:' prefix
				let resolvedPath = filePath;
				if (!filePath.startsWith('/') && workspace_root) {
					resolvedPath = workspace_root + '/' + filePath;
				}
				const useVsCode = e.ctrlKey || e.metaKey;
				if (useVsCode) {
					window.api.openInVsCode(resolvedPath).then(result => {
						if (result.error) {
							alert('Failed to open in VS Code: ' + result.error);
						}
					});
				} else {
					openEditor(resolvedPath);
				}
			}
		}
	});

	const active_input = document.getElementById('active-input');
	if (active_input) {
		setupInputListeners(active_input);
		if (!is_mobile) {
			active_input.focus();
		}
	}

	// Setup Editor Event Listeners
	const editorCode = document.getElementById('editor-code');
	if (editorCode) {
		editorCode.addEventListener('scroll', () => {
			document.getElementById('editor-line-numbers').scrollTop = editorCode.scrollTop;
		});

		// Block keyboard input and modification in diff mode, while allowing selection and copying
		editorCode.addEventListener(
			'keydown',
			e => {
				if (editor_mode === 'diff') {
					const isCopy = (e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C');
					const isNavigation = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key);
					if (!isCopy && !isNavigation) {
						e.preventDefault();
						e.stopPropagation();
					}
				}
			},
			true
		);

		editorCode.addEventListener(
			'paste',
			e => {
				if (editor_mode === 'diff') {
					e.preventDefault();
					e.stopPropagation();
				}
			},
			true
		);

		editorCode.addEventListener(
			'cut',
			e => {
				if (editor_mode === 'diff') {
					e.preventDefault();
					e.stopPropagation();
				}
			},
			true
		);

		// Initialize CodeJar with Prism syntax highlighting
		jar = CodeJar(editorCode, editor => {
			if (window.Prism) {
				window.Prism.highlightElement(editor);
			}
		});

		// Update line numbers on edits
		jar.onUpdate(code => {
			updateEditorLineNumbers(code);
			if (editor_mode === 'edit' && !is_loading_file) {
				is_dirty = true;
				const saveBtn = document.getElementById('editor-btn-save');
				if (saveBtn) saveBtn.style.display = '';
			}
		});
	}

	const toggleModeBtn = document.getElementById('editor-btn-toggle-mode');
	if (toggleModeBtn) {
		toggleModeBtn.addEventListener('click', toggleEditorMode);
	}

	const toggleLinesBtn = document.getElementById('editor-btn-toggle-lines');
	if (toggleLinesBtn) {
		toggleLinesBtn.addEventListener('click', toggleLineNumbers);
	}

	const saveBtn = document.getElementById('editor-btn-save');
	if (saveBtn) {
		saveBtn.addEventListener('click', saveEditorContent);
	}

	const closeBtn = document.getElementById('editor-btn-close');
	if (closeBtn) {
		closeBtn.addEventListener('click', closeEditor);
	}

	const mobileCloseBtn = document.getElementById('mobile-btn-close');
	if (mobileCloseBtn) {
		mobileCloseBtn.addEventListener('click', closeMobileModal);
	}

	const diffRefreshBtn = document.getElementById('diff-btn-refresh');
	if (diffRefreshBtn) {
		diffRefreshBtn.addEventListener('click', refreshDiffOverlay);
	}

	const diffCloseBtn = document.getElementById('diff-btn-close');
	if (diffCloseBtn) {
		diffCloseBtn.addEventListener('click', closeDiffOverlay);
	}

	// Request initial state on load/reload to restore session variables
	window.api.requestState();

	// Attach touch events to screen-stream-container on mobile
	const container = document.getElementById('screen-stream-container');
	if (container && is_mobile) {
		container.addEventListener(
			'touchstart',
			e => {
				e.preventDefault(); // Prevent default mobile browser pinch-zoom / double-tap zoom
				lastTouchTime = Date.now();
				if (e.touches.length === 1) {
					isDragging = true;
					isPinching = false;
					startTouchX = e.touches[0].clientX;
					startTouchY = e.touches[0].clientY;
					startNormX = normX;
					startNormY = normY;
					startViewX = viewX;
					startViewY = viewY;
				} else if (e.touches.length === 2) {
					isPinching = true;
					isDragging = false;
					startScale = zoomScale;
					const dx = e.touches[0].clientX - e.touches[1].clientX;
					const dy = e.touches[0].clientY - e.touches[1].clientY;
					startDistance = Math.sqrt(dx * dx + dy * dy);

					startMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
					startMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
					lastMidX = startMidX;
					lastMidY = startMidY;
					accumulatedScrollX = 0;
					accumulatedScrollY = 0;
					twoFingerTapCandidate = true;
					twoFingerMoveDistance = 0;
				}

				if (pendingResumeTimeout) {
					clearTimeout(pendingResumeTimeout);
					pendingResumeTimeout = null;
				}
				isWaitingForNewFrame = false;

				if (isDragging || isPinching) {
					if (mobileInputChannel && mobileInputChannel.readyState === 'open') {
						mobileInputChannel.send(JSON.stringify({ type: 'pause' }));
					}
					const videoElem = document.getElementById('screen-stream-video');
					if (videoElem) {
						videoElem.style.opacity = '0';
					}
				}
			},
			{ passive: false }
		);

		container.addEventListener(
			'touchmove',
			e => {
				lastTouchTime = Date.now();
				if (isDragging && e.touches.length === 1) {
					e.preventDefault(); // Prevent default mobile page scrolling
					const clientX = e.touches[0].clientX;
					const clientY = e.touches[0].clientY;
					const dx = clientX - startTouchX;
					const dy = clientY - startTouchY;
					const W = container.clientWidth;
					const H = container.clientHeight;
					const sensitivity = 1.0;

					const dx_norm = (dx / (W * zoomScale)) * sensitivity;
					const dy_norm = (dy / (H * zoomScale)) * sensitivity;

					normX = Math.max(0, Math.min(1, startNormX + dx_norm));
					normY = Math.max(0, Math.min(1, startNormY + dy_norm));
					viewX = Math.max(0, Math.min(1, startViewX + dx_norm));
					viewY = Math.max(0, Math.min(1, startViewY + dy_norm));

					const now = Date.now();
					if (now - lastTouchMoveTime >= 33) {
						lastTouchMoveTime = now;
						if (mobileInputChannel && mobileInputChannel.readyState === 'open') {
							mobileInputChannel.send(
								JSON.stringify({
									type: 'move',
									coords: { x: normX, y: normY }
								})
							);
						} else if (window.api.sendMouseMove) {
							window.api.sendMouseMove({ x: normX, y: normY });
						}
					}
					updateScreenTransform(false);
				} else if (isPinching && e.touches.length === 2) {
					e.preventDefault(); // Prevent default mobile page zoom

					const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
					const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
					const deltaX = midX - lastMidX;
					const deltaY = midY - lastMidY;

					lastMidX = midX;
					lastMidY = midY;

					const dx = e.touches[0].clientX - e.touches[1].clientX;
					const dy = e.touches[0].clientY - e.touches[1].clientY;
					const distance = Math.sqrt(dx * dx + dy * dy);
					const distChange = Math.abs(distance - startDistance);

					const moveDist = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
					twoFingerMoveDistance += moveDist;

					if (twoFingerMoveDistance > 10 || distChange > 15) {
						twoFingerTapCandidate = false;
					}

					// Decide scroll vs pinch zoom
					if (distChange > twoFingerMoveDistance && distChange > 15) {
						if (startDistance > 0) {
							zoomScale = startScale * (distance / startDistance);
							zoomScale = Math.max(1.0, Math.min(5.0, zoomScale));
							updateScreenTransform(false);
						}
					} else if (twoFingerMoveDistance > distChange && moveDist > 1) {
						accumulatedScrollX += deltaX;
						accumulatedScrollY += deltaY;

						const scrollThreshold = 15;
						if (Math.abs(accumulatedScrollY) >= scrollThreshold) {
							const stepsY = Math.trunc(accumulatedScrollY / scrollThreshold);
							accumulatedScrollY = accumulatedScrollY % scrollThreshold;
							sendScrollEvent(0, stepsY);
						}
						if (Math.abs(accumulatedScrollX) >= scrollThreshold) {
							const stepsX = Math.trunc(accumulatedScrollX / scrollThreshold);
							accumulatedScrollX = accumulatedScrollX % scrollThreshold;
							sendScrollEvent(stepsX, 0);
						}
					}
				}
			},
			{ passive: false }
		);

		container.addEventListener('touchend', e => {
			e.preventDefault();
			lastTouchTime = Date.now();
			const wasInteracting = isDragging || isPinching;

			if (isDragging) {
				isDragging = false;
				const now = Date.now();
				const endTouchX = e.changedTouches[0].clientX;
				const endTouchY = e.changedTouches[0].clientY;
				const moveDistance = Math.sqrt(Math.pow(endTouchX - startTouchX, 2) + Math.pow(endTouchY - startTouchY, 2));
				if (moveDistance < 10) {
					if (mobileInputChannel && mobileInputChannel.readyState === 'open') {
						mobileInputChannel.send(JSON.stringify({ type: 'click', coords: { x: normX, y: normY } }));
					} else if (window.api.sendMouseClick) {
						window.api.sendMouseClick({ x: normX, y: normY });
					}
				} else {
					// Send final coordinate update to guarantee cursor accuracy
					if (mobileInputChannel && mobileInputChannel.readyState === 'open') {
						mobileInputChannel.send(JSON.stringify({ type: 'move', coords: { x: normX, y: normY } }));
					} else if (window.api.sendMouseMove) {
						window.api.sendMouseMove({ x: normX, y: normY });
					}
				}
				lastTapTime = now;
			} else if (isPinching) {
				if (e.touches.length < 2) {
					isPinching = false;
				}
				if (twoFingerTapCandidate) {
					twoFingerTapCandidate = false;
					sendRightClickEvent(normX, normY);
				}
			}

			if (wasInteracting && !isDragging && !isPinching) {
				// The gesture has ended! Sync final transform, resume stream, and wait for the new frame
				updateScreenTransform(true);

				if (mobileInputChannel && mobileInputChannel.readyState === 'open') {
					mobileInputChannel.send(JSON.stringify({ type: 'resume' }));
				}

				isWaitingForNewFrame = true;
				if (pendingResumeTimeout) clearTimeout(pendingResumeTimeout);
				pendingResumeTimeout = setTimeout(() => {
					if (isWaitingForNewFrame) {
						isWaitingForNewFrame = false;
						const videoElem = document.getElementById('screen-stream-video');
						if (videoElem) {
							videoElem.style.opacity = '1';
						}
					}
				}, 2000);
			}
		});
	}

	if (is_mobile) {
		const rescanBtn = document.getElementById('conn-btn-refresh');
		if (rescanBtn) {
			rescanBtn.addEventListener('click', () => {
				startSubnetScan(true); // Ignore known hosts on manual refresh/rescan
			});
		}

		startSubnetScan(false); // Check known hosts first on startup
	}

	const cancelBtn = document.getElementById('cancel-task-btn');
	if (cancelBtn) {
		cancelBtn.addEventListener('click', () => {
			window.api.sendInterrupt();
			hideCancelButton();
		});
	}
});

// IPC listeners

window.api.onWindowInit(info => {
	console.log('Window initialized:', info);

	if (is_mobile) {
		document.body.classList.remove('conn-active');
	}

	if (info.windowId) {
		window.api.windowId = info.windowId;
	}
	if (info.availableCommands) {
		available_commands = new Set(info.availableCommands);
	}
	current_cwd = info.cwd || '';
	workspace_root = info.cwd || '';

	if (info.historyHtml) {
		const container = document.getElementById('terminal-chat-container');
		const active_block = document.getElementById('active-chat-block');
		if (container && active_block) {
			// Remove any existing history elements to avoid duplicates
			const children = Array.from(container.children);
			children.forEach(child => {
				if (child.id !== 'active-chat-block') {
					child.remove();
				}
			});

			// Prepend previous history right before the active block
			active_block.insertAdjacentHTML('beforebegin', info.historyHtml);
			window.scrollTo(0, document.body.scrollHeight);
		}
	}

	if (info.homeDir) {
		home_dir_global = info.homeDir;
	}
	if (info.pinnedDirs) {
		pinned_dirs_global = info.pinnedDirs;
	}
	if (is_mobile && info.displaySize && info.displaySize.width && info.displaySize.height) {
		const wrapper = document.getElementById('screen-stream-content-wrapper');
		if (wrapper) {
			wrapper.style.aspectRatio = `${info.displaySize.width} / ${info.displaySize.height}`;
		}
		document.documentElement.style.setProperty('--aspect-w', info.displaySize.width);
		document.documentElement.style.setProperty('--aspect-h', info.displaySize.height);
	}
});

window.api.onShowQrCode(({ url, qrCodeDataUrl }) => {
	const img = document.getElementById('qr-image');
	const link = document.getElementById('qr-url');
	if (img) img.src = qrCodeDataUrl;
	if (link) {
		link.href = url;
		link.textContent = url;
	}
	document.body.classList.add('mobile-active');
});

if (window.api.onHideQrCode) {
	window.api.onHideQrCode(() => {
		closeMobileModal();
	});
}

if (window.api.onConnect) {
	window.api.onConnect(() => {
		document.body.classList.remove('conn-active');
	});
}

if (window.api.onDisconnect) {
	window.api.onDisconnect(() => {
		hideCancelButton();
		document.body.classList.add('conn-active');
		renderConnectionOverlay('Disconnected from server. Reconnecting...');
		startSubnetScan();
	});
}

// WebRTC Screen Streaming Logic

let localScreenStream = null;
let desktopPeerConnections = new Map(); // socketId -> RTCPeerConnection
let mobilePeerConnection = null;
let mobileInputChannel = null;
let webrtcTimeout = null;
let currentStreamCrop = { x: 0, y: 0, w: 1, h: 1 };
let currentTargetCrop = { x: 0, y: 0, w: 1, h: 1 };
let stateHistory = [
	{
		time: Date.now(),
		crop: { x: 0, y: 0, w: 1, h: 1 },
		cursor: { x: 0.5, y: 0.5 }
	}
];

let receivedFrameCrops = [];
let lastFrameMetadata = null;
let mediaTimeOffset = null;
let rtpTimestampOffset = null;
let streamStartTime = null;
let offsetVotes = new Map();
let mediaOffsetVotes = new Map();
let isWaitingForNewFrame = false;
let pendingResumeTimeout = null;

function pushStateHistory(crop, cursor) {
	const now = Date.now();
	if (stateHistory.length > 0) {
		const last = stateHistory[stateHistory.length - 1];
		if (now - last.time > 50) {
			// Insert a constant-state entry just before now to represent the idle period
			stateHistory.push({
				time: now - 1,
				crop: { ...last.crop },
				cursor: { ...last.cursor }
			});
		}
	}
	stateHistory.push({
		time: now,
		crop: { ...crop },
		cursor: { ...cursor }
	});
	while (stateHistory.length > 1 && stateHistory[0].time < now - 3000) {
		stateHistory.shift();
	}
}

function getDelayedState(delayMs = 1000) {
	const targetTime = Date.now() - delayMs;
	if (stateHistory.length === 0) {
		return {
			crop: currentStreamCrop || { x: 0, y: 0, w: 1, h: 1 },
			cursor: { x: normX, y: normY }
		};
	}
	if (targetTime <= stateHistory[0].time) {
		return stateHistory[0];
	}
	if (targetTime >= stateHistory[stateHistory.length - 1].time) {
		return stateHistory[stateHistory.length - 1];
	}
	for (let i = 0; i < stateHistory.length - 1; i++) {
		if (targetTime >= stateHistory[i].time && targetTime <= stateHistory[i + 1].time) {
			const t0 = stateHistory[i].time;
			const t1 = stateHistory[i + 1].time;
			const ratio = (targetTime - t0) / (t1 - t0);
			const c0 = stateHistory[i].crop;
			const c1 = stateHistory[i + 1].crop;
			const cur0 = stateHistory[i].cursor;
			const cur1 = stateHistory[i + 1].cursor;
			return {
				crop: {
					x: c0.x + (c1.x - c0.x) * ratio,
					y: c0.y + (c1.y - c0.y) * ratio,
					w: c0.w + (c1.w - c0.w) * ratio,
					h: c0.h + (c1.h - c0.h) * ratio
				},
				cursor: {
					x: cur0.x + (cur1.x - cur0.x) * ratio,
					y: cur0.y + (cur1.y - cur0.y) * ratio
				}
			};
		}
	}
	return stateHistory[stateHistory.length - 1];
}

function getFrameCropFromRtpTimestamp(rtpTimestamp, mediaTime) {
	if (receivedFrameCrops.length === 0) {
		return currentStreamCrop || { x: 0, y: 0, w: 1, h: 1 };
	}

	if (rtpTimestampOffset === null) {
		const now = Date.now();
		const minArrival = now - 1500;
		const maxArrival = now - 100;

		for (let i = 0; i < receivedFrameCrops.length; i++) {
			const entry = receivedFrameCrops[i];
			if (entry.receiveTime >= minArrival && entry.receiveTime <= maxArrival) {
				const diff = rtpTimestamp - Math.round(entry.timestamp * 0.09);
				offsetVotes.set(diff, (offsetVotes.get(diff) || 0) + 1);
				if (offsetVotes.get(diff) >= 5) {
					rtpTimestampOffset = diff;
					console.log(`Sync: Locked precise RTP offset to ${rtpTimestampOffset}`);
					break;
				}
			}
		}
	}

	let activeOffset = rtpTimestampOffset;
	if (activeOffset === null) {
		const elapsed = streamStartTime ? Date.now() - streamStartTime : 1000;
		const targetArrival = Date.now() - Math.min(elapsed, 1000);
		let closestEntry = receivedFrameCrops[0];
		let minDiff = Math.abs(receivedFrameCrops[0].receiveTime - targetArrival);

		for (let i = 1; i < receivedFrameCrops.length; i++) {
			const diff = Math.abs(receivedFrameCrops[i].receiveTime - targetArrival);
			if (diff < minDiff) {
				minDiff = diff;
				closestEntry = receivedFrameCrops[i];
			}
		}
		activeOffset = rtpTimestamp - Math.round(closestEntry.timestamp * 0.09);
	}

	const targetSenderTimestamp = Math.round((rtpTimestamp - activeOffset) / 0.09);

	let bestEntry = receivedFrameCrops[0];
	let minDiff = Math.abs(receivedFrameCrops[0].timestamp - targetSenderTimestamp);

	for (let i = 1; i < receivedFrameCrops.length; i++) {
		const diff = Math.abs(receivedFrameCrops[i].timestamp - targetSenderTimestamp);
		if (diff < minDiff) {
			minDiff = diff;
			bestEntry = receivedFrameCrops[i];
		}
	}

	return bestEntry.crop;
}

function getFrameCropFromMediaTime(mediaTime) {
	if (receivedFrameCrops.length === 0) {
		return currentStreamCrop || { x: 0, y: 0, w: 1, h: 1 };
	}

	if (mediaTimeOffset === null) {
		const now = Date.now();
		const minArrival = now - 1500;
		const maxArrival = now - 100;

		for (let i = 0; i < receivedFrameCrops.length; i++) {
			const entry = receivedFrameCrops[i];
			if (entry.receiveTime >= minArrival && entry.receiveTime <= maxArrival) {
				const diff = Math.round((entry.timestamp / 1000000 - mediaTime) * 1000) / 1000;
				mediaOffsetVotes.set(diff, (mediaOffsetVotes.get(diff) || 0) + 1);
				if (mediaOffsetVotes.get(diff) >= 5) {
					mediaTimeOffset = diff;
					console.log(`Sync: Locked precise MediaTime offset to ${mediaTimeOffset}`);
					break;
				}
			}
		}
	}

	let activeOffset = mediaTimeOffset;
	if (activeOffset === null) {
		const elapsed = streamStartTime ? Date.now() - streamStartTime : 1000;
		const targetArrival = Date.now() - Math.min(elapsed, 1000);
		let closestEntry = receivedFrameCrops[0];
		let minDiff = Math.abs(receivedFrameCrops[0].receiveTime - targetArrival);

		for (let i = 1; i < receivedFrameCrops.length; i++) {
			const diff = Math.abs(receivedFrameCrops[i].receiveTime - targetArrival);
			if (diff < minDiff) {
				minDiff = diff;
				closestEntry = receivedFrameCrops[i];
			}
		}
		activeOffset = closestEntry.timestamp / 1000000 - mediaTime;
	}

	const targetSenderTimestamp = (mediaTime + activeOffset) * 1000000;

	let bestEntry = receivedFrameCrops[0];
	let minDiff = Math.abs(receivedFrameCrops[0].timestamp - targetSenderTimestamp);

	for (let i = 1; i < receivedFrameCrops.length; i++) {
		const diff = Math.abs(receivedFrameCrops[i].timestamp - targetSenderTimestamp);
		if (diff < minDiff) {
			minDiff = diff;
			bestEntry = receivedFrameCrops[i];
		}
	}

	return bestEntry.crop;
}

let desktopConnections = new Map(); // socketId -> { pc, canvas, ctx, crop, stopFrameLoop }

// Touch Navigation State
let normX = 0.5;
let normY = 0.5;
let zoomScale = 1.0;

let viewX = 0.5;
let viewY = 0.5;

let startTouchX = 0;
let startTouchY = 0;
let startNormX = 0.5;
let startNormY = 0.5;
let startViewX = 0.5;
let startViewY = 0.5;
let startDistance = 0;
let startScale = 1.0;
let isDragging = false;
let isPinching = false;
let startMidX = 0;
let startMidY = 0;
let lastMidX = 0;
let lastMidY = 0;
let accumulatedScrollX = 0;
let accumulatedScrollY = 0;
let twoFingerTapCandidate = false;
let twoFingerMoveDistance = 0;
let lastTapTime = 0;
let lastTouchMoveTime = 0;
let lastTouchTime = 0;

let lastCropSentTime = 0;
let cropPendingTimeout = null;
let pendingCropData = null;

function sendCropRegionThrottled(crop) {
	pendingCropData = crop;
	const now = Date.now();
	const interval = 100; // send at most once every 100ms

	if (now - lastCropSentTime >= interval) {
		if (cropPendingTimeout) {
			clearTimeout(cropPendingTimeout);
			cropPendingTimeout = null;
		}
		performSendCrop();
	} else {
		if (!cropPendingTimeout) {
			cropPendingTimeout = setTimeout(
				() => {
					cropPendingTimeout = null;
					performSendCrop();
				},
				interval - (now - lastCropSentTime)
			);
		}
	}
}

function sendRightClickEvent(x, y) {
	if (mobileInputChannel && mobileInputChannel.readyState === 'open') {
		mobileInputChannel.send(JSON.stringify({ type: 'right-click', coords: { x, y } }));
	} else if (window.api.sendMouseRightClick) {
		window.api.sendMouseRightClick({ x, y });
	}
}

function sendScrollEvent(dx, dy) {
	if (mobileInputChannel && mobileInputChannel.readyState === 'open') {
		mobileInputChannel.send(JSON.stringify({ type: 'scroll', delta: { x: dx, y: dy } }));
	} else if (window.api.sendMouseScroll) {
		window.api.sendMouseScroll({ x: dx, y: dy });
	}
}

function performSendCrop() {
	if (pendingCropData && is_mobile && window.api.sendCropRegion) {
		window.api.sendCropRegion(pendingCropData);
		lastCropSentTime = Date.now();
	}
}

function updateScreenTransform(sendToServer = true) {
	const container = document.getElementById('screen-stream-container');
	const wrapper = document.getElementById('screen-stream-content-wrapper');

	if (!container || !wrapper) return;

	const W = container.clientWidth;
	const H = container.clientHeight;
	const W_c = wrapper.clientWidth;
	const H_c = wrapper.clientHeight;

	if (W === 0 || H === 0 || W_c === 0 || H_c === 0) return;

	const x = viewX * W_c;
	const y = viewY * H_c;
	const s = zoomScale;

	let tx = W / 2 - x * s;
	let ty = H / 2 - y * s;

	const offsetX = (W - W_c) / 2;
	const offsetY = (H - H_c) / 2;

	let absolute_tx = offsetX + tx;
	let absolute_ty = offsetY + ty;

	if (W_c * s > W) {
		absolute_tx = Math.max(W - W_c * s, Math.min(0, absolute_tx));
	} else {
		absolute_tx = (W - W_c * s) / 2;
	}

	if (H_c * s > H) {
		absolute_ty = Math.max(H - H_c * s, Math.min(0, absolute_ty));
	} else {
		absolute_ty = (H - H_c * s) / 2;
	}

	const targetCrop = {
		x: Math.max(0, Math.min(1, -absolute_tx / (W_c * s))),
		y: Math.max(0, Math.min(1, -absolute_ty / (H_c * s))),
		w: Math.max(0, Math.min(1, W / (W_c * s))),
		h: Math.max(0, Math.min(1, H / (H_c * s)))
	};

	currentTargetCrop = targetCrop;
	pushStateHistory(targetCrop, { x: normX, y: normY });

	if (sendToServer && is_mobile && window.api.sendCropRegion) {
		sendCropRegionThrottled(targetCrop);
	}
}

function renderCssTransform() {
	const container = document.getElementById('screen-stream-container');
	const wrapper = document.getElementById('screen-stream-content-wrapper');
	const content = document.getElementById('screen-stream-content');
	const activeElem = document.getElementById('screen-stream-video');

	if (!container || !wrapper || !content || !activeElem) return;

	const W = container.clientWidth;
	const H = container.clientHeight;
	const W_c = wrapper.clientWidth;
	const H_c = wrapper.clientHeight;

	if (W === 0 || H === 0 || W_c === 0 || H_c === 0) return;

	const x = viewX * W_c;
	const y = viewY * H_c;
	const s = zoomScale;

	let tx = W / 2 - x * s;
	let ty = H / 2 - y * s;

	const offsetX = (W - W_c) / 2;
	const offsetY = (H - H_c) / 2;

	let absolute_tx = offsetX + tx;
	let absolute_ty = offsetY + ty;

	if (W_c * s > W) {
		absolute_tx = Math.max(W - W_c * s, Math.min(0, absolute_tx));
	} else {
		absolute_tx = (W - W_c * s) / 2;
	}

	if (H_c * s > H) {
		absolute_ty = Math.max(H - H_c * s, Math.min(0, absolute_ty));
	} else {
		absolute_ty = (H - H_c * s) / 2;
	}

	tx = absolute_tx - offsetX;
	ty = absolute_ty - offsetY;

	// Apply camera transform to the content container
	content.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;

	// Retrieve the crop region representing the frame currently displayed on screen.
	// Prefer using requestVideoFrameCallback metadata to find the exact frame's crop region,
	// falling back to getDelayedState(1000) if metadata is not available yet.
	let frameCrop;
	if (lastFrameMetadata) {
		if (lastFrameMetadata.rtpTimestamp !== undefined) {
			frameCrop = getFrameCropFromRtpTimestamp(lastFrameMetadata.rtpTimestamp, lastFrameMetadata.mediaTime);
		} else {
			frameCrop = getFrameCropFromMediaTime(lastFrameMetadata.mediaTime);
		}
	} else {
		frameCrop = getDelayedState(1000).crop;
	}

	// Update video element position and scale relative to the virtual desktop
	activeElem.style.left = `${frameCrop.x * 100}%`;
	activeElem.style.top = `${frameCrop.y * 100}%`;
	activeElem.style.width = `${frameCrop.w * 100}%`;
	activeElem.style.height = `${frameCrop.h * 100}%`;

	if (isWaitingForNewFrame) {
		const dx = Math.abs(frameCrop.x - currentTargetCrop.x);
		const dy = Math.abs(frameCrop.y - currentTargetCrop.y);
		const dw = Math.abs(frameCrop.w - currentTargetCrop.w);
		const dh = Math.abs(frameCrop.h - currentTargetCrop.h);
		if (dx < 0.01 && dy < 0.01 && dw < 0.01 && dh < 0.01) {
			isWaitingForNewFrame = false;
			if (pendingResumeTimeout) {
				clearTimeout(pendingResumeTimeout);
				pendingResumeTimeout = null;
			}
			activeElem.style.opacity = '1';
		}
	}

	// Log synchronization details occasionally to assist in debugging
	if (lastFrameMetadata && lastFrameMetadata.presentedFrames % 100 === 0) {
		console.log(`Sync: rtpTimestamp=${lastFrameMetadata.rtpTimestamp}, mediaTime=${lastFrameMetadata.mediaTime.toFixed(3)}, rtpOffset=${rtpTimestampOffset}, matchedCrop=x:${frameCrop.x.toFixed(3)} y:${frameCrop.y.toFixed(3)}`);
	}

	// Position the cursor relative to the virtual desktop
	const cursorElem = document.getElementById('screen-stream-cursor');
	if (cursorElem) {
		if (container.style.display === 'none') {
			cursorElem.style.display = 'none';
		} else {
			cursorElem.style.display = 'block';
			cursorElem.style.left = `${normX * 100}%`;
			cursorElem.style.top = `${normY * 100}%`;
			cursorElem.style.transform = `scale(${1 / s})`;
		}
	}
}

// Sync initial cursor coordinates
if (window.api.onCursorSync) {
	window.api.onCursorSync(({ x, y }) => {
		if (isDragging || isPinching || Date.now() - lastTouchTime < 1000) return;
		normX = x;
		normY = y;
	});
}

// Update position on orientation change / resize
if (is_mobile) {
	window.addEventListener('resize', () => updateScreenTransform(true));
	if (window.api.onStreamCropUpdated) {
		window.api.onStreamCropUpdated(({ region }) => {
			setTimeout(() => {
				currentStreamCrop = region;
				if (!isDragging && !isPinching && Date.now() - lastTouchTime > 1000) {
					currentTargetCrop = region;
					pushStateHistory(region, { x: normX, y: normY });
					zoomScale = 1 / (region.w || 1);
					viewX = region.x + region.w / 2;
					viewY = region.y + region.h / 2;
				}
			}, 120);
		});
	}

	if (window.api.onScreenBgUpdated) {
		window.api.onScreenBgUpdated(({ bg }) => {
			const bgImg = document.getElementById('screen-stream-bg');
			if (bgImg) {
				bgImg.src = bg;
				bgImg.style.display = 'block';
			}
		});
	}

	// Set up the requestVideoFrameCallback watcher to capture video frame presentation timestamps
	const videoElem = document.getElementById('screen-stream-video');
	if (videoElem) {
		const updateFrameMetadata = (now, metadata) => {
			lastFrameMetadata = metadata;
			if (videoElem.requestVideoFrameCallback) {
				videoElem.requestVideoFrameCallback(updateFrameMetadata);
			}
		};
		if (videoElem.requestVideoFrameCallback) {
			videoElem.requestVideoFrameCallback(updateFrameMetadata);
		}
	}

	// Start the 60fps local transform & cursor update loop
	function step() {
		renderCssTransform();
		requestAnimationFrame(step);
	}
	requestAnimationFrame(step);
}

function mungeSdpToForceH264(sdp) {
	return sdp;
}

if (!is_mobile) {
	// Desktop (Sender) WebRTC implementation
	if (window.api.onStartScreenStream) {
		window.api.onStartScreenStream(async ({ socketId }) => {
			console.log('Desktop WebRTC: received start-screen-stream for socket:', socketId);
			try {
				if (desktopPeerConnections.has(socketId)) {
					desktopPeerConnections.get(socketId).close();
					desktopPeerConnections.delete(socketId);
				}

				if (desktopConnections.has(socketId)) {
					const conn = desktopConnections.get(socketId);
					if (conn.pc) conn.pc.close();
					if (conn.stopFrameLoop) conn.stopFrameLoop();
					desktopConnections.delete(socketId);
				}

				if (!localScreenStream) {
					const screenInfo = await window.api.getScreenSourceId();
					const sourceId = screenInfo ? screenInfo.id : null;
					const screenW = screenInfo ? screenInfo.width : 1920;
					const screenH = screenInfo ? screenInfo.height : 1080;
					console.log(`Desktop WebRTC: Capturing display at native resolution ${screenW}x${screenH}`);

					localScreenStream = await navigator.mediaDevices.getUserMedia({
						audio: false,
						video: {
							mandatory: {
								chromeMediaSource: 'desktop',
								chromeMediaSourceId: sourceId,
								minWidth: screenW,
								maxWidth: screenW,
								minHeight: screenH,
								maxHeight: screenH,
								maxFrameRate: 30
							}
						}
					});
				}

				if (!window.desktopVideoElement) {
					window.desktopVideoElement = document.createElement('video');
					window.desktopVideoElement.muted = true;
					window.desktopVideoElement.playsInline = true;
					window.desktopVideoElement.style.display = 'none';
					document.body.appendChild(window.desktopVideoElement);
				}

				if (window.desktopVideoElement.srcObject !== localScreenStream) {
					window.desktopVideoElement.srcObject = localScreenStream;
					await window.desktopVideoElement.play().catch(e => {
						console.error('Desktop WebRTC: Failed to play local video element:', e);
					});
				}

				const connObj = {
					pc: null,
					crop: { x: 0, y: 0, w: 1, h: 1 },
					stopFrameLoop: null,
					bgInterval: null,
					inputChannel: null,
					paused: false
				};
				desktopConnections.set(socketId, connObj);

				const pc = new RTCPeerConnection({
					iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
				});
				connObj.pc = pc;
				desktopPeerConnections.set(socketId, pc);

				// WebRTC Data Channel setup for mouseInput
				const inputChannel = pc.createDataChannel('mouseInput');
				connObj.inputChannel = inputChannel;

				inputChannel.onmessage = msgEvent => {
					try {
						const data = JSON.parse(msgEvent.data);
						if (data.type === 'move') {
							window.api.injectMouseMove(data.coords);
						} else if (data.type === 'click') {
							window.api.injectMouseClick(data.coords);
						} else if (data.type === 'right-click') {
							window.api.injectMouseRightClick(data.coords);
						} else if (data.type === 'scroll') {
							window.api.injectMouseScroll(data.delta);
						} else if (data.type === 'pause') {
							connObj.paused = true;
							sendBgScreenshot();
						} else if (data.type === 'resume') {
							connObj.paused = false;
						}
					} catch (e) {
						console.error('Failed to parse data channel message:', e);
					}
				};

				// WebCodecs crop and generator pipeline
				const videoTrack = localScreenStream.getVideoTracks()[0];
				const trackProcessor = new MediaStreamTrackProcessor({
					track: videoTrack
				});
				const trackGenerator = new MediaStreamTrackGenerator({ kind: 'video' });

				const reader = trackProcessor.readable.getReader();
				const writer = trackGenerator.writable.getWriter();

				const outputStream = new MediaStream([trackGenerator]);
				outputStream.getTracks().forEach(track => pc.addTrack(track, outputStream));

				let frameLoopActive = true;
				connObj.stopFrameLoop = () => {
					frameLoopActive = false;
				};

				let frameCount = 0;
				let lastFrameTime = 0;
				async function processFrames() {
					try {
						while (frameLoopActive) {
							const { value: frame, done } = await reader.read();
							if (done || !frameLoopActive) {
								if (frame) frame.close();
								break;
							}
							if (!desktopConnections.has(socketId)) {
								frame.close();
								break;
							}
							if (connObj.paused) {
								frame.close();
								await new Promise(resolve => setTimeout(resolve, 50));
								continue;
							}
							const now = Date.now();
							if (now - lastFrameTime < 30) {
								frame.close();
								continue;
							}
							lastFrameTime = now;
							if (frameCount === 0) {
								console.log('Desktop WebRTC: Successfully received first frame from track processor!');
							}
							frameCount++;

							const crop = connObj.crop || { x: 0, y: 0, w: 1, h: 1 };
							let cropX = Math.round(crop.x * frame.codedWidth);
							let cropY = Math.round(crop.y * frame.codedHeight);
							let cropW = Math.round(crop.w * frame.codedWidth);
							let cropH = Math.round(crop.h * frame.codedHeight);

							// Force even dimensions to comply with YUV 4:2:0 subsampling alignment
							cropX = Math.floor(cropX / 2) * 2;
							cropY = Math.floor(cropY / 2) * 2;
							cropW = Math.floor(cropW / 2) * 2;
							cropH = Math.floor(cropH / 2) * 2;

							cropX = Math.max(0, Math.min(frame.codedWidth - 2, cropX));
							cropY = Math.max(0, Math.min(frame.codedHeight - 2, cropY));
							cropW = Math.max(2, Math.min(frame.codedWidth - cropX, cropW));
							cropH = Math.max(2, Math.min(frame.codedHeight - cropY, cropH));

							const options = {
								visibleRect: {
									x: cropX,
									y: cropY,
									width: cropW,
									height: cropH
								}
							};

							const targetW = 1920;
							const ratio = targetW / cropW;
							options.displayWidth = targetW;
							let targetH = Math.max(2, Math.round(cropH * ratio));
							if (targetH % 2 !== 0) {
								targetH--;
							}
							options.displayHeight = targetH;

							const croppedFrame = new VideoFrame(frame, options);
							if (connObj.inputChannel && connObj.inputChannel.readyState === 'open') {
								try {
									connObj.inputChannel.send(
										JSON.stringify({
											type: 'frame-crop',
											timestamp: frame.timestamp,
											crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h }
										})
									);
								} catch (e) {
									console.error('Desktop WebRTC: Failed to send frame crop via data channel:', e);
								}
							}
							await writer.write(croppedFrame);
							frame.close();
						}
					} catch (err) {
						console.error('Frame processing loop error:', err);
					} finally {
						try {
							reader.releaseLock();
							writer.releaseLock();
						} catch (e) {}
					}
				}

				processFrames();

				function sendBgScreenshot() {
					if (window.desktopVideoElement && window.desktopVideoElement.readyState >= 2) {
						if (!window.desktopBgCanvas) {
							window.desktopBgCanvas = document.createElement('canvas');
						}
						const canvas = window.desktopBgCanvas;
						const video = window.desktopVideoElement;
						if (video.videoWidth > 0 && video.videoHeight > 0) {
							canvas.width = 1920;
							canvas.height = Math.round(1920 * (video.videoHeight / video.videoWidth));
							const ctx = canvas.getContext('2d');
							ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
							const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.85);
							if (window.api.sendScreenBg) {
								window.api.sendScreenBg(socketId, jpegDataUrl);
							}
						}
					}
				}

				setTimeout(sendBgScreenshot, 1000);

				pc.onicecandidate = event => {
					if (event.candidate) {
						console.log('Desktop WebRTC: Generated ICE candidate:', event.candidate.candidate);
						window.api.sendWebRtcSignalToMobile(socketId, {
							candidate: {
								candidate: event.candidate.candidate,
								sdpMid: event.candidate.sdpMid,
								sdpMLineIndex: event.candidate.sdpMLineIndex,
								usernameFragment: event.candidate.usernameFragment
							}
						});
					} else {
						console.log('Desktop WebRTC: ICE candidate gathering complete.');
					}
				};

				pc.oniceconnectionstatechange = () => {
					console.log('Desktop WebRTC: ICE Connection state changed to:', pc.iceConnectionState);
				};
				pc.onconnectionstatechange = () => {
					console.log('Desktop WebRTC: Peer Connection state changed to:', pc.connectionState);
				};
				pc.onicecandidateerror = event => {
					console.error('Desktop WebRTC: ICE Candidate error:', event.errorCode, event.errorText);
				};

				const offer = await pc.createOffer();
				const mungedOffer = new RTCSessionDescription({
					type: offer.type,
					sdp: mungeSdpToForceH264(offer.sdp)
				});
				await pc.setLocalDescription(mungedOffer);
				window.api.sendWebRtcSignalToMobile(socketId, {
					sdp: {
						type: mungedOffer.type,
						sdp: mungedOffer.sdp
					}
				});
			} catch (err) {
				console.error('Desktop WebRTC setup failed:', err);
			}
		});
	}

	if (window.api.onStopScreenStream) {
		window.api.onStopScreenStream(({ socketId }) => {
			console.log('Desktop WebRTC: stopping stream for socket:', socketId);
			const conn = desktopConnections.get(socketId);
			if (conn) {
				if (conn.pc) conn.pc.close();
				if (conn.stopFrameLoop) conn.stopFrameLoop();
				if (conn.bgInterval) clearInterval(conn.bgInterval);
				desktopConnections.delete(socketId);
			}
			const pc = desktopPeerConnections.get(socketId);
			if (pc) {
				pc.close();
				desktopPeerConnections.delete(socketId);
			}
			if (desktopPeerConnections.size === 0 && localScreenStream) {
				localScreenStream.getTracks().forEach(track => track.stop());
				localScreenStream = null;
			}
		});
	}

	if (window.api.onUpdateCropRegion) {
		window.api.onUpdateCropRegion(({ socketId, region }) => {
			const conn = desktopConnections.get(socketId);
			if (conn) {
				conn.crop = region;
				if (window.api.sendStreamCropUpdated) {
					window.api.sendStreamCropUpdated(socketId, region);
				}
			}
		});
	}

	if (window.api.onWebRtcSignal) {
		window.api.onWebRtcSignal(({ socketId, signal }) => {
			const pc = desktopPeerConnections.get(socketId);
			if (!pc) return;

			if (signal.sdp) {
				const mungedSdp = new RTCSessionDescription({
					type: signal.sdp.type,
					sdp: mungeSdpToForceH264(signal.sdp.sdp)
				});
				pc.setRemoteDescription(mungedSdp).catch(err => console.error('Desktop: failed to set remote description:', err));
			} else if (signal.candidate) {
				console.log('Desktop WebRTC: adding remote ICE candidate:', signal.candidate.candidate);
				pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(err => console.error('Desktop: failed to add ICE candidate:', err));
			}
		});
	}
} else {
	// Mobile (Receiver) WebRTC implementation
	if (window.api.onWebRtcSignal) {
		window.api.onWebRtcSignal(async ({ signal }) => {
			logMobileEvent('log', 'Mobile WebRTC: received signal:', signal);
			try {
				if (signal.sdp && signal.sdp.type === 'offer') {
					if (mobilePeerConnection) {
						mobilePeerConnection.close();
					}

					mobilePeerConnection = new RTCPeerConnection({
						iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
					});

					// Set up Mobile input data channel handler
					mobilePeerConnection.ondatachannel = event => {
						const channel = event.channel;
						if (channel.label === 'mouseInput') {
							mobileInputChannel = channel;
							logMobileEvent('log', 'Mobile WebRTC: Input channel connected');

							channel.onmessage = msgEvent => {
								try {
									const data = JSON.parse(msgEvent.data);
									if (data.type === 'frame-crop') {
										receivedFrameCrops.push({
											timestamp: data.timestamp,
											crop: data.crop,
											receiveTime: Date.now()
										});
										if (receivedFrameCrops.length > 300) {
											receivedFrameCrops.shift();
										}
									}
								} catch (e) {
									// ignore
								}
							};
						}
					};

					mobilePeerConnection.onicecandidate = event => {
						if (event.candidate) {
							logMobileEvent('log', 'Mobile WebRTC: Generated ICE candidate:', event.candidate.candidate);
							if (window.api.sendWebRtcSignal) {
								window.api.sendWebRtcSignal({
									candidate: {
										candidate: event.candidate.candidate,
										sdpMid: event.candidate.sdpMid,
										sdpMLineIndex: event.candidate.sdpMLineIndex,
										usernameFragment: event.candidate.usernameFragment
									}
								});
							}
						} else {
							logMobileEvent('log', 'Mobile WebRTC: ICE candidate gathering complete.');
						}
					};

					mobilePeerConnection.onicecandidateerror = event => {
						logMobileEvent('error', 'Mobile WebRTC: ICE Candidate error:', event.errorCode, event.errorText);
					};

					mobilePeerConnection.onconnectionstatechange = () => {
						logMobileEvent('log', 'Mobile WebRTC: Peer Connection state changed to:', mobilePeerConnection.connectionState);
					};

					mobilePeerConnection.oniceconnectionstatechange = () => {
						logMobileEvent('log', 'Mobile WebRTC: Connection state changed to:', mobilePeerConnection.iceConnectionState);
						if (mobilePeerConnection.iceConnectionState === 'connected' || mobilePeerConnection.iceConnectionState === 'completed') {
							if (webrtcTimeout) {
								clearTimeout(webrtcTimeout);
								webrtcTimeout = null;
							}
							const video = document.getElementById('screen-stream-video');
							if (video) video.style.display = 'block';
						}
					};

					mobilePeerConnection.ontrack = event => {
						logMobileEvent('log', 'Mobile WebRTC: received track');
						const receiver = event.receiver;
						if (receiver && 'playoutDelayHint' in receiver) {
							receiver.playoutDelayHint = 1.0;
						}
						const videoElem = document.getElementById('screen-stream-video');
						if (videoElem) {
							videoElem.srcObject = event.streams[0];
							streamStartTime = Date.now();
							videoElem.play().catch(err => logMobileEvent('error', 'Mobile play failed:', err));
						}
					};

					// Apply remote offer (SDP munged to force H.264)
					const mungedOffer = new RTCSessionDescription({
						type: signal.sdp.type,
						sdp: mungeSdpToForceH264(signal.sdp.sdp)
					});
					await mobilePeerConnection.setRemoteDescription(mungedOffer);
					const answer = await mobilePeerConnection.createAnswer();
					const mungedAnswer = new RTCSessionDescription({
						type: answer.type,
						sdp: mungeSdpToForceH264(answer.sdp)
					});
					await mobilePeerConnection.setLocalDescription(mungedAnswer);

					if (window.api.sendWebRtcSignal) {
						window.api.sendWebRtcSignal({
							sdp: {
								type: mungedAnswer.type,
								sdp: mungedAnswer.sdp
							}
						});
					}
				} else if (signal.candidate && mobilePeerConnection) {
					logMobileEvent('log', 'Mobile WebRTC: adding remote ICE candidate:', signal.candidate.candidate);
					await mobilePeerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(err => logMobileEvent('error', 'Mobile: failed to add ICE candidate:', err));
				}
			} catch (err) {
				logMobileEvent('error', 'Mobile WebRTC processing failed:', err);
			}
		});
	}
}

function closeMobileModal() {
	document.body.classList.remove('mobile-active');
}

window.api.onShellCommandStart(({ command }) => {
	showCancelButton();
	const input_elem = document.getElementById('active-input');
	if (input_elem && input_elem.hasAttribute('contenteditable')) {
		input_elem.textContent = command;
		input_elem.removeAttribute('contenteditable');
		input_elem.classList.remove('ai-prompt');

		const active_block = document.getElementById('active-chat-block');
		active_output_block = document.createElement('pre');
		active_output_block.className = 'output';
		active_block.appendChild(active_output_block);

		hideSuggestions();
	}
});

window.api.onAgentPromptStart(({ prompt, usePro }) => {
	showCancelButton();
	const input_elem = document.getElementById('active-input');
	if (input_elem && input_elem.hasAttribute('contenteditable')) {
		input_elem.textContent = prompt;
		input_elem.removeAttribute('contenteditable');
		input_elem.classList.add('ai-prompt');

		const container = document.getElementById('terminal-chat-container');

		active_assistant_block = document.createElement('chat-block');
		active_assistant_block.setAttribute('from', 'assistant');

		active_message_content = document.createElement('div');
		active_message_content.className = 'input msg waiting chat-marker';

		active_assistant_block.appendChild(active_message_content);
		container.appendChild(active_assistant_block);

		active_assistant_text = '';
		active_thinking_details = null;
		active_thinking_content = null;

		window.scrollTo(0, document.body.scrollHeight);
		hideSuggestions();
	}
});

window.api.onShellOutput(data => {
	if (active_output_block) {
		active_output_block.textContent += data.text;
		window.scrollTo(0, document.body.scrollHeight);
	}
});

window.api.onShellComplete(info => {
	hideCancelButton();
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

window.api.onAgentStatus(status => {
	console.log('Agent status:', status);
});

window.api.onAgentChunk(info => {
	// Create assistant message block if needed
	if (!active_assistant_block) {
		const container = document.getElementById('terminal-chat-container');

		active_assistant_block = document.createElement('chat-block');
		active_assistant_block.setAttribute('from', 'assistant');

		active_message_content = document.createElement('div');
		active_message_content.className = 'input msg chat-marker';

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
			summary.className = 'chat-marker';
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

	if (window.marked) {
		active_message_content.innerHTML = window.marked.parse(parsed.content);
		if (window.Prism) {
			window.Prism.highlightAllUnder(active_message_content);
		}
	} else {
		active_message_content.textContent = parsed.content;
	}

	// Automatically collapse reasoning/thinking block when real content starts coming
	if (parsed.content && active_thinking_details && active_thinking_details.open && !active_thinking_details.dataset.collapsedAutomatically) {
		active_thinking_details.open = false;
		active_thinking_details.dataset.collapsedAutomatically = 'true';
	}

	window.scrollTo(0, document.body.scrollHeight);
});

window.api.onAgentToolStart(info => {
	// Stop waiting state of current assistant message segment
	if (active_assistant_block && active_message_content) {
		if (active_message_content.classList.contains('waiting')) {
			active_message_content.classList.remove('waiting');
		}
		if (!active_message_content.textContent && !active_thinking_details) {
			active_assistant_block.remove();
		}
	}
	active_assistant_block = null;

	const container = document.getElementById('terminal-chat-container');
	const chat_block = document.createElement('chat-block');
	chat_block.setAttribute('from', 'assistant');

	if (info.name === 'execute_command') {
		// Show command as an input block
		const pre_input = document.createElement('pre');
		pre_input.className = 'input chat-marker';
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
		pre_status.className = 'input chat-marker';
		pre_status.dataset.toolCallId = info.tool_call_id;

		let label = '';
		if (info.name === 'read_file') label = `Reading ${info.args.path}`;
		else if (info.name === 'edit_file') label = `Editing ${info.args.path}`;
		else if (info.name === 'search_codebase') label = `Searching codebase for "${info.args.query}"`;
		else if (info.name === 'list_directory') label = `Listing directory ${info.args.path || '.'}`;
		else if (info.name === 'web_search') label = `Searching the web for "${info.args.query}"`;
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
	const active_tool_elem = container.querySelector(`pre.input[data-tool-call-id="${info.tool_call_id}"]`);

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
	hideCancelButton();
	console.log('AI Response:', {
		raw: active_assistant_text,
		parsed: parseThinkingAndContent(active_assistant_text)
	});
	if (active_assistant_block && active_message_content) {
		active_message_content.classList.remove('waiting');
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
	let dirPath = '.';
	let filePrefix = query;

	const lastSlashIndex = query.lastIndexOf('/');
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
				items: result.items
			};
		} else {
			open_command_cache = null;
		}
	}

	if (open_command_cache && open_command_cache.items) {
		const matches = open_command_cache.items.filter(item => item.name.toLowerCase().startsWith(filePrefix.toLowerCase()));

		// Fetch git status to color suggestions
		const gitStatus = await window.api.readGitStatus();
		const staged = (gitStatus && gitStatus.staged) || [];
		const unstaged = (gitStatus && gitStatus.unstaged) || [];

		const suggestions = matches.map(item => {
			const pathPrefix = lastSlashIndex !== -1 ? query.substring(0, lastSlashIndex + 1) : '';

			// Resolve absolute path and then relative path for git status matching
			const itemAbsPath = open_command_cache.resolved + '/' + item.name;
			let relPath = itemAbsPath;
			if (workspace_root) {
				if (relPath.startsWith(workspace_root)) {
					relPath = relPath.substring(workspace_root.length);
				}
				if (relPath.startsWith('/')) {
					relPath = relPath.substring(1);
				}
			}

			// Determine git status color
			let gitStatusColor = 'var(--white)'; // default to white

			// Look up in staged and unstaged changes
			const isStaged = staged.find(f => f.path === relPath);
			const isUnstaged = unstaged.find(f => f.path === relPath);
			const fileStatus = isStaged || isUnstaged;

			if (fileStatus) {
				if (fileStatus.type === 'addition') {
					gitStatusColor = 'var(--green)';
				} else {
					gitStatusColor = 'var(--blue-soft)';
				}
			}

			return {
				name: pathPrefix + item.name,
				description: item.is_directory ? 'Directory' : formatBytes(item.size),
				isDir: item.is_directory,
				cmdPrefix: commandName,
				gitStatusColor: gitStatusColor
			};
		});

		selected_suggestion_index = Math.min(selected_suggestion_index, Math.max(0, suggestions.length - 1));
		renderSuggestions(suggestions);
	} else {
		hideSuggestions();
	}
}

function handlePinsSuggestions(query, cmdPrefix = '/pins') {
	const matches = pinned_dirs_global.filter(dir => {
		const parts = dir.split(/[/\\]/);
		const dir_name = parts.pop() || parts.pop() || dir;
		return dir_name.toLowerCase().includes(query.toLowerCase()) || dir.toLowerCase().includes(query.toLowerCase());
	});

	const suggestions = matches.map(dir => {
		const parts = dir.split(/[/\\]/);
		const dir_name = parts.pop() || parts.pop() || dir;
		return {
			name: dir_name,
			description: dir,
			path: dir,
			isDir: true,
			cmdPrefix: cmdPrefix
		};
	});

	selected_suggestion_index = Math.min(selected_suggestion_index, Math.max(0, suggestions.length - 1));
	renderSuggestions(suggestions);
}

function handleKeyShortcutSuggestions(query) {
	const lastPlusIndex = query.lastIndexOf('+');
	const typedPrefix = lastPlusIndex === -1 ? '' : query.substring(0, lastPlusIndex + 1);
	const currentKeyTyped = lastPlusIndex === -1 ? query : query.substring(lastPlusIndex + 1);

	const available = ["ctrl", "shift", "alt", "super", "escape", "enter", "space", "tab", "backspace", "delete", "insert", "pageup", "pagedown", "home", "end", "up", "down", "left", "right"];
	const matches = available.filter(k => k.startsWith(currentKeyTyped.toLowerCase()));

	const suggestions = matches.map(m => {
		const completed = typedPrefix + m;
		return {
			name: completed,
			description: `Shortcut: ${completed}`,
			isKeyShortcutItem: true
		};
	});

	selected_suggestion_index = Math.min(selected_suggestion_index, Math.max(0, suggestions.length - 1));
	renderSuggestions(suggestions);
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
		alert('Failed to open VS Code: ' + result.error);
	}
}

function formatBytes(bytes) {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function openEditor(filePath, fromChanges = false) {
	const editorCode = document.getElementById('editor-code');
	const lineNumbers = document.getElementById('editor-line-numbers');
	const pathSpan = document.getElementById('editor-file-path');
	const overlay = document.getElementById('editor-overlay');
	const saveBtn = document.getElementById('editor-btn-save');
	const toggleIcon = document.getElementById('editor-toggle-icon');
	const toggleText = document.getElementById('editor-toggle-text');

	is_dirty = false;
	is_loading_file = true;
	opened_from_changes = fromChanges;

	window.editorDiffState = {
		added: new Set(),
		modified: new Set(),
		deletedBefore: new Set(),
		deletedAfter: new Set()
	};

	if (overlay) overlay.classList.remove('lines-hidden');
	const toggleLinesBtn = document.getElementById('editor-btn-toggle-lines');
	if (toggleLinesBtn) toggleLinesBtn.style.opacity = '';

	pathSpan.textContent = 'Loading ' + filePath + '...';
	if (jar) jar.updateCode('');
	if (lineNumbers) lineNumbers.textContent = '1';

	document.body.classList.add('editor-active');

	const result = await window.api.readFileContent(filePath);
	if (result.error) {
		pathSpan.textContent = 'Error: ' + result.error;
		if (jar) jar.updateCode('Failed to load file content:\n' + result.error);
		is_loading_file = false;
		return;
	}

	active_editor_file_path = result.resolved;
	pathSpan.textContent = result.resolved;

	// Detect language
	const ext = result.resolved.split('.').pop().toLowerCase();
	let lang = 'clike';
	if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext)) lang = 'javascript';
	else if (['py'].includes(ext)) lang = 'python';
	else if (['json'].includes(ext)) lang = 'json';
	else if (['sh', 'bash'].includes(ext)) lang = 'bash';
	else if (['html', 'xml', 'svg'].includes(ext)) lang = 'markup';
	else if (['css'].includes(ext)) lang = 'css';
	else if (['md', 'markdown'].includes(ext)) lang = 'markdown';

	editor_file_lang = lang;

	if (fromChanges) {
		editor_mode = 'diff';
		editorCode.setAttribute('contenteditable', 'false');
		editorCode.className = 'editor-code language-diff';
		if (saveBtn) saveBtn.style.display = 'none';
		if (toggleIcon) toggleIcon.textContent = 'edit_note';
		if (toggleText) toggleText.textContent = 'Edit Mode';

		if (lineNumbers) {
			lineNumbers.style.fontFamily = "'Consolas', monospace";
			lineNumbers.style.textAlign = 'left';
		}

		await updateScrollbarDecorations();
	} else {
		editor_mode = 'edit';
		editorCode.setAttribute('contenteditable', 'plaintext-only');
		editorCode.className = 'editor-code language-' + lang;
		if (lang === 'markdown') {
			editorCode.classList.add('editor-wrap');
		} else {
			editorCode.classList.remove('editor-wrap');
		}

		if (saveBtn) saveBtn.style.display = 'none';
		if (toggleIcon) toggleIcon.textContent = 'difference';
		if (toggleText) toggleText.textContent = 'Diff Mode';

		if (lineNumbers) {
			lineNumbers.style.fontFamily = '';
			lineNumbers.style.textAlign = '';
		}

		if (jar) {
			jar.updateCode(result.content);
		}

		updateEditorLineNumbers(result.content);
		await updateScrollbarDecorations();
	}

	editorCode.focus();
	is_loading_file = false;
}

function updateEditorLineNumbers(code) {
	const editorCode = document.getElementById('editor-code');
	const lineNumbers = document.getElementById('editor-line-numbers');

	if (!editorCode || !lineNumbers) return;
	if (editor_mode === 'diff') return;

	const val = typeof code === 'string' ? code : jar ? jar.toString() : editorCode.textContent;
	const lines = val.split('\n');
	const lineCount = lines.length;

	lineNumbers.innerHTML = '';
	const fragment = document.createDocumentFragment();
	const state = window.editorDiffState || {
		added: new Set(),
		modified: new Set(),
		deletedBefore: new Set(),
		deletedAfter: new Set()
	};

	for (let i = 1; i <= lineCount; i++) {
		const div = document.createElement('div');
		div.className = 'line-num';
		div.textContent = i;

		if (state.added.has(i)) {
			div.classList.add('added');
		} else if (state.modified.has(i)) {
			div.classList.add('modified');
		}

		if (state.deletedBefore.has(i)) {
			div.classList.add('deleted-before');
		}
		if (i === lineCount && state.deletedAfter.has(i)) {
			div.classList.add('deleted-after');
		}

		fragment.appendChild(div);
	}
	lineNumbers.appendChild(fragment);

	lineNumbers.scrollTop = editorCode.scrollTop;
}

function closeEditor() {
	const overlay = document.getElementById('editor-overlay');
	document.body.classList.remove('editor-active');
	active_editor_file_path = null;

	const activeInput = document.getElementById('active-input');
	if (activeInput && !is_mobile) {
		activeInput.focus();
	}

	if (opened_from_changes) {
		opened_from_changes = false;
		openDiffOverlay();
	}
}

async function saveEditorContent() {
	if (!active_editor_file_path) return;

	const editorCode = document.getElementById('editor-code');
	const saveBtn = document.getElementById('editor-btn-save');

	const originalText = saveBtn.innerHTML;
	saveBtn.disabled = true;
	saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1.2em;">sync</span> <span class="btn-text">Saving...</span>';

	const content = jar ? jar.toString() : editorCode.textContent;
	const result = await window.api.saveFileContent(active_editor_file_path, content);
	saveBtn.disabled = false;

	if (result.error) {
		saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1.2em;">error</span> <span class="btn-text">Error</span>';
		alert('Failed to save file: ' + result.error);
		setTimeout(() => {
			saveBtn.innerHTML = originalText;
		}, 2000);
	} else {
		is_dirty = false;
		updateScrollbarDecorations();
		if (result.formatted && result.formattedContent) {
			if (jar) {
				const pos = jar.save();
				jar.updateCode(result.formattedContent);
				try {
					jar.restore(pos);
				} catch (restoreErr) {
					console.warn('Failed to restore caret position:', restoreErr);
				}
			} else {
				editorCode.textContent = result.formattedContent;
			}
			updateEditorLineNumbers(result.formattedContent);
		}
		saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1.2em;">done</span> <span class="btn-text">Saved</span>';
		saveBtn.style.background = 'var(--green)';
		saveBtn.style.color = 'var(--black)';
		setTimeout(() => {
			saveBtn.innerHTML = originalText;
			saveBtn.style.background = '';
			saveBtn.style.color = '';
			saveBtn.style.display = 'none';
		}, 1500);
	}
}

async function toggleEditorMode() {
	if (!active_editor_file_path) return;

	const editorCode = document.getElementById('editor-code');
	const saveBtn = document.getElementById('editor-btn-save');
	const toggleIcon = document.getElementById('editor-toggle-icon');
	const toggleText = document.getElementById('editor-toggle-text');

	if (editor_mode === 'edit') {
		// Switch to diff mode
		if (is_dirty) {
			if (confirm('Save changes before switching to Diff Mode?')) {
				await saveEditorContent();
			}
		}

		toggleText.textContent = 'Loading Diff...';

		editor_mode = 'diff';
		editorCode.setAttribute('contenteditable', 'false');
		editorCode.className = 'editor-code language-diff';
		saveBtn.style.display = 'none';
		toggleIcon.textContent = 'edit_note';
		toggleText.textContent = 'Edit Mode';

		// Style line numbers panel for diff mode
		const lineNumbers = document.getElementById('editor-line-numbers');
		lineNumbers.style.fontFamily = "'Consolas', monospace";
		lineNumbers.style.textAlign = 'left';

		await updateScrollbarDecorations();
		toggleText.textContent = 'Edit Mode';
	} else {
		// Switch to edit mode
		toggleText.textContent = 'Loading File...';
		const result = await window.api.readFileContent(active_editor_file_path);
		if (result.error) {
			alert('Failed to read file: ' + result.error);
			toggleText.textContent = 'Edit Mode';
			return;
		}

		editor_mode = 'edit';
		is_dirty = false;
		editorCode.setAttribute('contenteditable', 'plaintext-only');
		editorCode.className = 'editor-code language-' + editor_file_lang;
		if (editor_file_lang === 'markdown') {
			editorCode.classList.add('editor-wrap');
		} else {
			editorCode.classList.remove('editor-wrap');
		}

		saveBtn.style.display = 'none';
		toggleIcon.textContent = 'difference';
		toggleText.textContent = 'Diff Mode';

		// Reset line numbers styling
		const lineNumbers = document.getElementById('editor-line-numbers');
		lineNumbers.style.fontFamily = '';
		lineNumbers.style.textAlign = '';

		is_loading_file = true;
		if (jar) {
			jar.updateCode(result.content);
		} else {
			editorCode.textContent = result.content;
		}
		is_loading_file = false;

		await updateScrollbarDecorations();
	}
}

function toggleLineNumbers() {
	const overlay = document.getElementById('editor-overlay');
	const toggleLinesBtn = document.getElementById('editor-btn-toggle-lines');
	if (!overlay || !toggleLinesBtn) return;

	const isHidden = overlay.classList.toggle('lines-hidden');
	if (isHidden) {
		toggleLinesBtn.style.opacity = '0.5';
	} else {
		toggleLinesBtn.style.opacity = '';
	}
}

function simulateAgentResponse(fullText) {
	const container = document.getElementById('terminal-chat-container');

	active_assistant_block = document.createElement('chat-block');
	active_assistant_block.setAttribute('from', 'assistant');

	active_message_content = document.createElement('div');
	active_message_content.className = 'input msg waiting chat-marker';

	active_assistant_block.appendChild(active_message_content);
	container.appendChild(active_assistant_block);

	active_assistant_text = '';
	active_thinking_details = null;
	active_thinking_content = null;

	window.scrollTo(0, document.body.scrollHeight);

	const chunkSize = 30;
	let currentIndex = 0;

	const intervalId = setInterval(() => {
		if (currentIndex >= fullText.length) {
			clearInterval(intervalId);

			if (active_assistant_block && active_message_content) {
				active_message_content.classList.remove('waiting');
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
				active_thinking_details = document.createElement('details');
				active_thinking_details.className = 'thinking-details';
				active_thinking_details.setAttribute('open', 'true');

				const summary = document.createElement('summary');
				summary.className = 'chat-marker';
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

		if (window.marked) {
			active_message_content.innerHTML = window.marked.parse(parsed.content);
			if (window.Prism) {
				window.Prism.highlightAllUnder(active_message_content);
			}
		} else {
			active_message_content.textContent = parsed.content;
		}

		if (parsed.content && active_thinking_details && active_thinking_details.open && !active_thinking_details.dataset.collapsedAutomatically) {
			active_thinking_details.open = false;
			active_thinking_details.dataset.collapsedAutomatically = 'true';
		}

		window.scrollTo(0, document.body.scrollHeight);
	}, 15);
}

async function openDiffOverlay() {
	document.body.classList.add('diff-active');
	const diffBody = document.getElementById('diff-body');
	if (diffBody) {
		loadDiffOverlayContent(diffBody);
	}
}

function closeDiffOverlay() {
	document.body.classList.remove('diff-active');
}

function refreshDiffOverlay() {
	const diffBody = document.getElementById('diff-body');
	if (diffBody) {
		loadDiffOverlayContent(diffBody);
	}
}

async function loadDiffOverlayContent(container) {
	container.innerHTML = `<div class="diff-empty-msg">Loading git changes...</div>`;
	const status = await window.api.readGitStatus();
	if (status.error) {
		container.innerHTML = `<div class="diff-empty-msg" style="color: var(--red);">Error: ${status.error}</div>`;
		return;
	}

	container.innerHTML = '';

	// 1. Staged Section
	const stagedSection = document.createElement('div');
	stagedSection.className = 'diff-section';
	stagedSection.innerHTML = `<div class="diff-section-header">Staged Changes</div>`;
	const stagedList = document.createElement('div');
	stagedList.className = 'diff-list';

	if (status.staged.length === 0) {
		stagedList.innerHTML = `<div class="diff-empty-msg">No staged changes</div>`;
	} else {
		status.staged.forEach(file => {
			const item = document.createElement('div');
			item.className = 'diff-item';

			const link = document.createElement('a');
			link.className = `diff-file-link ${file.type}`;
			link.textContent = file.path;
			link.addEventListener('click', e => {
				e.preventDefault();
				closeDiffOverlay();
				openEditor(file.path, true);
			});

			const btn = document.createElement('button');
			btn.className = 'diff-item-btn unstage';
			btn.textContent = '-';
			btn.title = 'Unstage file';
			btn.addEventListener('click', async e => {
				e.stopPropagation();
				btn.disabled = true;
				const res = await window.api.unstageFile(file.path);
				if (res.error) {
					alert('Failed to unstage: ' + res.error);
					btn.disabled = false;
				} else {
					loadDiffOverlayContent(container);
				}
			});

			item.appendChild(link);
			item.appendChild(btn);
			stagedList.appendChild(item);
		});
	}
	stagedSection.appendChild(stagedList);
	container.appendChild(stagedSection);

	// 2. Changes Section
	const unstagedSection = document.createElement('div');
	unstagedSection.className = 'diff-section';
	unstagedSection.innerHTML = `<div class="diff-section-header">Changes</div>`;
	const unstagedList = document.createElement('div');
	unstagedList.className = 'diff-list';

	if (status.unstaged.length === 0) {
		unstagedList.innerHTML = `<div class="diff-empty-msg">No unstaged changes</div>`;
	} else {
		status.unstaged.forEach(file => {
			const item = document.createElement('div');
			item.className = 'diff-item';

			const link = document.createElement('a');
			link.className = `diff-file-link ${file.type}`;
			link.textContent = file.path;
			link.addEventListener('click', e => {
				e.preventDefault();
				closeDiffOverlay();
				openEditor(file.path, true);
			});

			const btn = document.createElement('button');
			btn.className = 'diff-item-btn stage';
			btn.textContent = '+';
			btn.title = 'Stage file';
			btn.addEventListener('click', async e => {
				e.stopPropagation();
				btn.disabled = true;
				const res = await window.api.stageFile(file.path);
				if (res.error) {
					alert('Failed to stage: ' + res.error);
					btn.disabled = false;
				} else {
					loadDiffOverlayContent(container);
				}
			});

			item.appendChild(link);
			item.appendChild(btn);
			unstagedList.appendChild(item);
		});
	}
	unstagedSection.appendChild(unstagedList);
	container.appendChild(unstagedSection);
}

async function updateScrollbarDecorations() {
	const container = document.getElementById('editor-scrollbar-decorations');
	if (!container || !active_editor_file_path) return;

	const colModified = container.querySelector('.decorations-col.modified');
	const colAdded = container.querySelector('.decorations-col.added');
	const colDeleted = container.querySelector('.decorations-col.deleted');

	if (!colModified || !colAdded || !colDeleted) return;

	// Clear previous markers
	colModified.innerHTML = '';
	colAdded.innerHTML = '';
	colDeleted.innerHTML = '';

	const editorCode = document.getElementById('editor-code');
	const lineNumbers = document.getElementById('editor-line-numbers');
	if (!editorCode || !lineNumbers) return;

	if (editor_mode === 'diff') {
		// Fetch the git diff
		const result = await window.api.readFileDiff(active_editor_file_path);
		if (result.error) {
			alert('Failed to read diff: ' + result.error);
			return;
		}

		const diffRaw = result.diff || '';
		let displayLines = [];
		let lineNumbersData = [];
		let lineOld = 1;
		let lineNew = 1;

		if (!diffRaw || diffRaw.trim() === '') {
			// No changes: display original content as unchanged context
			const origResult = await window.api.readFileContent(active_editor_file_path);
			const origContent = origResult.content || '';
			const origLines = origContent.split('\n');
			for (let i = 0; i < origLines.length; i++) {
				displayLines.push(' ' + origLines[i]);
				const oldStr = (i + 1).toString().padStart(4);
				const newStr = (i + 1).toString().padStart(4);
				lineNumbersData.push({
					text: oldStr + '  ' + newStr,
					className: 'line-num'
				});
			}
		} else {
			const lines = diffRaw.split('\n');
			let hunkStartIndex = -1;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].startsWith('@@')) {
					hunkStartIndex = i;
					break;
				}
			}

			if (hunkStartIndex !== -1) {
				const match = lines[hunkStartIndex].match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
				if (match) {
					lineOld = parseInt(match[1], 10);
					lineNew = parseInt(match[2], 10);
				}

				for (let i = hunkStartIndex; i < lines.length; i++) {
					const line = lines[i];
					if (i === hunkStartIndex) {
						displayLines.push(line);
						lineNumbersData.push({
							text: '    ' + '  ' + '    ',
							className: 'line-num coord'
						});
						continue;
					}

					if (line.startsWith('\\')) {
						displayLines.push(line);
						lineNumbersData.push({
							text: '    ' + '  ' + '    ',
							className: 'line-num'
						});
						continue;
					}

					if (line.startsWith('-')) {
						displayLines.push(line);
						const oldStr = lineOld.toString().padStart(4);
						lineNumbersData.push({
							text: oldStr + '  ' + '    ',
							className: 'line-num deleted'
						});
						lineOld++;
					} else if (line.startsWith('+')) {
						displayLines.push(line);
						const newStr = lineNew.toString().padStart(4);
						lineNumbersData.push({
							text: '    ' + '  ' + newStr,
							className: 'line-num added'
						});
						lineNew++;
					} else if (line.startsWith(' ')) {
						displayLines.push(line);
						const oldStr = lineOld.toString().padStart(4);
						const newStr = lineNew.toString().padStart(4);
						lineNumbersData.push({
							text: oldStr + '  ' + newStr,
							className: 'line-num'
						});
						lineOld++;
						lineNew++;
					} else {
						if (i === lines.length - 1 && line === '') {
							break;
						}
						displayLines.push(' ' + line);
						const oldStr = lineOld.toString().padStart(4);
						const newStr = lineNew.toString().padStart(4);
						lineNumbersData.push({
							text: oldStr + '  ' + newStr,
							className: 'line-num'
						});
						lineOld++;
						lineNew++;
					}
				}
			} else {
				for (let i = 0; i < lines.length; i++) {
					displayLines.push(lines[i]);
					lineNumbersData.push({
						text: (i + 1).toString().padStart(4) + '  ' + (i + 1).toString().padStart(4),
						className: 'line-num'
					});
				}
			}
		}

		const finalDiffCode = displayLines.join('\n');
		is_loading_file = true;
		if (jar) {
			jar.updateCode(finalDiffCode);
		} else {
			editorCode.textContent = finalDiffCode;
		}
		is_loading_file = false;

		lineNumbers.innerHTML = '';
		const fragment = document.createDocumentFragment();
		for (let i = 0; i < lineNumbersData.length; i++) {
			const div = document.createElement('div');
			div.className = lineNumbersData[i].className;
			div.textContent = lineNumbersData[i].text;
			fragment.appendChild(div);
		}
		lineNumbers.appendChild(fragment);
		lineNumbers.scrollTop = editorCode.scrollTop;

		const totalLines = displayLines.length;
		if (totalLines > 0) {
			for (let i = 0; i < totalLines; i++) {
				const line = displayLines[i];
				let type = null;
				if (line.startsWith('-')) {
					type = 'deleted';
				} else if (line.startsWith('+')) {
					type = 'added';
				} else if (line.startsWith('@@')) {
					type = 'modified';
				}

				if (type) {
					const marker = document.createElement('div');
					marker.className = 'decoration-marker';
					const pct = (i / totalLines) * 100;
					marker.style.top = pct.toFixed(2) + '%';

					if (type === 'deleted') colDeleted.appendChild(marker);
					else if (type === 'added') colAdded.appendChild(marker);
					else colModified.appendChild(marker);
				}
			}
		}
		return;
	}

	// In Edit Mode, we fetch the git diff against HEAD to find changes
	const result = await window.api.readFileDiff(active_editor_file_path);
	if (result.error || !result.diff) {
		window.editorDiffState = {
			added: new Set(),
			modified: new Set(),
			deletedBefore: new Set(),
			deletedAfter: new Set()
		};
		updateEditorLineNumbers();
		return;
	}

	const currentLines = editorCode.textContent.split('\n');
	const totalLines = currentLines.length;
	if (totalLines === 0) return;

	const diffRaw = result.diff;
	const lines = diffRaw.split('\n');

	const lineAdditions = new Set();
	const lineDeletions = new Set();

	let lineNew = 1;
	let hunkStartIndex = -1;

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith('@@')) {
			const match = lines[i].match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (match) {
				lineNew = parseInt(match[1], 10);
			}
			continue;
		}

		const line = lines[i];
		if (line.startsWith('-')) {
			lineDeletions.add(lineNew);
		} else if (line.startsWith('+')) {
			lineAdditions.add(lineNew);
			lineNew++;
		} else if (line.startsWith(' ') || line.trim() !== '') {
			lineNew++;
		}
	}

	const allPositions = new Set([...lineAdditions, ...lineDeletions]);

	const addedSet = new Set();
	const modifiedSet = new Set();
	const deletedBeforeSet = new Set();
	const deletedAfterSet = new Set();

	for (const lineNum of allPositions) {
		let type = null;
		if (lineAdditions.has(lineNum) && lineDeletions.has(lineNum)) {
			type = 'modified';
			modifiedSet.add(lineNum);
		} else if (lineAdditions.has(lineNum)) {
			type = 'added';
			addedSet.add(lineNum);
		} else {
			type = 'deleted';
			if (lineNum === 1) {
				deletedBeforeSet.add(1);
			} else if (lineNum <= totalLines) {
				deletedBeforeSet.add(lineNum);
			} else {
				deletedAfterSet.add(totalLines);
			}
		}

		const marker = document.createElement('div');
		marker.className = 'decoration-marker';
		const displayLineNum = Math.min(lineNum, totalLines);
		const pct = ((displayLineNum - 1) / totalLines) * 100;
		marker.style.top = pct.toFixed(2) + '%';

		if (type === 'modified') {
			colModified.appendChild(marker);
		} else if (type === 'added') {
			colAdded.appendChild(marker);
		} else {
			colDeleted.appendChild(marker);
		}
	}

	window.editorDiffState = {
		added: addedSet,
		modified: modifiedSet,
		deletedBefore: deletedBeforeSet,
		deletedAfter: deletedAfterSet
	};

	updateEditorLineNumbers();
}

window.api.onPinnedDirsUpdated(info => {
	pinned_dirs_global = info.pinned_dirs;
	home_dir_global = info.home_dir;
});

// Setup event listeners on the video element to remove "waiting" class when the WebRTC stream actually starts playing
(function () {
	const videoElem = document.getElementById('screen-stream-video');
	const containerElem = document.getElementById('screen-stream-container');
	if (videoElem) {
		const clearWaiting = () => {
			if (videoElem.videoWidth > 0 && videoElem.videoHeight > 0) {
				videoElem.classList.remove('waiting');
				if (containerElem) {
					containerElem.classList.remove('waiting');
				}
			}
		};
		videoElem.addEventListener('playing', clearWaiting);
		videoElem.addEventListener('loadedmetadata', clearWaiting);
		videoElem.addEventListener('canplay', clearWaiting);
	}
})();
