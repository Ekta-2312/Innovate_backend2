const express = require('express');
const router = express.Router();

router.get('/:token', (req, res) => {
    res.json({ valid: true, token: req.params.token });
});

module.exports = router;
