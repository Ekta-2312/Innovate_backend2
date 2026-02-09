const express = require('express');
const router = express.Router();

// This might be for validating tokens from SMS link?
router.get('/:token', (req, res) => {
    res.json({ valid: true, token: req.params.token });
});

module.exports = router;
