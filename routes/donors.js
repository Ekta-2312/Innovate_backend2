const express = require('express');
const router = express.Router();
const Donor = require('../models/Donor');
const bcrypt = require('bcryptjs');

router.get('/', async (req, res) => {
    try {
        const donors = await Donor.find({}, { password: 0 });
        res.json(donors);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', async (req, res) => {
    try {
        const donorData = { ...req.body };
        if (donorData.password) {
            donorData.password = await bcrypt.hash(donorData.password, 10);
        }
        const donor = new Donor(donorData);
        await donor.save();
        res.status(201).json(donor);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
