const express = require('express');
const router = express.Router();
const Settings = require('../models/Settings');

router.get('/', async (req, res) => {
    try {
        let settings = await Settings.findOne({});
        if (!settings) {
            settings = new Settings({});
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
