const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { OpenAI } = require('openai');

const active_windows = new Map();
const config_path = path.join(os.homedir(), '.nono-terminal-config.json');

const default_config = {
	current_provider: 'openai',
	providers: {
		openai: {
			base_url: 'https://api.openai.com/v1',
			api_key: '',
			model: 'gpt-4o-mini'
		},
		gemini: {
			base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
			api_key: '',
			model: 'gemini-2.5-flash'
		}
	}
};

function loadConfig() {
	if (process.env.OPENAI_API_KEY) {
		return {
			current_provider: 'openai',
			providers: {
				...default_config.providers,
				openai: {
					base_url: 'https://api.openai.com/v1',
					api_key: process.env.OPENAI_API_KEY,
					model: 'gpt-4o-mini'
				}
			}
		};
	}
	try {
		if (fs.existsSync(config_path)) {
			const config_data = JSON.parse(fs.readFileSync(config_path, 'utf8'));
			const legacy_key = config_data.openai_api_key || '';
			const providers = { ...default_config.providers };

			if (legacy_key) {
				providers.openai.api_key = legacy_key;
				providers.gemini.api_key = legacy_key;
			}

			if (config_data.providers) {
				for (const [name, info] of Object.entries(config_data.providers)) {
					providers[name] = { ...providers[name], ...info };
				}
			}

			return {
				current_provider: config_data.current_provider || (legacy_key ? 'gemini' : 'openai'),
				providers
			};
		}
	} catch (err) {
		console.error('Error loading config:', err.message);
	}
	return default_config;
}

function saveConfig(config_data) {
	try {
		fs.writeFileSync(config_path, JSON.stringify(config_data, null, 2), 'utf8');
		return true;
	} catch (err) {
		console.error('Error saving config:', err.message);
		return false;
	}
}

function getApiKey() {
	const config = loadConfig();
	return config.providers[config.current_provider]?.api_key || '';
}

let cached_commands = null;

function getAvailableCommands() {
	if (cached_commands) {
		return cached_commands;
	}

	const commands = new Set();
	const shell_builtins = ['cd', 'echo', 'eval', 'exec', 'exit', 'export', 'read', 'set', 'unset', 'alias', 'unalias', 'pushd', 'popd', 'dirs', 'history', 'history-list', 'source', 'bg', 'fg', 'jobs', 'type', 'which', 'pwd'];
	shell_builtins.forEach(cmd => commands.add(cmd));

	const path_env = process.env.PATH || '';
	const directories = path_env.split(path.delimiter);

	for (const dir of directories) {
		try {
			if (fs.existsSync(dir)) {
				const files = fs.readdirSync(dir);
				for (const file of files) {
					const full_path = path.join(dir, file);
					try {
						const stat = fs.statSync(full_path);
						if (stat.isFile()) {
							const is_executable = (stat.mode & 0o111) !== 0;
							if (is_executable) {
								commands.add(file);
							}
						}
					} catch (err) {
						// Ignore broken symlinks
					}
				}
			}
		} catch (err) {
			// Ignore read errors
		}
	}

	return Array.from(commands);
}

// Shell Session class to handle spawning and parsing
class ShellSession {
	constructor(web_contents, initial_cwd) {
		this.web_contents = web_contents;
		this.current_cwd = initial_cwd || process.cwd();
		this.stdout_buffer = '';
		this.stderr_buffer = '';
		this.active_command_callback = null;
		const config = loadConfig();
		const active_prov = config.providers[config.current_provider] || {};
		this.model = active_prov.model || 'gpt-4o-mini';
		this.messages = [];

		this.shell_proc = spawn('/bin/bash', [], {
			cwd: this.current_cwd,
			env: { ...process.env, PS1: '' }
		});

		this.setupListeners();
	}

	setupListeners() {
		this.shell_proc.stdout.on('data', chunk => {
			this.handleOutput(chunk.toString(), false);
		});

		this.shell_proc.stderr.on('data', chunk => {
			this.handleOutput(chunk.toString(), true);
		});

		this.shell_proc.on('close', code => {
			console.log('Shell closed with code:', code);
		});
	}

	handleOutput(data, is_stderr) {
		const buffer_name = is_stderr ? 'stderr_buffer' : 'stdout_buffer';
		this[buffer_name] += data;

		let lines = this[buffer_name].split('\n');
		this[buffer_name] = lines.pop();

		for (const line of lines) {
			const delim_index = line.indexOf('__NONO_CMD_END__');
			if (delim_index !== -1) {
				const prefix = line.substring(0, delim_index);
				if (prefix) {
					this.web_contents.send('shell-output', { text: prefix, is_stderr });
				}
				const suffix = line.substring(delim_index);
				const match = suffix.match(/__NONO_CMD_END__ (\d+) (.*)/);
				if (match) {
					const exit_code = parseInt(match[1], 10);
					const next_cwd = match[2].trim();
					this.current_cwd = next_cwd;
					if (this.active_command_callback) {
						const cb = this.active_command_callback;
						this.active_command_callback = null;
						cb({ exit_code, cwd: this.current_cwd });
					}
				}
			} else {
				this.web_contents.send('shell-output', { text: line + '\n', is_stderr });
			}
		}
	}

	writeCommand(command, callback) {
		this.active_command_callback = callback;
		this.shell_proc.stdin.write(command + '\n');
		this.shell_proc.stdin.write('echo "__NONO_CMD_END__ $? $PWD"\n');
	}

	interrupt() {
		// Send SIGINT to direct children of the bash shell PID
		exec(`pkill -INT -P ${this.shell_proc.pid}`, err => {
			if (err) {
				console.warn('pkill SIGINT failed:', err.message);
			}
		});
	}
}

// Tool functions
function listDirectory(dir_path) {
	try {
		const files = fs.readdirSync(dir_path);
		return files.map(file => {
			const full_path = path.join(dir_path, file);
			const stat = fs.statSync(full_path);
			return {
				name: file,
				is_directory: stat.isDirectory(),
				size: stat.size
			};
		});
	} catch (err) {
		return { error: err.message };
	}
}

function readFile(file_path, start_line, end_line) {
	try {
		const content = fs.readFileSync(file_path, 'utf8');
		const lines = content.split('\n');
		const start = start_line ? Math.max(1, start_line) - 1 : 0;
		const end = end_line ? Math.min(lines.length, end_line) : lines.length;
		const sliced = lines.slice(start, end);
		return {
			content: sliced.join('\n'),
			total_lines: lines.length,
			start_line: start + 1,
			end_line: end
		};
	} catch (err) {
		return { error: err.message };
	}
}

function editFile(file_path, search_content, replace_content) {
	try {
		const content = fs.readFileSync(file_path, 'utf8');
		const occurrences = content.split(search_content).length - 1;
		if (occurrences === 0) {
			return { error: 'Search content not found in the file. Make sure the search content matches exactly.' };
		}
		if (occurrences > 1) {
			return { error: 'Search content is not unique. Found ' + occurrences + ' occurrences. Please provide a more specific search block.' };
		}
		const updated_content = content.replace(search_content, replace_content);
		fs.writeFileSync(file_path, updated_content, 'utf8');
		return { success: true };
	} catch (err) {
		return { error: err.message };
	}
}

function loadGitignore(dir_path) {
	const rules = ['.git', 'node_modules'];
	try {
		const gitignore_path = path.join(dir_path, '.gitignore');
		if (fs.existsSync(gitignore_path)) {
			const content = fs.readFileSync(gitignore_path, 'utf8');
			content.split('\n').forEach(line => {
				const trimmed = line.trim();
				if (trimmed && !trimmed.startsWith('#')) {
					rules.push(trimmed);
				}
			});
		}
	} catch (err) {
		// Ignore error
	}
	return rules;
}

function shouldIgnore(file_name, relative_path, rules) {
	for (const rule of rules) {
		let clean_rule = rule.replace(/\/$/, '');
		if (clean_rule.startsWith('/')) {
			if (relative_path === clean_rule.substring(1) || relative_path.startsWith(clean_rule.substring(1) + '/')) {
				return true;
			}
		} else {
			if (file_name === clean_rule || relative_path.split('/').includes(clean_rule)) {
				return true;
			}
		}
	}
	return false;
}

function walkDirectory(dir, base_dir, rules, callback) {
	const files = fs.readdirSync(dir);
	for (const file of files) {
		const full_path = path.join(dir, file);
		const relative_path = path.relative(base_dir, full_path);
		if (shouldIgnore(file, relative_path, rules)) {
			continue;
		}
		const stat = fs.statSync(full_path);
		if (stat.isDirectory()) {
			walkDirectory(full_path, base_dir, rules, callback);
		} else if (stat.isFile()) {
			callback(full_path, relative_path);
		}
	}
}

function searchCodebase(query, base_dir) {
	const rules = loadGitignore(base_dir);
	const matches = [];
	try {
		walkDirectory(base_dir, base_dir, rules, (full_path, relative_path) => {
			const ext = path.extname(full_path).toLowerCase();
			const text_extensions = ['.js', '.json', '.html', '.css', '.md', '.txt', '.sh', '.py', '.ts', '.tsx', '.jsx', '.jsonld', '.yml', '.yaml'];
			if (!text_extensions.includes(ext)) {
				return;
			}
			const content = fs.readFileSync(full_path, 'utf8');
			const lines = content.split('\n');
			lines.forEach((line, index) => {
				if (line.includes(query)) {
					matches.push({
						path: relative_path,
						line_number: index + 1,
						line_content: line.trim()
					});
				}
			});
		});
		return matches.slice(0, 100);
	} catch (err) {
		return { error: err.message };
	}
}

function generateRepoMap(base_dir) {
	const rules = loadGitignore(base_dir);
	const tree_lines = [];

	function buildTree(dir, prefix = '') {
		const files = fs.readdirSync(dir);
		const sorted = files
			.map(file => {
				const full_path = path.join(dir, file);
				const stat = fs.statSync(full_path);
				return { file, is_dir: stat.isDirectory(), full_path };
			})
			.filter(item => {
				const relative_path = path.relative(base_dir, item.full_path);
				return !shouldIgnore(item.file, relative_path, rules);
			})
			.sort((a, b) => {
				if (a.is_dir && !b.is_dir) return -1;
				if (!a.is_dir && b.is_dir) return 1;
				return a.file.localeCompare(b.file);
			});

		sorted.forEach((item, index) => {
			const is_last = index === sorted.length - 1;
			const marker = is_last ? '└── ' : '├── ';
			tree_lines.push(prefix + marker + item.file);
			if (item.is_dir) {
				const next_prefix = prefix + (is_last ? '    ' : '│   ');
				buildTree(item.full_path, next_prefix);
			}
		});
	}

	tree_lines.push('/');
	try {
		buildTree(base_dir);
	} catch (err) {
		tree_lines.push('Error generating repo map: ' + err.message);
	}
	return tree_lines.join('\n');
}

function computeLineDiff(old_lines, new_lines) {
	const dp = Array(old_lines.length + 1)
		.fill(null)
		.map(() => Array(new_lines.length + 1).fill(0));
	for (let i = 1; i <= old_lines.length; i++) {
		for (let j = 1; j <= new_lines.length; j++) {
			if (old_lines[i - 1] === new_lines[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	const diff = [];
	let i = old_lines.length;
	let j = new_lines.length;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && old_lines[i - 1] === new_lines[j - 1]) {
			diff.unshift('  ' + old_lines[i - 1]);
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			diff.unshift('+ ' + new_lines[j - 1]);
			j--;
		} else {
			diff.unshift('- ' + old_lines[i - 1]);
			i--;
		}
	}
	return diff.join('\n');
}

// System prompt builder
function getSystemPrompt(cwd) {
	const os_platform = process.platform;
	const shell_type = os_platform === 'win32' ? 'cmd/powershell' : 'bash';
	return `You are Nono-Terminal, a powerful AI terminal assistant.
You have direct access to a persistent terminal shell and files in the workspace.
Current Environment:
- Operating System: ${os_platform}
- Target Shell: ${shell_type}
- Current Working Directory: ${cwd}

Rules:
1. Wrap your internal reasoning/thinking process inside <thinking>...</thinking> tags. For example:
<thinking>
We need to list the files in the directory to find package.json. I will call list_directory.
</thinking>
This is required before calling any tool or producing any response.
2. Use the available tools to complete tasks. Prefer using native tools (like read_file, edit_file, search_codebase, list_directory) over running shell commands where possible to be safer and more efficient.
3. Variable names in files you edit or write should be snake_case, and function/method names should be camelCase.
4. Be concise and act like a senior developer assistant. Do not explain things unless asked.`;
}

// OpenAI call timeout/retry wrapper
async function callOpenAiWithRetry(fn, attempts = 3) {
	for (let i = 0; i < attempts; i++) {
		const controller = new AbortController();
		const timeout_id = setTimeout(() => {
			controller.abort();
		}, 30000);

		try {
			const response = await fn(controller.signal);
			clearTimeout(timeout_id);
			return response;
		} catch (err) {
			clearTimeout(timeout_id);
			if (err.name === 'AbortError' || err.code === 'ETIMEDOUT') {
				console.warn(`OpenAI call timed out. Retrying attempt ${i + 2}/${attempts}...`);
				if (i === attempts - 1) {
					throw new Error('OpenAI request timed out after ' + attempts + ' attempts.');
				}
			} else {
				throw err;
			}
		}
	}
}

// Rolling window context truncation
function truncateOldReadFiles(messages, max_keep = 5) {
	let read_tool_count = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === 'tool' && (msg.name === 'read_file' || msg.name === 'search_codebase')) {
			read_tool_count++;
			if (read_tool_count > max_keep) {
				msg.content = '[Output truncated to save context window]';
			}
		}
	}
}

// Tool definitions for OpenAI
const tools_definition = [
	{
		type: 'function',
		function: {
			name: 'execute_command',
			description: 'Runs a command in the persistent shell and returns its stdout and stderr outputs.',
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'The shell command to execute.' }
				},
				required: ['command']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'read_file',
			description: 'Reads lines from a file in the workspace.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The absolute or relative path to the file.' },
					start_line: { type: 'integer', description: 'The 1-indexed line number to start reading from (inclusive).' },
					end_line: { type: 'integer', description: 'The 1-indexed line number to stop reading at (inclusive).' }
				},
				required: ['path']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'edit_file',
			description: 'Edits an existing file in the workspace by performing a search-and-replace of a unique block.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The absolute or relative path to the file.' },
					search_content: { type: 'string', description: 'The exact lines/block of code to be replaced.' },
					replace_content: { type: 'string', description: 'The new lines/block of code to replace the search content with.' }
				},
				required: ['path', 'search_content', 'replace_content']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'search_codebase',
			description: 'Searches the workspace files recursively for a given query string (native grep-like).',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'The string pattern to search for in files.' }
				},
				required: ['query']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'list_directory',
			description: 'Lists the contents of a directory in the workspace.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The absolute or relative path to the directory.' }
				},
				required: ['path']
			}
		}
	}
];

// Agent execution loop
async function runAgentLoop(session, prompt) {
	const web_contents = session.web_contents;
	const api_key = getApiKey();
	if (!api_key) {
		web_contents.send('agent-chunk', {
			text: 'Error: OpenAI API Key is not configured. Please use `/api-key <key>` or set the `OPENAI_API_KEY` environment variable.'
		});
		web_contents.send('agent-complete');
		return;
	}

	if (!session.messages) {
		session.messages = [];
	}

	session.messages.push({ role: 'user', content: prompt });
	truncateOldReadFiles(session.messages);

	let consecutive_errors = 0;

	try {
		const config = loadConfig();
		const active_prov = config.providers[config.current_provider] || {};
		const openai = new OpenAI({
			apiKey: active_prov.api_key || 'none',
			baseURL: active_prov.base_url || undefined
		});
		let loop_count = 0;
		const max_loops = 15;

		while (loop_count < max_loops) {
			loop_count++;

			const system_msg = { role: 'system', content: getSystemPrompt(session.current_cwd) };
			if (session.messages.length > 0 && session.messages[0].role === 'system') {
				session.messages[0] = system_msg;
			} else {
				session.messages.unshift(system_msg);
			}

			web_contents.send('agent-status', 'Thinking...');

			const response = await callOpenAiWithRetry(signal =>
				openai.chat.completions.create(
					{
						model: session.model || 'gpt-4o-mini',
						messages: session.messages,
						tools: tools_definition
					},
					{ signal }
				)
			);

			const choice = response.choices[0];
			const message = choice.message;

			session.messages.push(message);

			if (message.content) {
				web_contents.send('agent-chunk', { text: message.content });
			}

			if (!message.tool_calls || message.tool_calls.length === 0) {
				break;
			}

			for (const tool_call of message.tool_calls) {
				const name = tool_call.function.name;
				const args = JSON.parse(tool_call.function.arguments);

				web_contents.send('agent-tool-start', { name, args, tool_call_id: tool_call.id });

				let tool_result;
				let is_error = false;

				try {
					if (name === 'execute_command') {
						tool_result = await new Promise(resolve => {
							session.writeCommand(args.command, info => {
								resolve(JSON.stringify({ exit_code: info.exit_code, cwd: info.cwd }));
							});
						});
						if (JSON.parse(tool_result).exit_code !== 0) {
							is_error = true;
						}
					} else if (name === 'read_file') {
						const res = readFile(path.resolve(session.current_cwd, args.path), args.start_line, args.end_line);
						if (res.error) {
							is_error = true;
						}
						tool_result = JSON.stringify(res);
					} else if (name === 'edit_file') {
						const abs_path = path.resolve(session.current_cwd, args.path);
						const old_content = fs.existsSync(abs_path) ? fs.readFileSync(abs_path, 'utf8') : '';
						const res = editFile(abs_path, args.search_content, args.replace_content);
						if (res.error) {
							is_error = true;
							tool_result = JSON.stringify(res);
						} else {
							const diff = computeLineDiff(args.search_content.split('\n'), args.replace_content.split('\n'));
							web_contents.send('agent-tool-output', { tool_call_id: tool_call.id, text: diff });
							tool_result = JSON.stringify(res);
						}
					} else if (name === 'search_codebase') {
						const res = searchCodebase(args.query, session.current_cwd);
						tool_result = JSON.stringify(res);
					} else if (name === 'list_directory') {
						const res = listDirectory(path.resolve(session.current_cwd, args.path || '.'));
						if (res.error) {
							is_error = true;
						}
						tool_result = JSON.stringify(res);
					} else {
						tool_result = JSON.stringify({ error: `Unknown tool: ${name}` });
						is_error = true;
					}
				} catch (err) {
					tool_result = JSON.stringify({ error: err.message });
					is_error = true;
				}

				web_contents.send('agent-tool-complete', { tool_call_id: tool_call.id, result: tool_result });

				if (is_error) {
					consecutive_errors++;
					if (consecutive_errors >= 3) {
						web_contents.send('agent-chunk', {
							text: '\n\n**[Error Loop Halted]** The agent encountered consecutive errors. Please intervene manually.\n'
						});
						web_contents.send('agent-complete');
						return;
					}
				} else {
					consecutive_errors = 0;
				}

				session.messages.push({
					role: 'tool',
					tool_call_id: tool_call.id,
					name: name,
					content: tool_result
				});
			}
		}
	} catch (err) {
		web_contents.send('agent-chunk', { text: `\n\n**Error:** ${err.message}` });
	} finally {
		web_contents.send('agent-complete');
	}
}

function toggleDebugMode(win) {
	const current_url = win.webContents.getURL();
	if (current_url.includes('example.html')) {
		win.loadFile('window/index.html');
	} else {
		win.loadFile('window/example.html');
	}
}

// Window creation function
function createWindow(initial_cwd) {
	Menu.setApplicationMenu(null);

	const win = new BrowserWindow({
		width: 800,
		height: 600,
		frame: false,
		transparent: true,
		backgroundColor: '#00000000',
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false
		}
	});

	win.removeMenu();

	win.webContents.on('before-input-event', (event, input) => {
		if (input.type !== 'keyDown') return;

		if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
			win.reload();
			event.preventDefault();
		}
		if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i') {
			win.webContents.toggleDevTools();
			event.preventDefault();
		}
		if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'd') {
			toggleDebugMode(win);
			event.preventDefault();
		}
	});

	win.loadFile('window/index.html');

	win.webContents.once('did-finish-load', () => {
		const cwd = initial_cwd || process.cwd();
		const session = new ShellSession(win.webContents, cwd);
		active_windows.set(win.webContents.id, { win, session });

		// Send the workspace repo map upon initialization
		const repo_map = generateRepoMap(cwd);

		win.webContents.send('window-init', {
			cwd: cwd,
			model: session.model,
			apiKeyConfigured: !!getApiKey(),
			repoMap: repo_map,
			availableCommands: getAvailableCommands()
		});
	});

	win.on('closed', () => {
		for (const [id, data] of active_windows.entries()) {
			if (data.win === win) {
				data.session.shell_proc.kill();
				active_windows.delete(id);
				break;
			}
		}
	});
}

// Single instance lock configuration
const got_the_lock = app.requestSingleInstanceLock();
if (!got_the_lock) {
	app.quit();
} else {
	app.on('second-instance', (event, command_line, working_directory) => {
		createWindow(working_directory);
	});
}

// App event listeners
app.whenReady().then(() => {
	createWindow();
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

// IPC event handlers
ipcMain.on('run-user-command', (event, command) => {
	const data = active_windows.get(event.sender.id);
	if (data) {
		data.session.writeCommand(command, info => {
			event.sender.send('shell-complete', info);
		});
	}
});

ipcMain.on('run-agent-prompt', (event, prompt) => {
	const data = active_windows.get(event.sender.id);
	if (data) {
		runAgentLoop(data.session, prompt);
	}
});

ipcMain.on('shell-interrupt', event => {
	const data = active_windows.get(event.sender.id);
	if (data) {
		data.session.interrupt();
	}
});

ipcMain.on('execute-slash-command', async (event, command_str) => {
	const data = active_windows.get(event.sender.id);
	if (!data) return;

	const clean_str = command_str.replace(/\xa0/g, ' ').trim();
	const args = clean_str.split(/\s+/);
	const command_name = args[0];

	if (command_name === '/exit') {
		data.win.close();
	} else if (command_name === '/clear') {
		if (data.session.messages) {
			data.session.messages = [];
		}
		// Renderer handles UI clearing
		event.sender.send('shell-complete', { exit_code: 0, cwd: data.session.current_cwd });
	} else if (command_name === '/provider' || command_name === '/providers') {
		const provider_name = args[1];
		const base_url = args[2];
		const api_key = args[3];

		const config = loadConfig();

		if (!provider_name) {
			let output = `Current provider: **${config.current_provider}**\n\nRegistered providers:\n`;
			for (const [name, info] of Object.entries(config.providers)) {
				output += `- **${name}**: ${info.base_url} (model: ${info.model || 'not set'})\n`;
			}
			event.sender.send('shell-output', { text: output, is_stderr: false });
		} else {
			if (!config.providers[provider_name]) {
				config.providers[provider_name] = {
					base_url: base_url || 'https://api.openai.com/v1',
					api_key: api_key || '',
					model: 'gpt-4o-mini'
				};
			} else {
				if (base_url) config.providers[provider_name].base_url = base_url;
				if (api_key) config.providers[provider_name].api_key = api_key;
			}
			config.current_provider = provider_name;
			saveConfig(config);

			const prov_info = config.providers[provider_name];
			data.session.model = prov_info.model || 'gpt-4o-mini';

			event.sender.send('shell-output', {
				text: `Active provider changed to **${provider_name}** (${prov_info.base_url})\n`,
				is_stderr: false
			});
		}
		event.sender.send('shell-complete', { exit_code: 0, cwd: data.session.current_cwd });
	} else if (command_name === '/model') {
		const target_model = args[1];
		const config = loadConfig();
		const active_prov_name = config.current_provider;

		if (target_model) {
			if (config.providers[active_prov_name]) {
				config.providers[active_prov_name].model = target_model;
			}
			data.session.model = target_model;
			saveConfig(config);
			event.sender.send('shell-output', {
				text: `Model successfully changed to **${target_model}** for provider **${active_prov_name}**.\n`,
				is_stderr: false
			});
		} else {
			const current_model = data.session.model || config.providers[active_prov_name]?.model || 'gpt-4o-mini';
			event.sender.send('shell-output', {
				text: `Current model is **${current_model}** (provider: **${active_prov_name}**)\n`,
				is_stderr: false
			});
		}
		event.sender.send('shell-complete', { exit_code: 0, cwd: data.session.current_cwd });
	} else if (command_name === '/models') {
		const config = loadConfig();
		const active_prov_name = config.current_provider;
		const active_prov = config.providers[active_prov_name] || {};
		const api_key = active_prov.api_key || 'none';
		const base_url = active_prov.base_url || undefined;

		event.sender.send('shell-output', {
			text: `Fetching models from provider **${active_prov_name}**...\n`,
			is_stderr: false
		});

		try {
			const openai = new OpenAI({
				apiKey: api_key,
				baseURL: base_url
			});

			const models_list = await callOpenAiWithRetry(signal => openai.models.list({ signal }));

			let output = `Available models for **${active_prov_name}**:\n`;
			const sorted_models = models_list.data.map(m => m.id).sort();
			sorted_models.forEach(model_id => {
				output += `- ${model_id}\n`;
			});
			event.sender.send('shell-output', { text: output, is_stderr: false });
			event.sender.send('shell-complete', { exit_code: 0, cwd: data.session.current_cwd });
		} catch (err) {
			event.sender.send('shell-output', {
				text: `Failed to fetch models: ${err.message}\n`,
				is_stderr: true
			});
			event.sender.send('shell-complete', { exit_code: 1, cwd: data.session.current_cwd });
		}
	} else if (command_name === '/api-key') {
		const key = args[1];
		const config = loadConfig();
		const active_prov = config.current_provider;

		if (key) {
			if (!config.providers[active_prov]) {
				config.providers[active_prov] = { base_url: '', api_key: '', model: '' };
			}
			config.providers[active_prov].api_key = key;
			const success = saveConfig(config);
			if (success) {
				event.sender.send('shell-output', {
					text: `API key saved successfully for provider **${active_prov}**.\n`,
					is_stderr: false
				});
			} else {
				event.sender.send('shell-output', {
					text: `Failed to save API key.\n`,
					is_stderr: true
				});
			}
		} else {
			const current_key = config.providers[active_prov]?.api_key || '';
			event.sender.send('shell-output', {
				text: current_key ? `API key is configured for provider **${active_prov}**.\n` : `No API key is configured for provider **${active_prov}**.\n`,
				is_stderr: false
			});
		}
		event.sender.send('shell-complete', { exit_code: 0, cwd: data.session.current_cwd });
	} else {
		event.sender.send('shell-output', {
			text: `Unknown slash command: ${command_name}\n`,
			is_stderr: true
		});
		event.sender.send('shell-complete', { exit_code: 1, cwd: data.session.current_cwd });
	}
});

ipcMain.on('request-state', event => {
	const data = active_windows.get(event.sender.id);
	if (data) {
		event.sender.send('window-init', {
			cwd: data.session.current_cwd,
			model: data.session.model,
			apiKeyConfigured: !!getApiKey(),
			repoMap: generateRepoMap(data.session.current_cwd),
			availableCommands: getAvailableCommands()
		});
	}
});

ipcMain.on('toggle-debug-mode', event => {
	const data = active_windows.get(event.sender.id);
	if (data) {
		toggleDebugMode(data.win);
	}
});
