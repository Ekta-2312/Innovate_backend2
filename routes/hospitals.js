const express = require('express');
const router = express.Router();
const Hospital = require('../models/Hospital');

router.get('/', async (req, res) => {
    try {
        const hospitals = await Hospital.find({});
        res.json(hospitals);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add placeholder POST
router.post('/', async (req, res) => {
    try {
        const hospital = new Hospital(req.body);
        await hospital.save();
        res.status(201).json(hospital);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
