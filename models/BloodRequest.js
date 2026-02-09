const mongoose = require('mongoose');

const bloodRequestSchema = new mongoose.Schema({
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hospital',
    required: true
  },
  bloodGroup: {
    type: String,
    required: true,
    enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
  },
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  urgency: {
    type: String,
    required: true,
    enum: ['low', 'medium', 'high', 'pregnancy']
  },
  requiredBy: {
    type: Date,
    required: true
  },
  description: String,
  patientAge: String,
  patientCondition: String,
  status: {
    type: String,
    enum: ['pending', 'fulfilled', 'cancelled'],
    default: 'pending'
  },
  confirmedUnits: {
    type: Number,
    default: 0
  },
  batchSize: {
    type: Number,
    default: 3
  },
  notifiedDonors: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "Donor"
  }],
  remainingDonorsQueue: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "Donor"
  }],
  batchSentAt: {
    type: Date
  },
  responseWindow: {
    type: Number,
    default: 5 // minutes
  },
  batchInProgress: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const BloodRequest = mongoose.model('BloodRequest', bloodRequestSchema);

module.exports = BloodRequest;
