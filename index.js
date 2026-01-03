require('dotenv').config()
const express = require('express')
const bodyParser = require('body-parser')
const axios = require('axios')
const fs = require('fs');
const path = require('path');
const FormData = require('form-data'); 

const { TOKEN, SERVER_URL, ADMIN_CHAT_ID, PORT } = process.env
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`
const URI = `/webhook/${TOKEN}`
const WEBHOOK_URL = SERVER_URL + URI

const app = express();
app.use(bodyParser.json())

// Store the File ID in memory (RAM) for speed while the server is awake
let cachedFileId = null;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 1. FUNCTIONS ---

const sendDersProgram = async (chatId) => {
    // If we already have the ID in memory, use it (Fastest)
    if (cachedFileId) {
        try {
            return await axios.post(`${TELEGRAM_API}/sendPhoto`, {
                chat_id: chatId,
                photo: cachedFileId,
                caption: "<b>የደርስ ፕሮግራም</b>",
                parse_mode: 'HTML'
            });
        } catch (e) { cachedFileId = null; } // Clear cache if it fails
    }

    // Otherwise, upload from local file (Initial upload)
    const imagePath = path.resolve(__dirname, 'Images', 'ders_image.jpg');
    if (fs.existsSync(imagePath)) {
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('photo', fs.createReadStream(imagePath));
        form.append('caption', "<b>የደርስ ፕሮግራም</b>");
        form.append('parse_mode', 'HTML');

        try {
            const res = await axios.post(`${TELEGRAM_API}/sendPhoto`, form, { headers: form.getHeaders() });
            // Save the ID for the next user
            cachedFileId = res.data.result.photo[res.data.result.photo.length - 1].file_id;
        } catch (err) {
            console.error("Upload error:", err.response?.data || err.message);
        }
    } else {
        await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "የደርስ ምስሉ አልተገኘም::" });
    }
}

const sendSoftCopies = async (chatId) => {
    const files = [
        { name: 'mutemima.pdf', caption: 'متممة الآجرومية' },
        { name: 'ajerumiya.pdf', caption: 'الآجرومية' },
        { name: 'arbein.pdf', caption: 'الأربعون النووية' },
        { name: 'riyad.pdf', caption: 'رياض الصالحين' }
    ];

    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "⏳ ኪታቦቹ እየተላኩ ነው..." });

    for (const file of files) {
        const filePath = path.join(__dirname, 'Documents', file.name);
        if (fs.existsSync(filePath)) {
            const docForm = new FormData();
            docForm.append('chat_id', chatId);
            docForm.append('document', fs.createReadStream(filePath));
            docForm.append('caption', `<b>${file.caption}</b>`, { contentType: 'text/plain' });
            docForm.append('parse_mode', 'HTML');

            try {
                await axios.post(`${TELEGRAM_API}/sendDocument`, docForm, { headers: docForm.getHeaders() });
                await sleep(1000); // 1 second delay between files
            } catch (err) { console.error(`Failed: ${file.name}`); }
        }
    }
}

// --- 2. WEBHOOK HANDLER ---

app.post(URI, async (req, res) => {
    res.send(); // Acknowledge Telegram immediately

    const { message } = req.body;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text;

    if (text === '/start') {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: `እንኳን በደህና መጡ።\nከታች ያለውን <b>Menu</b> በመጫን አገልግሎቶችን ያገኛሉ።`,
            parse_mode: 'HTML'
        });
    } 
    else if (text === '/ders_program') {
        await sendDersProgram(chatId);
    } 
    else if (text === '/soft_copies') {
        await sendSoftCopies(chatId);
    } 
    else if (text.startsWith('/feedback')) {
        const feedback = text.replace('/feedback', '').trim();
        if (feedback) {
            await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: ADMIN_CHAT_ID, text: `📩 Feedback: ${feedback}` });
            await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: '✅ እናመሰግናለን!' });
        }
    }
});

const init = async () => {
    try {
        await axios.get(`${TELEGRAM_API}/setWebhook?url=${WEBHOOK_URL}`);
        await axios.post(`${TELEGRAM_API}/setMyCommands`, {
            commands: [
                { command: 'ders_program', description: 'የደርስ ፕሮግራሞች' },
                { command: 'soft_copies', description: 'የኪታቦቹን ሶፍት ኮፒ' },
                { command: 'feedback', description: 'አስተያየት ለመስጠት' }
            ]
        });
        console.log("Bot is Online!");
    } catch (e) { console.log("Init failed - Check your TOKEN or Internet Connection"); }
}

app.listen(PORT, async () => {
    await init();
});