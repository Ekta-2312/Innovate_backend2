const express = require('express');
const router = express.Router();

router.post('/', (req, res) => res.json({ message: 'Donor response endpoint' }));

module.exports = router;
