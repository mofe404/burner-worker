const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { PrismaClient } = require('@prisma/client');

// Load environment variables (fallback to root if available for local dev)
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '../.env') }); // Legacy generic fallback

const prisma = new PrismaClient();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const activeSessions = new Map();

// Dynamic Folder Creation: Ensure sessions directory exists before any initialization
const sessionsDir = path.join(__dirname, 'sessions/auth_info_baileys');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// Export the activeSessions Map first so the BullMQ queue can safely require this file and inherit state
module.exports = { sessions: activeSessions };
require('./queue');

/**
 * Core Socket Initialization Logic for Multi-Tenant Support
 */
async function initBaileysSocket(sessionId, phoneNumber = null) {
    const authDir = `./sessions/auth_info_baileys/session_${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 30000,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[Burner] [!] Connection closed for ${sessionId}. Code: ${reason}`);
            if (reason !== 401) {
                setTimeout(() => initBaileysSocket(sessionId, phoneNumber), 5000);
            } else {
                activeSessions.delete(sessionId);
                console.log(`[Burner] ❌ Session ${sessionId} logged out. Cleaning up...`);
                try {
                    fs.rmSync(authDir, { recursive: true, force: true });
                } catch (err) {
                    console.error(`[Burner] Failed to delete session dir for ${sessionId}:`, err.message);
                }
            }
        } else if (connection === 'open') {
            console.log(`[Burner] ✅ WhatsApp Connected for Session: ${sessionId}`);
            activeSessions.set(sessionId, sock);
            
            // Trigger automatic group sync on connection
            syncGroups(sock, sessionId);
        }
    });

    // Listen for incoming messages to calculate recency/lastInteraction
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.remoteJid && msg.key.remoteJid.endsWith('@g.us')) {
                const jid = msg.key.remoteJid;
                const timestamp = new Date((msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000);
                
                // Track interaction for this specific session/admin
                const groupSlug = `${sessionId}-${jid}`;
                await prisma.group.updateMany({
                    where: { slug: groupSlug },
                    data: { lastInteraction: timestamp }
                });
            }
        }
    });

    // Request Pairing Code if a phone number is provided and not registered
    if (phoneNumber && !sock.authState.creds.registered) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        const code = await sock.requestPairingCode(phoneNumber);
        return { sock, code };
    }

    return { sock, code: null };
}

async function syncGroups(sock, sessionId) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        console.log(`🔄 Syncing ${Object.keys(groups).length} groups for ${sessionId}...`);
        
        // Ensure the admin entry exists (using sessionId as the identifier)
        // Note: For multi-tenant, ensure the sessionId corresponds to the Admin DB ID or Phone
        const adminEntry = await prisma.admin.upsert({
            where: { phoneNumber: sessionId }, // Assuming sessionId is the phone for now, or match your DB logic
            update: {},
            create: { phoneNumber: sessionId }
        });

        for (const jid in groups) {
            const groupMetadata = groups[jid];
            const subject = groupMetadata.subject || "Unknown Group";
            const groupSlug = `${adminEntry.id}-${jid}`;
            
            let imageUrl = null;
            try {
                // Get the profile picture of the host's WhatsApp number as requested
                const hostJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                imageUrl = await sock.profilePictureUrl(hostJid, 'image');
            } catch (e) {
                // Fallback to group picture if host picture is unavailable
                try {
                    imageUrl = await sock.profilePictureUrl(jid, 'image');
                } catch (e2) {}
            }

            await prisma.group.upsert({
                where: { slug: groupSlug },
                update: { name: subject, imageUrl, whatsappGroupJid: jid, sessionId: sessionId },
                create: {
                    slug: groupSlug,
                    whatsappGroupJid: jid,
                    name: subject,
                    imageUrl,
                    sessionId: sessionId,
                    adminId: adminEntry.id,
                    lastInteraction: new Date(groupMetadata.creation * 1000)
                }
            });
        }
        console.log(`✅ Sync complete for ${sessionId}`);
    } catch (err) {
        console.error(`Failed to sync groups for ${sessionId}:`, err);
    }
}

/**
 * Multi-Tenant Onboarding Endpoint
 */
app.post('/api/sessions/link', async (req, res) => {
    try {
        const { phoneNumber, sessionId } = req.body;

        if (!phoneNumber || !sessionId) {
            return res.status(400).json({ success: false, error: 'phoneNumber and sessionId are required' });
        }

        // Phone Number Formatting: Drop any +, spaces, or dashes
        const cleanPhoneNumber = phoneNumber.replace(/\D/g, '');
        
        console.log(`🔗 Requesting pairing code for ${cleanPhoneNumber} (Session: ${sessionId})...`);
        
        const { code } = await initBaileysSocket(sessionId, cleanPhoneNumber);
        
        if (code) {
            // Format code as ABCD-1234
            const formattedCode = code.match(/.{1,4}/g).join('-');
            return res.json({ success: true, code: formattedCode });
        } else {
            return res.json({ success: true, message: 'Already registered or connecting...' });
        }
    } catch (error) {
        console.error('Pairing Request Failed:', error);
        // Prevent process crash by returning a clean JSON error
        return res.status(500).json({ 
            success: false, 
            error: error.message || 'WhatsApp rejected the request. Please check the phone number.' 
        });
    }
});

// Boot-up Sequence: Resume all stored sessions
async function resumeSessions() {
    const sessionsDir = path.join(__dirname, 'sessions/auth_info_baileys');
    if (fs.existsSync(sessionsDir)) {
        const dirs = fs.readdirSync(sessionsDir);
        console.log(`[Burner] 🚀 Resuming stored sessions...`);
        for (const dir of dirs) {
            if (dir.startsWith('session_')) {
                const sessionId = dir.replace('session_', '');
                const credsFile = path.join(sessionsDir, dir, 'creds.json');
                
                // Only resume if the session has valid credentials
                if (fs.existsSync(credsFile)) {
                    if (sessionId !== process.env.ADMIN_NUMBER) {
                        initBaileysSocket(sessionId, null).catch(err => {
                            console.error(`[Burner] Failed to resume session ${sessionId}:`, err.message);
                        });
                    }
                } else {
                    console.warn(`[Burner] Skipping empty session directory: ${dir}`);
                }
            }
        }
    }

    // Boot primary admin if not already resumed
    if (process.env.ADMIN_NUMBER) {
        const adminAuthDir = path.join(sessionsDir, `session_${process.env.ADMIN_NUMBER}`);
        const adminCredsFile = path.join(adminAuthDir, 'creds.json');

        if (fs.existsSync(adminCredsFile)) {
            initBaileysSocket(process.env.ADMIN_NUMBER, null).catch(err => {
                console.error(`[Burner] Failed to boot primary admin session:`, err.message);
            });
        }
    }
}

resumeSessions();

app.listen(PORT, () => {
    console.log(`[Burner] Multi-Tenant Worker securely bound and running on port ${PORT}`);
});