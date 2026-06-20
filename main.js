const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const { spawn, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { OpenAI } = require("openai");
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const QRCode = require("qrcode");

const active_windows = new Map();
let web_server = null;
let io_server = null;
let server_port = 0;

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if ((iface.family === "IPv4" || iface.family === 4) && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

function sendToWindow(windowId, eventName, ...args) {
  const data = active_windows.get(windowId);
  if (data && data.win && !data.win.webContents.isDestroyed()) {
    data.win.webContents.send(eventName, ...args);
  }
  if (io_server) {
    io_server.to(`window_${windowId}`).emit(eventName, ...args);
  }
}

function startMobileServer() {
  if (web_server) {
    return Promise.resolve(server_port);
  }
  
  const expressApp = express();
  const httpServer = http.createServer(expressApp);
  io_server = socketIo(httpServer);
  
  expressApp.use(express.static(path.join(__dirname, "window")));
  
  io_server.on("connection", (socket) => {
    let joinedRoom = null;
    let screen_stream_interval = null;
    
    const getWindowData = (windowId) => {
      const wId = parseInt(windowId, 10);
      let data = active_windows.get(wId);
      if (!data && active_windows.size > 0) {
        const firstKey = active_windows.keys().next().value;
        data = active_windows.get(firstKey);
      }
      return data;
    };
    
    socket.on("register", async ({ windowId }) => {
      if (windowId) {
        const data = getWindowData(windowId);
        if (data) {
          const actualWindowId = data.win.webContents.id;
          joinedRoom = `window_${actualWindowId}`;
          socket.join(joinedRoom);
          console.log(`Socket client joined room: ${joinedRoom} (requested: ${windowId})`);
          
          // Hide QR code modal in Electron window when mobile client connects
          sendToWindow(actualWindowId, "hide-qrcode");
          
          let historyHtml = "";
          try {
            historyHtml = await data.win.webContents.executeJavaScript(`
              (function() {
                const container = document.getElementById("terminal-chat-container");
                if (!container) return "";
                const children = Array.from(container.children);
                const historyChildren = children.filter(child => child.id !== "active-chat-block");
                return historyChildren.map(child => child.outerHTML).join("");
              })()
            `);
          } catch (err) {
            console.error("Failed to retrieve history HTML on register:", err);
          }
          socket.emit("window-init", {
            windowId: actualWindowId,
            cwd: data.session.current_cwd,
            model: data.session.model,
            apiKeyConfigured: !!getApiKey(),
            repoMap: generateRepoMap(data.session.current_cwd),
            availableCommands: getAvailableCommands(),
            historyHtml: historyHtml,
            pinnedDirs: getPinnedDirectories(),
            homeDir: os.homedir(),
          });
        }
      }
    });
    
    socket.on("run-user-command", ({ windowId, command }) => {
      const data = getWindowData(windowId);
      if (data) {
        const actualId = data.win.webContents.id;
        sendToWindow(actualId, "shell-command-start", { command });
        data.session.writeCommand(command, (info) => {
          sendToWindow(actualId, "shell-complete", info);
        });
      }
    });
    
    socket.on("run-agent-prompt", ({ windowId, prompt, usePro }) => {
      const data = getWindowData(windowId);
      if (data) {
        const actualId = data.win.webContents.id;
        sendToWindow(actualId, "agent-prompt-start", { prompt, usePro });
        runAgentLoop(data.session, prompt, usePro);
      }
    });
    
    socket.on("shell-interrupt", ({ windowId }) => {
      const data = getWindowData(windowId);
      if (data) {
        data.session.interrupt();
      }
    });
    
    socket.on("execute-slash-command", ({ windowId, command }) => {
      const data = getWindowData(windowId);
      if (data) {
        executeSlashCommandForWindow(data.win.webContents.id, command);
      }
    });
    
    socket.on("request-state", async ({ windowId }) => {
      const data = getWindowData(windowId);
      if (data) {
        const actualWindowId = data.win.webContents.id;
        let historyHtml = "";
        try {
          historyHtml = await data.win.webContents.executeJavaScript(`
            (function() {
              const container = document.getElementById("terminal-chat-container");
              if (!container) return "";
              const children = Array.from(container.children);
              const historyChildren = children.filter(child => child.id !== "active-chat-block");
              return historyChildren.map(child => child.outerHTML).join("");
            })()
          `);
        } catch (err) {
          console.error("Failed to retrieve history HTML on request-state:", err);
        }
         socket.emit("window-init", {
          windowId: actualWindowId,
          cwd: data.session.current_cwd,
          model: data.session.model,
          apiKeyConfigured: !!getApiKey(),
          repoMap: generateRepoMap(data.session.current_cwd),
          availableCommands: getAvailableCommands(),
          historyHtml: historyHtml,
          pinnedDirs: getPinnedDirectories(),
          homeDir: os.homedir(),
        });
      }
    });
    
    socket.on("toggle-debug-mode", ({ windowId }) => {
      const data = getWindowData(windowId);
      if (data) {
        toggleDebugMode(data.win);
      }
    });
    
    socket.on("read-dir", ({ windowId, dirPath }, callback) => {
      const data = getWindowData(windowId);
      const base = data ? data.session.current_cwd : process.cwd();
      const resolved = path.resolve(base, dirPath || ".");
      const res = listDirectory(resolved);
      if (res.error) {
        callback({ resolved, error: res.error, code: res.code });
      } else {
        callback({ resolved, items: res });
      }
    });

    socket.on("unpin-dir", ({ windowId, dirPath }, callback) => {
      const pinned_dirs = getPinnedDirectories();
      const idx = pinned_dirs.indexOf(dirPath);
      if (idx !== -1) {
        pinned_dirs.splice(idx, 1);
        savePinnedDirectories(pinned_dirs);
        const data = getWindowData(windowId);
        if (data) {
          const actual_window_id = data.win.webContents.id;
          sendToWindow(actual_window_id, "pinned-dirs-updated", {
            pinned_dirs: pinned_dirs,
            home_dir: os.homedir(),
          });
        }
        if (callback) callback({ success: true, pinned_dirs: pinned_dirs });
      } else {
        if (callback) callback({ success: false, error: "Directory not found in pinned list" });
      }
    });
    
    socket.on("read-file-content", ({ windowId, filePath }, callback) => {
      const data = getWindowData(windowId);
      const base = data ? data.session.current_cwd : process.cwd();
      const resolved = path.resolve(base, filePath);
      try {
        const content = fs.readFileSync(resolved, "utf8");
        callback({ resolved, content });
      } catch (err) {
        callback({ resolved, error: err.message, code: err.code });
      }
    });
    
    socket.on("save-file-content", async ({ windowId, filePath, content }, callback) => {
      const data = getWindowData(windowId);
      const base = data ? data.session.current_cwd : process.cwd();
      const resolved = path.resolve(base, filePath);
      try {
        let formattedContent = content;
        let formatted = false;
        try {
          const prettier = require("prettier");
          const fileInfo = await prettier.getFileInfo(resolved);
          if (fileInfo && !fileInfo.ignored && fileInfo.inferredParser) {
            const vscodeConfig = getVsCodePrettierConfig();
            const projectConfig = await prettier.resolveConfig(resolved);
            formattedContent = await prettier.format(content, {
              ...vscodeConfig,
              ...projectConfig,
              parser: fileInfo.inferredParser,
            });
            formatted = true;
          }
        } catch (prettierErr) {
          console.error("Prettier formatting failed:", prettierErr);
        }
        fs.writeFileSync(resolved, formattedContent, "utf8");
        callback({ resolved, success: true, formatted, formattedContent });
      } catch (err) {
        callback({ resolved, error: err.message, code: err.code });
      }
    });
    
    socket.on("open-in-vs-code", ({ windowId, filePath }, callback) => {
      const data = getWindowData(windowId);
      const base = data ? data.session.current_cwd : process.cwd();
      const resolved = path.resolve(base, filePath);
      exec(`code "${resolved}"`, (err) => {
        if (err) callback({ error: err.message });
        else callback({ success: true });
      });
    });
    
    socket.on("read-git-status", async ({ windowId }, callback) => {
      const data = getWindowData(windowId);
      const base = data ? data.session.current_cwd : process.cwd();
      exec("git status --porcelain", { cwd: base }, (err, stdout, stderr) => {
        if (err && err.code !== 0) {
          callback({ error: stderr || err.message });
          return;
        }
        const lines = stdout.split("\n");
        const staged = [];
        const unstaged = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const x = line[0];
          const y = line[1];
          let filePath = line.substring(3).trim();
          if (filePath.startsWith('"') && filePath.endsWith('"')) {
            filePath = filePath.substring(1, filePath.length - 1);
          }
          if (x !== " " && x !== "?") {
            let type = "edit";
            if (x === "A") type = "addition";
            else if (x === "D") type = "deletion";
            staged.push({ path: filePath, type });
          }
          if (y !== " " && y !== undefined) {
            let type = "edit";
            if (y === "A" || x === "?") type = "addition";
            else if (y === "D") type = "deletion";
            unstaged.push({ path: filePath, type });
          } else if (x === "?") {
            unstaged.push({ path: filePath, type: "addition" });
          }
        }
        callback({ staged, unstaged });
      });
    });

    socket.on("git-stage-file", ({ windowId, filePath }, callback) => {
      const data = getWindowData(windowId);
      const base = data ? data.session.current_cwd : process.cwd();
      exec(`git add "${filePath}"`, { cwd: base }, (err, stdout, stderr) => {
        if (err) callback({ error: stderr || err.message });
        else callback({ success: true });
      });
    });

    socket.on("git-unstage-file", ({ windowId, filePath }, callback) => {
      const data = getWindowData(windowId);
      const base = data ? data.session.current_cwd : process.cwd();
      exec(`git reset HEAD "${filePath}"`, { cwd: base }, (err, stdout, stderr) => {
        if (err) callback({ error: stderr || err.message });
        else callback({ success: true });
      });
    });

    socket.on("read-file-diff", ({ windowId, filePath }, callback) => {
      const data = getWindowData(windowId);
      const base = data ? data.session.current_cwd : process.cwd();
      const resolved = path.resolve(base, filePath);
      exec(`git status --porcelain -- "${resolved}"`, { cwd: base }, (err, stdout, stderr) => {
        if (err) {
          callback({ resolved, error: stderr || err.message });
          return;
        }
        const isUntracked = stdout.startsWith("??");
        let diffCmd = `git diff HEAD -U999999 -- "${resolved}"`;
        if (isUntracked) {
          diffCmd = `git diff --no-index -U999999 -- /dev/null "${resolved}"`;
        }
        exec(diffCmd, { cwd: base }, (diffErr, diffStdout, diffStderr) => {
          if (diffErr && diffErr.code !== 1 && diffErr.code !== 0) {
            callback({ resolved, error: diffStderr || diffErr.message });
            return;
          }
          callback({ resolved, diff: diffStdout });
        });
      });
    });

    socket.on("start-screen-stream", () => {
      console.log("Socket client requested screen stream start");
      if (screen_stream_interval) {
        clearInterval(screen_stream_interval);
      }
      
      const captureAndSend = () => {
        const { desktopCapturer } = require("electron");
        desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1280, height: 720 } }).then(sources => {
          if (sources.length > 0) {
            const source = sources[0];
            const jpeg_buffer = source.thumbnail.toJPEG(80);
            const base64_str = jpeg_buffer.toString("base64");
            const data_url = `data:image/jpeg;base64,${base64_str}`;
            socket.emit("screen-frame", { dataUrl: data_url });
          }
        }).catch(err => {
          console.error("Screen capture failed:", err);
        });
      };

      captureAndSend();
      screen_stream_interval = setInterval(captureAndSend, 1000);
    });

    socket.on("stop-screen-stream", () => {
      console.log("Socket client requested screen stream stop");
      if (screen_stream_interval) {
        clearInterval(screen_stream_interval);
        screen_stream_interval = null;
      }
    });

    socket.on("disconnect", () => {
      console.log("Socket client disconnected");
      if (screen_stream_interval) {
        clearInterval(screen_stream_interval);
        screen_stream_interval = null;
      }
    });
  });
  
  return new Promise((resolve) => {
    httpServer.listen(0, "0.0.0.0", () => {
      server_port = httpServer.address().port;
      web_server = httpServer;
      console.log(`Mobile Express/Socket.io server started on port ${server_port}`);
      resolve(server_port);
    });
  });
}

async function executeSlashCommandForWindow(windowId, command_str) {
  const data = active_windows.get(windowId);
  if (!data) return;

  const clean_str = command_str.replace(/\xa0/g, " ").trim();
  const args = clean_str.split(/\s+/);
  const command_name = args[0];

  if (command_name === "/exit") {
    data.win.close();
  } else if (command_name === "/clear") {
    if (data.session.messages) {
      data.session.messages = [];
    }
    sendToWindow(windowId, "shell-complete", {
      exit_code: 0,
      cwd: data.session.current_cwd,
    });
  } else if (
    ["/provider", "/providers", "/model", "/models", "/api-key"].includes(
      command_name,
    )
  ) {
    sendToWindow(windowId, "shell-output", {
      text: `Slash command ${command_name} is deprecated. Configuration is now managed via config.json.\n`,
      is_stderr: true,
    });
    sendToWindow(windowId, "shell-complete", {
      exit_code: 1,
      cwd: data.session.current_cwd,
    });
  } else if (command_name === "/mobile") {
    try {
      const port = await startMobileServer();
      const ip = getLocalIpAddress();
      const url = `http://${ip}:${port}/?windowId=${windowId}`;
      const qrCodeDataUrl = await QRCode.toDataURL(url, { margin: 0, width: 512 });
      
      // Send the QR code back to the Electron window
      sendToWindow(windowId, "show-qrcode", { url, qrCodeDataUrl });
      
      // Print a message to the shell output
      sendToWindow(windowId, "shell-output", {
        text: `Mobile connection server running at: ${url}\n`,
        is_stderr: false,
      });
      sendToWindow(windowId, "shell-complete", {
        exit_code: 0,
        cwd: data.session.current_cwd,
      });
    } catch (err) {
      sendToWindow(windowId, "shell-output", {
        text: `Failed to start mobile server: ${err.message}\n`,
        is_stderr: true,
      });
      sendToWindow(windowId, "shell-complete", {
        exit_code: 1,
        cwd: data.session.current_cwd,
      });
    }
  } else if (command_name === "/add-pin") {
    let pin_path = args.slice(1).join(" ").trim();
    if (!pin_path) {
      pin_path = data.session.current_cwd;
    } else {
      pin_path = path.resolve(data.session.current_cwd, pin_path);
    }

    try {
      if (!fs.existsSync(pin_path) || !fs.statSync(pin_path).isDirectory()) {
        sendToWindow(windowId, "shell-output", {
          text: `Error: "${pin_path}" is not a valid directory.\n`,
          is_stderr: true,
        });
        sendToWindow(windowId, "shell-complete", {
          exit_code: 1,
          cwd: data.session.current_cwd,
        });
        return;
      }

      const pinned_dirs = getPinnedDirectories();
      if (pinned_dirs.includes(pin_path)) {
        sendToWindow(windowId, "shell-output", {
          text: `Directory already pinned: ${pin_path}\n`,
          is_stderr: false,
        });
      } else {
        pinned_dirs.push(pin_path);
        savePinnedDirectories(pinned_dirs);
        sendToWindow(windowId, "shell-output", {
          text: `Successfully pinned directory: ${pin_path}\n`,
          is_stderr: false,
        });
        sendToWindow(windowId, "pinned-dirs-updated", {
          pinned_dirs: pinned_dirs,
          home_dir: os.homedir(),
        });
      }
      sendToWindow(windowId, "shell-complete", {
        exit_code: 0,
        cwd: data.session.current_cwd,
      });
    } catch (err) {
      sendToWindow(windowId, "shell-output", {
        text: `Error pinning directory: ${err.message}\n`,
        is_stderr: true,
      });
      sendToWindow(windowId, "shell-complete", {
        exit_code: 1,
        cwd: data.session.current_cwd,
      });
    }
  } else {
    sendToWindow(windowId, "shell-output", {
      text: `Unknown slash command: ${command_name}\n`,
      is_stderr: true,
    });
    sendToWindow(windowId, "shell-complete", {
      exit_code: 1,
      cwd: data.session.current_cwd,
    });
  }
}

const pinned_dirs_path = path.join(__dirname, "pinned_directories.json");

function getPinnedDirectories() {
  try {
    if (fs.existsSync(pinned_dirs_path)) {
      const content = fs.readFileSync(pinned_dirs_path, "utf8");
      return JSON.parse(content);
    }
  } catch (err) {
    console.error("Error reading pinned_directories.json:", err.message);
  }
  return [];
}

function savePinnedDirectories(dirs) {
  try {
    fs.writeFileSync(pinned_dirs_path, JSON.stringify(dirs, null, 2), "utf8");
  } catch (err) {
    console.error("Error writing pinned_directories.json:", err.message);
  }
}

function getProviderBaseUrl(provider) {
  if (!provider) return undefined;
  const lower = provider.toLowerCase();
  if (lower === "openai") {
    return "https://api.openai.com/v1";
  }
  if (lower === "gemini") {
    return "https://generativelanguage.googleapis.com/v1beta/openai/";
  }
  if (provider.startsWith("http://") || provider.startsWith("https://")) {
    return provider;
  }
  return undefined;
}

function loadConfig() {
  const default_config_path = path.join(__dirname, "default_config.json");
  const config_path = path.join(__dirname, "config.json");

  let config = {
    api_key: "",
    flash_model: "gemini-3.5-flash",
    pro_model: "gemini-3.1-pro-preview",
  };

  try {
    if (fs.existsSync(default_config_path)) {
      const defaults = JSON.parse(fs.readFileSync(default_config_path, "utf8"));
      config = { ...config, ...defaults };
    }
  } catch (err) {
    console.error("Error loading default_config.json:", err.message);
  }

  try {
    if (fs.existsSync(config_path)) {
      const overrides = JSON.parse(fs.readFileSync(config_path, "utf8"));
      config = { ...config, ...overrides };
    }
  } catch (err) {
    console.error("Error loading config.json:", err.message);
  }

  return config;
}

function getApiKey() {
  const config = loadConfig();
  return config.api_key || "";
}

let cached_commands = null;

function getAvailableCommands() {
  if (cached_commands) {
    return cached_commands;
  }

  const commands = new Set();
  const shell_builtins = [
    "cd",
    "echo",
    "eval",
    "exec",
    "exit",
    "export",
    "read",
    "set",
    "unset",
    "alias",
    "unalias",
    "pushd",
    "popd",
    "dirs",
    "history",
    "history-list",
    "source",
    "bg",
    "fg",
    "jobs",
    "type",
    "which",
    "pwd",
  ];
  shell_builtins.forEach((cmd) => commands.add(cmd));

  const path_env = process.env.PATH || "";
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
    this.webContentsId = web_contents.id;
    this.current_cwd = initial_cwd || process.cwd();
    this.stdout_buffer = "";
    this.stderr_buffer = "";
    this.active_command_callback = null;
    const config = loadConfig();
    this.model = config.flash_model || "gemini-3.5-flash";
    this.messages = [];

    this.shell_proc = spawn("/bin/bash", [], {
      cwd: this.current_cwd,
      env: { ...process.env, PS1: "" },
    });

    this.setupListeners();
  }

  setupListeners() {
    this.shell_proc.stdout.on("data", (chunk) => {
      this.handleOutput(chunk.toString(), false);
    });

    this.shell_proc.stderr.on("data", (chunk) => {
      this.handleOutput(chunk.toString(), true);
    });

    this.shell_proc.on("close", (code) => {
      console.log("Shell closed with code:", code);
    });
  }

  handleOutput(data, is_stderr) {
    const buffer_name = is_stderr ? "stderr_buffer" : "stdout_buffer";
    this[buffer_name] += data;

    let lines = this[buffer_name].split("\n");
    this[buffer_name] = lines.pop();

    for (const line of lines) {
      const delim_index = line.indexOf("__NONO_CMD_END__");
      if (delim_index !== -1) {
        const prefix = line.substring(0, delim_index);
        if (prefix) {
          sendToWindow(this.webContentsId, "shell-output", { text: prefix, is_stderr });
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
        sendToWindow(this.webContentsId, "shell-output", {
          text: line + "\n",
          is_stderr,
        });
      }
    }
  }

  writeCommand(command, callback) {
    this.active_command_callback = callback;
    this.shell_proc.stdin.write(command + "\n");
    this.shell_proc.stdin.write('echo "__NONO_CMD_END__ $? $PWD"\n');
  }

  interrupt() {
    // Send SIGINT to direct children of the bash shell PID
    exec(`pkill -INT -P ${this.shell_proc.pid}`, (err) => {
      if (err) {
        console.warn("pkill SIGINT failed:", err.message);
      }
    });
  }
}

// Tool functions
function listDirectory(dir_path) {
  try {
    const files = fs.readdirSync(dir_path);
    return files.map((file) => {
      const full_path = path.join(dir_path, file);
      const stat = fs.statSync(full_path);
      return {
        name: file,
        is_directory: stat.isDirectory(),
        size: stat.size,
      };
    });
  } catch (err) {
    return { error: err.message, code: err.code };
  }
}

function getVsCodePrettierConfig() {
  try {
    const homedir = os.homedir();
    const settingsPath = path.join(
      homedir,
      ".config",
      "Code",
      "User",
      "settings.json",
    );
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, "utf8");
      const cleanJson = content.replace(
        /\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm,
        "$1",
      );
      const settings = JSON.parse(cleanJson);
      const prettierConfig = {};
      for (const key in settings) {
        if (key.startsWith("prettier.")) {
          prettierConfig[key.substring(9)] = settings[key];
        }
      }
      return prettierConfig;
    }
  } catch (err) {
    console.error("Failed to load VS Code settings for Prettier:", err.message);
  }
  return {};
}

async function performWebSearch(query, api_key, model_name) {
  try {
    const config = loadConfig();
    const active_model = model_name || config.flash_model || "gemini-3.5-flash";
    const is_new_model = active_model.includes("gemini-3") || active_model.includes("gemini-2.5");
    const tool_obj = is_new_model ? { google_search: {} } : { google_search_retrieval: {} };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${active_model}:generateContent?key=${api_key}`;
    const payload = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Perform a search for the following query and summarize the key findings with sources: ${query}`
            }
          ]
        }
      ],
      tools: [tool_obj]
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error_text = await response.text();
      return { error: `Gemini API returned status ${response.status}: ${error_text}` };
    }

    const data = await response.json();
    if (data.candidates && data.candidates[0] && data.candidates[0].content) {
      const text = data.candidates[0].content.parts[0].text;
      const metadata = data.candidates[0].groundingMetadata || {};
      return {
        answer: text,
        groundingMetadata: metadata
      };
    } else {
      return { error: "No candidates returned from Gemini API", raw_response: data };
    }
  } catch (err) {
    console.error("Web Search Error:", err.message);
    return { error: err.message };
  }
}

function readFile(file_path, start_line, end_line) {
  try {
    const content = fs.readFileSync(file_path, "utf8");
    const lines = content.split("\n");
    const start = start_line ? Math.max(1, start_line) - 1 : 0;
    const end = end_line ? Math.min(lines.length, end_line) : lines.length;
    const sliced = lines.slice(start, end);
    return {
      content: sliced.join("\n"),
      total_lines: lines.length,
      start_line: start + 1,
      end_line: end,
    };
  } catch (err) {
    return { error: err.message };
  }
}

function editFile(file_path, search_content, replace_content) {
  try {
    const content = fs.readFileSync(file_path, "utf8");
    const occurrences = content.split(search_content).length - 1;
    if (occurrences === 0) {
      return {
        error:
          "Search content not found in the file. Make sure the search content matches exactly.",
      };
    }
    if (occurrences > 1) {
      return {
        error:
          "Search content is not unique. Found " +
          occurrences +
          " occurrences. Please provide a more specific search block.",
      };
    }
    const updated_content = content.replace(search_content, replace_content);
    fs.writeFileSync(file_path, updated_content, "utf8");
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
}

function loadGitignore(dir_path) {
  const rules = [".git", "node_modules"];
  try {
    const gitignore_path = path.join(dir_path, ".gitignore");
    if (fs.existsSync(gitignore_path)) {
      const content = fs.readFileSync(gitignore_path, "utf8");
      content.split("\n").forEach((line) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
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
    let clean_rule = rule.replace(/\/$/, "");
    if (clean_rule.startsWith("/")) {
      if (
        relative_path === clean_rule.substring(1) ||
        relative_path.startsWith(clean_rule.substring(1) + "/")
      ) {
        return true;
      }
    } else {
      if (
        file_name === clean_rule ||
        relative_path.split("/").includes(clean_rule)
      ) {
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
      const text_extensions = [
        ".js",
        ".json",
        ".html",
        ".css",
        ".md",
        ".txt",
        ".sh",
        ".py",
        ".ts",
        ".tsx",
        ".jsx",
        ".jsonld",
        ".yml",
        ".yaml",
      ];
      if (!text_extensions.includes(ext)) {
        return;
      }
      const content = fs.readFileSync(full_path, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        if (line.includes(query)) {
          matches.push({
            path: relative_path,
            line_number: index + 1,
            line_content: line.trim(),
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

  function buildTree(dir, prefix = "") {
    const files = fs.readdirSync(dir);
    const sorted = files
      .map((file) => {
        const full_path = path.join(dir, file);
        const stat = fs.statSync(full_path);
        return { file, is_dir: stat.isDirectory(), full_path };
      })
      .filter((item) => {
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
      const marker = is_last ? "└── " : "├── ";
      tree_lines.push(prefix + marker + item.file);
      if (item.is_dir) {
        const next_prefix = prefix + (is_last ? "    " : "│   ");
        buildTree(item.full_path, next_prefix);
      }
    });
  }

  tree_lines.push("/");
  try {
    buildTree(base_dir);
  } catch (err) {
    tree_lines.push("Error generating repo map: " + err.message);
  }
  return tree_lines.join("\n");
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
      diff.unshift("  " + old_lines[i - 1]);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift("+ " + new_lines[j - 1]);
      j--;
    } else {
      diff.unshift("- " + old_lines[i - 1]);
      i--;
    }
  }
  return diff.join("\n");
}

// System prompt builder
function getSystemPrompt(cwd) {
  const os_platform = process.platform;
  const shell_type = os_platform === "win32" ? "cmd/powershell" : "bash";
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
4. Be concise and act like a senior developer assistant. Do not explain things unless asked.
5. You can create clickable links to files in your responses using the markdown link syntax [file_name](file:file_path) (e.g. [main.js](file:main.js) or [style.css](file:window/style.css)). Prefer doing this when referencing files in the workspace.`;
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
      if (err.name === "AbortError" || err.code === "ETIMEDOUT") {
        console.warn(
          `OpenAI call timed out. Retrying attempt ${i + 2}/${attempts}...`,
        );
        if (i === attempts - 1) {
          throw new Error(
            "OpenAI request timed out after " + attempts + " attempts.",
          );
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
    if (
      msg.role === "tool" &&
      (msg.name === "read_file" || msg.name === "search_codebase")
    ) {
      read_tool_count++;
      if (read_tool_count > max_keep) {
        msg.content = "[Output truncated to save context window]";
      }
    }
  }
}

// Tool definitions for OpenAI
const tools_definition = [
  {
    type: "function",
    function: {
      name: "execute_command",
      description:
        "Runs a command in the persistent shell and returns its stdout and stderr outputs.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Reads lines from a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The absolute or relative path to the file.",
          },
          start_line: {
            type: "integer",
            description:
              "The 1-indexed line number to start reading from (inclusive).",
          },
          end_line: {
            type: "integer",
            description:
              "The 1-indexed line number to stop reading at (inclusive).",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edits an existing file in the workspace by performing a search-and-replace of a unique block.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The absolute or relative path to the file.",
          },
          search_content: {
            type: "string",
            description: "The exact lines/block of code to be replaced.",
          },
          replace_content: {
            type: "string",
            description:
              "The new lines/block of code to replace the search content with.",
          },
        },
        required: ["path", "search_content", "replace_content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_codebase",
      description:
        "Searches the workspace files recursively for a given query string (native grep-like).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The string pattern to search for in files.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "Lists the contents of a directory in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The absolute or relative path to the directory.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Searches the web for the given query using Google Search grounding and returns grounded answers with sources.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to look up on the web.",
          },
        },
        required: ["query"],
      },
    },
  },
];

// Agent execution loop
async function runAgentLoop(session, prompt, usePro) {
  const web_contents = {
    send: (channel, ...args) => sendToWindow(session.webContentsId, channel, ...args)
  };
  const config = loadConfig();
  const model_name = usePro ? config.pro_model : config.flash_model;

  if (!config.api_key) {
    web_contents.send("agent-chunk", {
      text: `Error: API Key is not configured in config.json / default_config.json.`,
    });
    web_contents.send("agent-complete");
    return;
  }

  if (!session.messages) {
    session.messages = [];
  }

  session.messages.push({ role: "user", content: prompt });
  truncateOldReadFiles(session.messages);

  let consecutive_errors = 0;

  try {
    const openai = new OpenAI({
      apiKey: config.api_key,
      baseURL: getProviderBaseUrl("gemini"),
    });
    let loop_count = 0;
    const max_loops = 15;

    while (loop_count < max_loops) {
      loop_count++;

      const system_msg = {
        role: "system",
        content: getSystemPrompt(session.current_cwd),
      };
      if (
        session.messages.length > 0 &&
        session.messages[0].role === "system"
      ) {
        session.messages[0] = system_msg;
      } else {
        session.messages.unshift(system_msg);
      }

      web_contents.send("agent-status", "Thinking...");

      const response = await callOpenAiWithRetry((signal) =>
        openai.chat.completions.create(
          {
            model: model_name,
            messages: session.messages,
            tools: tools_definition,
          },
          { signal },
        ),
      );

      const choice = response.choices[0];
      const message = choice.message;

      session.messages.push(message);

      if (message.content) {
        web_contents.send("agent-chunk", { text: message.content });
      }

      if (!message.tool_calls || message.tool_calls.length === 0) {
        break;
      }

      for (const tool_call of message.tool_calls) {
        const name = tool_call.function.name;
        const args = JSON.parse(tool_call.function.arguments);

        web_contents.send("agent-tool-start", {
          name,
          args,
          tool_call_id: tool_call.id,
        });

        let tool_result;
        let is_error = false;

        try {
          if (name === "execute_command") {
            tool_result = await new Promise((resolve) => {
              session.writeCommand(args.command, (info) => {
                resolve(
                  JSON.stringify({ exit_code: info.exit_code, cwd: info.cwd }),
                );
              });
            });
            if (JSON.parse(tool_result).exit_code !== 0) {
              is_error = true;
            }
          } else if (name === "read_file") {
            const res = readFile(
              path.resolve(session.current_cwd, args.path),
              args.start_line,
              args.end_line,
            );
            if (res.error) {
              is_error = true;
            }
            tool_result = JSON.stringify(res);
          } else if (name === "edit_file") {
            const abs_path = path.resolve(session.current_cwd, args.path);
            const old_content = fs.existsSync(abs_path)
              ? fs.readFileSync(abs_path, "utf8")
              : "";
            const res = editFile(
              abs_path,
              args.search_content,
              args.replace_content,
            );
            if (res.error) {
              is_error = true;
              tool_result = JSON.stringify(res);
            } else {
              const diff = computeLineDiff(
                args.search_content.split("\n"),
                args.replace_content.split("\n"),
              );
              web_contents.send("agent-tool-output", {
                tool_call_id: tool_call.id,
                text: diff,
              });
              tool_result = JSON.stringify(res);
            }
          } else if (name === "search_codebase") {
            const res = searchCodebase(args.query, session.current_cwd);
            tool_result = JSON.stringify(res);
          } else if (name === "list_directory") {
            const res = listDirectory(
              path.resolve(session.current_cwd, args.path || "."),
            );
            if (res.error) {
              is_error = true;
            }
            tool_result = JSON.stringify(res);
          } else if (name === "web_search") {
            const res = await performWebSearch(args.query, config.api_key, config.flash_model);
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

        web_contents.send("agent-tool-complete", {
          tool_call_id: tool_call.id,
          result: tool_result,
        });

        if (is_error) {
          consecutive_errors++;
          if (consecutive_errors >= 3) {
            web_contents.send("agent-chunk", {
              text: "\n\n**[Error Loop Halted]** The agent encountered consecutive errors. Please intervene manually.\n",
            });
            web_contents.send("agent-complete");
            return;
          }
        } else {
          consecutive_errors = 0;
        }

        session.messages.push({
          role: "tool",
          tool_call_id: tool_call.id,
          name: name,
          content: tool_result,
        });
      }
    }
  } catch (err) {
    web_contents.send("agent-chunk", { text: `\n\n**Error:** ${err.message}` });
  } finally {
    web_contents.send("agent-complete");
  }
}

function toggleDebugMode(win) {
  const current_url = win.webContents.getURL();
  if (current_url.includes("example.html")) {
    win.loadFile("window/index.html");
  } else {
    win.loadFile("window/example.html");
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
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.removeMenu();

  // Open external links in the default browser instead of the Electron window
  win.webContents.on("will-navigate", (event, url) => {
    if (
      url !== win.webContents.getURL() &&
      (url.startsWith("http://") || url.startsWith("https://"))
    ) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    if ((input.control || input.meta) && input.key.toLowerCase() === "r") {
      win.reload();
      event.preventDefault();
    }
    if (
      (input.control || input.meta) &&
      input.shift &&
      input.key.toLowerCase() === "i"
    ) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
    if (
      (input.control || input.meta) &&
      input.shift &&
      input.key.toLowerCase() === "d"
    ) {
      toggleDebugMode(win);
      event.preventDefault();
    }
  });

  win.loadFile("window/index.html");

  win.webContents.once("did-finish-load", () => {
    const cwd = os.homedir();
    const session = new ShellSession(win.webContents, cwd);
    active_windows.set(win.webContents.id, { win, session });

    // Send the workspace repo map upon initialization
    const repo_map = generateRepoMap(cwd);

    win.webContents.send("window-init", {
      cwd: cwd,
      model: session.model,
      apiKeyConfigured: !!getApiKey(),
      repoMap: repo_map,
      availableCommands: getAvailableCommands(),
      pinnedDirs: getPinnedDirectories(),
      homeDir: os.homedir(),
    });
  });

  win.on("closed", () => {
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
  app.on("second-instance", (event, command_line, working_directory) => {
    createWindow(working_directory);
  });
}

// App event listeners
app.whenReady().then(() => {
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// IPC event handlers
ipcMain.on("run-user-command", (event, command) => {
  const data = active_windows.get(event.sender.id);
  if (data) {
    sendToWindow(event.sender.id, "shell-command-start", { command });
    data.session.writeCommand(command, (info) => {
      sendToWindow(event.sender.id, "shell-complete", info);
    });
  }
});

ipcMain.on("run-agent-prompt", (event, prompt, usePro) => {
  const data = active_windows.get(event.sender.id);
  if (data) {
    sendToWindow(event.sender.id, "agent-prompt-start", { prompt, usePro });
    runAgentLoop(data.session, prompt, usePro);
  }
});

ipcMain.on("shell-interrupt", (event) => {
  const data = active_windows.get(event.sender.id);
  if (data) {
    data.session.interrupt();
  }
});

ipcMain.on("execute-slash-command", async (event, command_str) => {
  executeSlashCommandForWindow(event.sender.id, command_str);
});

ipcMain.on("request-state", (event) => {
  const data = active_windows.get(event.sender.id);
  if (data) {
    sendToWindow(event.sender.id, "window-init", {
      cwd: data.session.current_cwd,
      model: data.session.model,
      apiKeyConfigured: !!getApiKey(),
      repoMap: generateRepoMap(data.session.current_cwd),
      availableCommands: getAvailableCommands(),
      pinnedDirs: getPinnedDirectories(),
      homeDir: os.homedir(),
    });
  }
});

ipcMain.on("toggle-debug-mode", (event) => {
  const data = active_windows.get(event.sender.id);
  if (data) {
    toggleDebugMode(data.win);
  }
});

ipcMain.handle("read-dir", async (event, dir_path) => {
  const data = active_windows.get(event.sender.id);
  const base = data ? data.session.current_cwd : process.cwd();
  const resolved = path.resolve(base, dir_path || ".");
  const res = listDirectory(resolved);
  if (res.error) return { resolved, error: res.error, code: res.code };
  return { resolved, items: res };
});

ipcMain.handle("unpin-dir", async (event, dir_path) => {
  const pinned_dirs = getPinnedDirectories();
  const idx = pinned_dirs.indexOf(dir_path);
  if (idx !== -1) {
    pinned_dirs.splice(idx, 1);
    savePinnedDirectories(pinned_dirs);
    sendToWindow(event.sender.id, "pinned-dirs-updated", {
      pinned_dirs: pinned_dirs,
      home_dir: os.homedir(),
    });
    return { success: true, pinned_dirs };
  }
  return { success: false, error: "Directory not found in pinned list" };
});

ipcMain.handle("read-file-content", async (event, file_path) => {
  const data = active_windows.get(event.sender.id);
  const base = data ? data.session.current_cwd : process.cwd();
  const resolved = path.resolve(base, file_path);
  try {
    const content = fs.readFileSync(resolved, "utf8");
    return { resolved, content };
  } catch (err) {
    return { resolved, error: err.message, code: err.code };
  }
});

ipcMain.handle("save-file-content", async (event, file_path, content) => {
  const data = active_windows.get(event.sender.id);
  const base = data ? data.session.current_cwd : process.cwd();
  const resolved = path.resolve(base, file_path);
  try {
    let formattedContent = content;
    let formatted = false;
    try {
      const prettier = require("prettier");
      const fileInfo = await prettier.getFileInfo(resolved);
      if (fileInfo && !fileInfo.ignored && fileInfo.inferredParser) {
        const vscodeConfig = getVsCodePrettierConfig();
        const projectConfig = await prettier.resolveConfig(resolved);
        formattedContent = await prettier.format(content, {
          ...vscodeConfig,
          ...projectConfig,
          parser: fileInfo.inferredParser,
        });
        formatted = true;
      }
    } catch (prettierErr) {
      console.error("Prettier formatting failed:", prettierErr);
    }
    fs.writeFileSync(resolved, formattedContent, "utf8");
    return { resolved, success: true, formatted, formattedContent };
  } catch (err) {
    return { resolved, error: err.message, code: err.code };
  }
});

ipcMain.handle("open-in-vs-code", async (event, file_path) => {
  const data = active_windows.get(event.sender.id);
  const base = data ? data.session.current_cwd : process.cwd();
  const resolved = path.resolve(base, file_path);
  return new Promise((resolve) => {
    exec(`code "${resolved}"`, (err) => {
      if (err) resolve({ error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle("read-git-status", async (event) => {
  const data = active_windows.get(event.sender.id);
  const base = data ? data.session.current_cwd : process.cwd();
  return new Promise((resolve) => {
    exec("git status --porcelain", { cwd: base }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        resolve({ error: stderr || err.message });
        return;
      }
      
      const lines = stdout.split("\n");
      const staged = [];
      const unstaged = [];
      
      for (const line of lines) {
        if (!line.trim()) continue;
        const x = line[0];
        const y = line[1];
        let filePath = line.substring(3).trim();
        if (filePath.startsWith('"') && filePath.endsWith('"')) {
          filePath = filePath.substring(1, filePath.length - 1);
        }
        
        // Staged status (Index)
        if (x !== " " && x !== "?") {
          let type = "edit";
          if (x === "A") type = "addition";
          else if (x === "D") type = "deletion";
          staged.push({ path: filePath, type });
        }
        
        // Unstaged status (Worktree)
        if (y !== " " && y !== undefined) {
          let type = "edit";
          if (y === "A" || x === "?") type = "addition";
          else if (y === "D") type = "deletion";
          unstaged.push({ path: filePath, type });
        } else if (x === "?") {
          unstaged.push({ path: filePath, type: "addition" });
        }
      }
      
      resolve({ staged, unstaged });
    });
  });
});

ipcMain.handle("git-stage-file", async (event, filePath) => {
  const data = active_windows.get(event.sender.id);
  const base = data ? data.session.current_cwd : process.cwd();
  return new Promise((resolve) => {
    exec(`git add "${filePath}"`, { cwd: base }, (err, stdout, stderr) => {
      if (err) resolve({ error: stderr || err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle("git-unstage-file", async (event, filePath) => {
  const data = active_windows.get(event.sender.id);
  const base = data ? data.session.current_cwd : process.cwd();
  return new Promise((resolve) => {
    exec(`git reset HEAD "${filePath}"`, { cwd: base }, (err, stdout, stderr) => {
      if (err) resolve({ error: stderr || err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle("read-file-diff", async (event, filePath) => {
  const data = active_windows.get(event.sender.id);
  const base = data ? data.session.current_cwd : process.cwd();
  const resolved = path.resolve(base, filePath);
  
  return new Promise((resolve) => {
    exec(`git status --porcelain -- "${resolved}"`, { cwd: base }, (err, stdout, stderr) => {
      if (err) {
        resolve({ resolved, error: stderr || err.message });
        return;
      }
      const isUntracked = stdout.startsWith("??");
      let diffCmd = `git diff HEAD -U999999 -- "${resolved}"`;
      if (isUntracked) {
        diffCmd = `git diff --no-index -U999999 -- /dev/null "${resolved}"`;
      }
      exec(diffCmd, { cwd: base }, (diffErr, diffStdout, diffStderr) => {
        if (diffErr && diffErr.code !== 1 && diffErr.code !== 0) {
          resolve({ resolved, error: diffStderr || diffErr.message });
          return;
        }
        resolve({ resolved, diff: diffStdout });
      });
    });
  });
});

