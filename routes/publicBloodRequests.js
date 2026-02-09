const express = require('express');
const router = express.Router();
const bloodRequestController = require('../controllers/bloodRequestController');

// Public endpoints for donor tracker
router.get('/:id', bloodRequestController.getBloodRequestById);
router.post('/confirm', bloodRequestController.confirmDonation);

module.exports = router;
