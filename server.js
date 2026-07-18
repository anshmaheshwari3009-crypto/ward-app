const express = require('express');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const twilio = require('twilio');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

const patientsDB = {}; 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ROUTE 1: Onboard Patient
app.post('/api/onboard', upload.single('document'), async (req, res) => {
    try {
        const { doctorContact } = req.body;
        if (!req.file || !doctorContact) return res.status(400).json({ error: 'Missing image or doctor contact.' });

        const { data: { text } } = await Tesseract.recognize(req.file.buffer, 'eng');
        
        // NEW AI RULE: Looks for a standalone number between 6 and 12 digits long
        const uhidMatch = text.match(/\b(\d{6,12})\b/);
        
        if (!uhidMatch) {
            const aiSaw = text.replace(/\n/g, ' ').substring(0, 100);
            return res.status(400).json({ error: `Could not find a 6-12 digit ID. AI read: "${aiSaw}"` });
        }
        
        const extractedUhid = uhidMatch[1];

        patientsDB[extractedUhid] = {
            doctorContact: doctorContact,
            onboardedAt: new Date().toISOString()
        };

        res.status(200).json({ 
            success: true, 
            message: `Patient ID ${extractedUhid} onboarded securely.`
        });

    } catch (error) {
        res.status(500).json({ error: 'Failed to process admission paper.' });
    }
});

// ROUTE 2: Auto-Scan & Route
app.post('/api/scan-report', upload.single('report'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Missing report image.' });

        const { data: { text } } = await Tesseract.recognize(req.file.buffer, 'eng');
        
        // NEW AI RULE: Looks for a standalone number between 6 and 12 digits long
        const uhidMatch = text.match(/\b(\d{6,12})\b/);
        
        if (!uhidMatch) return res.status(400).json({ error: 'Could not detect the numeric ID.' });
        
        const extractedUhid = uhidMatch[1];

        const patientProfile = patientsDB[extractedUhid];
        if (!patientProfile) {
            return res.status(404).json({ error: `ID ${extractedUhid} found, but patient is not onboarded.` });
        }

        const form = new FormData();
        form.append('image', req.file.buffer.toString('base64'));
        const imgbbResponse = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_KEY}`, form, { headers: form.getHeaders() });
        const imageUrl = imgbbResponse.data.data.url;

        const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
        const formattedNumber = patientProfile.doctorContact.startsWith('+') ? patientProfile.doctorContact : `+91${patientProfile.doctorContact}`;

        await client.messages.create({
            from: `whatsapp:${process.env.TWILIO_NUMBER}`,
            to: `whatsapp:${formattedNumber}`,
            body: `🚨 *New Report Auto-Routed*\n\n*Patient ID:* ${extractedUhid}\n\nReview attached report.`,
            mediaUrl: [imageUrl]
        });

        res.status(200).json({ 
            success: true, 
            message: `Report auto-filed for ${extractedUhid} and senior notified.` 
        });

    } catch (error) {
        res.status(500).json({ error: 'Failed to process report.' });
    }
});

app.listen(port, () => console.log(`Smart Router Live on port ${port}`));
