const express = require('express');
const router = express.Router();

router.post('/mark-donation', (req, res) => {
    res.json({ message: 'Donation marked successfully (mock)' });
});

module.exports = router;
