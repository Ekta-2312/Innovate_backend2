const express = require('express');
const router = express.Router();
const DonationHistory = require('../models/DonationHistory');

router.get('/', async (req, res) => {
    try {
        const history = await DonationHistory.find({});
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
