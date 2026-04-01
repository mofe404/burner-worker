const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { PrismaClient } = require('@prisma/client');
const { sessions } = require('./server'); 

// Using the PrismaClient installed locally for the worker
const prisma = new PrismaClient();

// Connect to Redis strictly using environment variable
console.log("DEBUG: REDIS_URL is", process.env.REDIS_URL ? "DEFINED" : "UNDEFINED");

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is missing from environment variables!");
}
const connection = new Redis(redisUrl, {
  tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
  maxRetriesPerRequest: null
});

connection.on('error', (err) => {
    console.error('Redis Connection Error:', err.message);
});

/**
 * BullMQ Worker for outbound WhatsApp messages.
 * We restrict concurrency to 1 to ensure sequenced execution.
 */
const worker = new Worker('whatsapp-outbound', async job => {
    const { messageId, jid, content, senderNumber, mediaUrl, mediaType } = job.data;
    
    // ANTI-BAN LOGIC: Random delay between 5000ms and 10000ms
    const delay = Math.floor(Math.random() * 5000) + 5000;
    console.log(`[Job ${job.id}] Waiting ${delay}ms before sending to ${jid}...`);
    await new Promise(resolve => setTimeout(resolve, delay));

    // Uses the sessions Map from server.js to find the right socket
    const sock = sessions.get(senderNumber);
    if (!sock) {
        throw new Error(`Socket not found for WhatsApp number: ${senderNumber}. Authenticate first.`);
    }

    // Send the message via Baileys sock
    if (mediaUrl) {
        console.log(`[Job ${job.id}] Fetching media payload from: ${mediaUrl}`);
        const mediaRes = await fetch(mediaUrl);
        const arrayBuffer = await mediaRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        if (mediaType === 'image') {
            await sock.sendMessage(jid, { image: buffer, caption: content || '' });
        } else if (mediaType === 'audio') {
            await sock.sendMessage(jid, { audio: buffer, ptt: true });
        }
    } else {
        await sock.sendMessage(jid, { text: content });
    }

    // Use Prisma to update that specific message's status to SENT
    await prisma.message.update({
        where: { id: messageId },
        data: { status: 'SENT' },
    });
    
    console.log(`[Job ${job.id}] Successfully sent message and updated DB.`);
    console.log("Anti-Ban Throttle active: Waiting 30s before processing next payload...");
    await new Promise(resolve => setTimeout(resolve, 30000));
}, { 
    connection,
    concurrency: 1 
});

// Optional: catch failures to update database with FAILED status
worker.on('failed', async (job, err) => {
    console.error(`[Job ${job?.id}] Failed: ${err.message}`);
    if (job && job.data && job.data.messageId) {
        try {
            await prisma.message.update({
                where: { id: job.data.messageId },
                data: { status: 'FAILED' }
            });
        } catch (dbErr) {
            console.error('Failed to update DB on job failure:', dbErr.message);
        }
    }
});

console.log('BullMQ Anti-Ban Worker initialized for whatsapp-outbound queue.');

module.exports = { worker };
