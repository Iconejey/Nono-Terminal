const express = require('express');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PWA_SERVER_PORT || 3000;

function getLocalIpAddress() {
	const interfaces = os.networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		for (const iface of interfaces[name]) {
			if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) {
				return iface.address;
			}
		}
	}
	return '127.0.0.1';
}

// Serve static files from the 'window' directory
app.use(express.static(path.join(__dirname, '../window')));

// Allow routing fallbacks (useful for PWA routing)
app.use((req, res, next) => {
	if (req.method === 'GET' && req.accepts('html')) res.sendFile(path.join(__dirname, '../window/index.html'));
	else next();
});

app.listen(PORT, () => {
	const ip = getLocalIpAddress();
	console.log('====================================================');
	console.log(` Nono-Terminal VPS PWA server running on port ${PORT}`);
	console.log(` Local network link: http://${ip}:${PORT}`);
	console.log(` Localhost link:     http://localhost:${PORT}`);
	console.log('====================================================');
});
