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

// In-Memory Database (For prototype purposes. Will reset if server restarts)
const patientsDB = {}; 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ROUTE 1: Onboard Patient via Admission Paper
app.post('/api/onboard', upload.single('document'), async (req, res) => {
    try {
        const { doctorContact } = req.body;
        if (!req.file || !doctorContact) return res.status(400).json({ error: 'Missing image or doctor contact.' });

        // 1. Run AI OCR on the image
        const { data: { text } } = await Tesseract.recognize(req.file.buffer, 'eng');
        
        // 2. Extract UHID (Assuming format is 'UHID' followed by numbers)
        const uhidMatch = text.match(/UHID[\s-]?(\d+)/i);
        if (!uhidMatch) return res.status(400).json({ error: 'Could not detect a valid UHID in this photo.' });
        
        const extractedUhid = `UHID-${uhidMatch[1]}`;

        // 3. Save to our database
        patientsDB[extractedUhid] = {
            doctorContact: doctorContact,
            onboardedAt: new Date().toISOString()
        };

        res.status(200).json({ 
            success: true, 
            message: `Patient ${extractedUhid} onboarded securely.`
        });

    } catch (error) {
        res.status(500).json({ error: 'Failed to process admission paper.' });
    }
});

// ROUTE 2: Auto-Scan & Route Lab Reports
app.post('/api/scan-report', upload.single('report'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Missing report image.' });

        // 1. Run AI OCR to find the UHID
        const { data: { text } } = await Tesseract.recognize(req.file.buffer, 'eng');
        const uhidMatch = text.match(/UHID[\s-]?(\d+)/i);
        
        if (!uhidMatch) return res.status(400).json({ error: 'Could not detect UHID. Ensure the ID is clearly visible.' });
        const extractedUhid = `UHID-${uhidMatch[1]}`;

        // 2. Check if patient exists in database
        const patientProfile = patientsDB[extractedUhid];
        if (!patientProfile) {
            return res.status(404).json({ error: `UHID ${extractedUhid} recognized, but patient is not onboarded yet.` });
        }

        // 3. Upload Image to ImgBB
        const form = new FormData();
        form.append('image', req.file.buffer.toString('base64'));
        const imgbbResponse = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_KEY}`, form, { headers: form.getHeaders() });
        const imageUrl = imgbbResponse.data.data.url;

        // 4. Send WhatsApp via Twilio
        const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
        const formattedNumber = patientProfile.doctorContact.startsWith('+') ? patientProfile.doctorContact : `+91${patientProfile.doctorContact}`;

        await client.messages.create({
            from: `whatsapp:${process.env.TWILIO_NUMBER}`,
            to: `whatsapp:${formattedNumber}`,
            body: `🚨 *New Report Auto-Routed*\n\n*Patient UHID:* ${extractedUhid}\n\nReview attached report.`,
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
