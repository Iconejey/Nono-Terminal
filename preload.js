const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  isElectron: true,
  sendUserCommand: (command) => ipcRenderer.send("run-user-command", command),
  sendAgentPrompt: (prompt, usePro) =>
    ipcRenderer.send("run-agent-prompt", prompt, usePro),
  sendInterrupt: () => ipcRenderer.send("shell-interrupt"),
  onShellOutput: (callback) =>
    ipcRenderer.on("shell-output", (event, data) => callback(data)),
  onShellComplete: (callback) =>
    ipcRenderer.on("shell-complete", (event, info) => callback(info)),
  onAgentChunk: (callback) =>
    ipcRenderer.on("agent-chunk", (event, info) => callback(info)),
  onAgentComplete: (callback) =>
    ipcRenderer.on("agent-complete", (event) => callback()),
  onAgentToolStart: (callback) =>
    ipcRenderer.on("agent-tool-start", (event, info) => callback(info)),
  onAgentToolOutput: (callback) =>
    ipcRenderer.on("agent-tool-output", (event, info) => callback(info)),
  onAgentToolComplete: (callback) =>
    ipcRenderer.on("agent-tool-complete", (event, info) => callback(info)),
  onAgentStatus: (callback) =>
    ipcRenderer.on("agent-status", (event, status) => callback(status)),
  onWindowInit: (callback) =>
    ipcRenderer.on("window-init", (event, info) => callback(info)),
  onShowQrCode: (callback) =>
    ipcRenderer.on("show-qrcode", (event, info) => callback(info)),
  onHideQrCode: (callback) =>
    ipcRenderer.on("hide-qrcode", (event) => callback()),
  onPinnedDirsUpdated: (callback) =>
    ipcRenderer.on("pinned-dirs-updated", (event, info) => callback(info)),
  onShellCommandStart: (callback) =>
    ipcRenderer.on("shell-command-start", (event, info) => callback(info)),
  onAgentPromptStart: (callback) =>
    ipcRenderer.on("agent-prompt-start", (event, info) => callback(info)),
  executeSlashCommand: (command) =>
    ipcRenderer.send("execute-slash-command", command),
  sendApiKey: (key) => ipcRenderer.send("send-api-key", key),
  toggleDebugMode: () => ipcRenderer.send("toggle-debug-mode"),
  requestState: () => ipcRenderer.send("request-state"),
  readDir: (dirPath) => ipcRenderer.invoke("read-dir", dirPath),
  readFileContent: (filePath) =>
    ipcRenderer.invoke("read-file-content", filePath),
  saveFileContent: (filePath, content) =>
    ipcRenderer.invoke("save-file-content", filePath, content),
  unpinDir: (dirPath) => ipcRenderer.invoke("unpin-dir", dirPath),
  openInVsCode: (filePath) => ipcRenderer.invoke("open-in-vs-code", filePath),
  readGitStatus: () => ipcRenderer.invoke("read-git-status"),
  stageFile: (filePath) => ipcRenderer.invoke("git-stage-file", filePath),
  unstageFile: (filePath) => ipcRenderer.invoke("git-unstage-file", filePath),
  readFileDiff: (filePath) => ipcRenderer.invoke("read-file-diff", filePath),
  getScreenSourceId: () => ipcRenderer.invoke("get-screen-source-id"),
  sendWebRtcSignalToMobile: (socketId, signal) =>
    ipcRenderer.send("webrtc-signal-to-mobile", socketId, signal),
  onWebRtcSignal: (callback) =>
    ipcRenderer.on("webrtc-signal", (event, info) => callback(info)),
  onStartScreenStream: (callback) =>
    ipcRenderer.on("start-screen-stream", (event, info) => callback(info)),
  onStopScreenStream: (callback) =>
    ipcRenderer.on("stop-screen-stream", (event, info) => callback(info)),
  sendStreamCropUpdated: (socketId, region) =>
    ipcRenderer.send("stream-crop-updated", socketId, region),
  onUpdateCropRegion: (callback) =>
    ipcRenderer.on("update-crop-region", (event, info) => callback(info)),
  injectMouseMove: (coords) => ipcRenderer.send("inject-mouse-move", coords),
  injectMouseClick: (coords) => ipcRenderer.send("inject-mouse-click", coords),
  injectMouseRightClick: (coords) => ipcRenderer.send("inject-mouse-right-click", coords),
  injectMouseScroll: (delta) => ipcRenderer.send("inject-mouse-scroll", delta),
  injectText: (text) => ipcRenderer.send("inject-text", text),
  sendScreenBg: (socketId, jpegData) =>
    ipcRenderer.send("send-screen-bg", socketId, jpegData),
});
