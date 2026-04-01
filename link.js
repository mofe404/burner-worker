const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

async function start() {
    const adminNumber = "2348035235080";
    const { state, saveCreds } = await useMultiFileAuthState(`./worker/sessions/auth_${adminNumber}`);

    try {
        const { version } = await fetchLatestBaileysVersion();
        console.log(`🚀 Starting Engine (WA Version: ${version.join('.')})`);

        const sock = makeWASocket({
            version,
            auth: state,
            // MANUAL ARRAY: This bypasses the Browsers.safari error entirely
            browser: ['Mac OS', 'Chrome', '121.0.6167.160'],
            printQRInTerminal: false,
            logger: pino({ level: 'error' }),
            connectTimeoutMs: 60000,
            // Keep the connection "warm" so the MTN router doesn't kill it
            keepAliveIntervalMs: 15000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, qr, lastDisconnect } = update;

            if (qr) {
                console.clear();
                console.log("\n[!] SCAN THIS WITH WHATSAPP:");
                qrcode.generate(qr, { small: true });
                console.log("\n[!] Awaiting scan... Keep this terminal open.");
            }

            if (connection === 'open') {
                console.log('\n✅ SUCCESS! Device is permanently linked.');
                console.log('[!] You can now press Ctrl+C.\n');
                process.exit(0);
            }

            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = code !== DisconnectReason.loggedOut;
                console.log(`[!] Disconnected. Code: ${code}. Reconnecting: ${shouldReconnect}`);
                if (shouldReconnect) start();
            }
        });

    } catch (err) {
        console.log("Could not fetch version. Retrying...");
        setTimeout(start, 5000);
    }
}

start();