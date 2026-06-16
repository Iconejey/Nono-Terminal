const { app, BrowserWindow, Menu } = require('electron');

function createWindow() {
	// Remove the default menu globally
	Menu.setApplicationMenu(null);

	const win = new BrowserWindow({
		width: 800,
		height: 600,
		frame: false,
		transparent: true,
		backgroundColor: '#00000000'
	});

	// Remove the menu from the window instance
	win.removeMenu();

	// Register keyboard shortcuts
	win.webContents.on('before-input-event', (event, input) => {
		// Ctrl+R or Cmd+R to reload
		if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
			win.reload();
			event.preventDefault();
		}
		// Ctrl+Shift+I or Cmd+Option+I to toggle DevTools
		if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i') {
			win.webContents.toggleDevTools();
			event.preventDefault();
		}
	});

	win.loadFile('window/index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});
