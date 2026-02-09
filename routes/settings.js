const express = require('express');
const router = express.Router();
const Settings = require('../models/Settings');

router.get('/', async (req, res) => {
    try {
        // Find existing settings or create default
        let settings = await Settings.findOne({});
        if (!settings) {
            settings = new Settings({}); // Assuming default constructor works or schema allows empty
            await settings.save();
        }
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/', async (req, res) => {
    try {
        const settings = await Settings.findOneAndUpdate({}, req.body, { new: true, upsert: true });
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
