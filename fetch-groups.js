const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

async function fetchGroups() {
    const adminNumber = "2348035235080";
    
    // Uses the same auth logic/directory initialized in server.js and link.js
    const authDir = `./sessions/auth_${adminNumber}`;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    try {
        const { version } = await fetchLatestBaileysVersion();

        console.log(`📡 Connecting to WhatsApp (Engine v${version.join('.')})...`);

        const sock = makeWASocket({
            version,
            auth: state,
            browser: ['Ubuntu', 'Chrome', '20.0.04'], // Matching server.js auth logic
            printQRInTerminal: false,
            logger: pino({ level: 'silent' })
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'close') {
                console.log('\n❌ Connection closed. Make sure the server daemon isn\'t conflicting, or try stopping node server.js first.');
                process.exit(1);
            }

            if (connection === 'open') {
                console.log('\n✅ Socket open! Fetching participating groups...\n');
                
                try {
                    // Call the Baileys metadata fetch function
                    const groups = await sock.groupFetchAllParticipating();
                    
                    // Parse into a clean array for console.table
                    const tableData = Object.values(groups).map(group => ({
                        'Group Name': group.subject || 'Unnamed Group',
                        'JID': group.id
                    }));

                    console.log('--- JOINED WHATSAPP GROUPS ---');
                    if (tableData.length > 0) {
                        console.table(tableData);
                    } else {
                        console.log('No groups found for this number.');
                    }
                    console.log('------------------------------\n');

                } catch (err) {
                    console.error('Failed to fetch groups:', err.message);
                } finally {
                    // Exit the script once the list is successfully printed
                    process.exit(0);
                }
            }
        });

    } catch (err) {
        console.error("Critical Engine Error:", err);
        process.exit(1);
    }
}

fetchGroups();
