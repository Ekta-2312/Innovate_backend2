const express = require('express');
const router = express.Router();
const bloodRequestController = require('../controllers/bloodRequestController'); // I know this controller exists

router.post('/', bloodRequestController.createBloodRequest);
router.get('/', bloodRequestController.getAllBloodRequests);
router.get('/:id', bloodRequestController.getBloodRequestById);

// Add other routes if needed, for now these are verified
module.exports = router;
