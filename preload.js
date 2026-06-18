const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  sendUserCommand: (command) => ipcRenderer.send('run-user-command', command),
  sendAgentPrompt: (prompt, usePro) => ipcRenderer.send('run-agent-prompt', prompt, usePro),
  sendInterrupt: () => ipcRenderer.send('shell-interrupt'),
  onShellOutput: (callback) => ipcRenderer.on('shell-output', (event, data) => callback(data)),
  onShellComplete: (callback) => ipcRenderer.on('shell-complete', (event, info) => callback(info)),
  onAgentChunk: (callback) => ipcRenderer.on('agent-chunk', (event, info) => callback(info)),
  onAgentComplete: (callback) => ipcRenderer.on('agent-complete', (event) => callback()),
  onAgentToolStart: (callback) => ipcRenderer.on('agent-tool-start', (event, info) => callback(info)),
  onAgentToolOutput: (callback) => ipcRenderer.on('agent-tool-output', (event, info) => callback(info)),
  onAgentToolComplete: (callback) => ipcRenderer.on('agent-tool-complete', (event, info) => callback(info)),
  onAgentStatus: (callback) => ipcRenderer.on('agent-status', (event, status) => callback(status)),
  onWindowInit: (callback) => ipcRenderer.on('window-init', (event, info) => callback(info)),
  onShowQrCode: (callback) => ipcRenderer.on('show-qrcode', (event, info) => callback(info)),
  onShellCommandStart: (callback) => ipcRenderer.on('shell-command-start', (event, info) => callback(info)),
  onAgentPromptStart: (callback) => ipcRenderer.on('agent-prompt-start', (event, info) => callback(info)),
  executeSlashCommand: (command) => ipcRenderer.send('execute-slash-command', command),
  sendApiKey: (key) => ipcRenderer.send('send-api-key', key),
  toggleDebugMode: () => ipcRenderer.send('toggle-debug-mode'),
  requestState: () => ipcRenderer.send('request-state'),
  readDir: (dirPath) => ipcRenderer.invoke('read-dir', dirPath),
  readFileContent: (filePath) => ipcRenderer.invoke('read-file-content', filePath),
  saveFileContent: (filePath, content) => ipcRenderer.invoke('save-file-content', filePath, content),
  openInVsCode: (filePath) => ipcRenderer.invoke('open-in-vs-code', filePath)
});

