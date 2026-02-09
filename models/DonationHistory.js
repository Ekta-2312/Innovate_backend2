const mongoose = require('mongoose');

const donationHistorySchema = new mongoose.Schema({
  donorId: {
    type: String,
    required: true,
    ref: 'Donor'
  },
  bloodRequestId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'BloodRequest'
  },
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Hospital'
  },
  donorName: {
    type: String,
    required: true
  },
  donorPhone: {
    type: String,
    required: true
  },
  donorBloodGroup: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['accepted', 'declined', 'pending', 'completed'],
    default: 'pending'
  },
  acceptedAt: {
    type: Date
  },
  completedAt: {
    type: Date
  },
  location: {
    lat: {
      type: Number,
      required: true
    },
    lng: {
      type: Number,
      required: true
    }
  },
  address: {
    type: String
  },
  notes: {
    type: String
  }
}, {
  timestamps: true
});

// Add compound index to prevent duplicate donations
// This will prevent the same donor from being marked as completed multiple times within a short period
donationHistorySchema.index(
  { 
    donorId: 1, 
    status: 1, 
    completedAt: 1 
  }, 
  { 
    unique: true,
    partialFilterExpression: { 
      status: 'completed',
      completedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Only within last 24 hours
    }
  }
);

// Also add an index on donorName + status for additional protection
donationHistorySchema.index(
  { 
    donorName: 1, 
    status: 1, 
    completedAt: 1 
  }
);

const DonationHistory = mongoose.model('DonationHistory', donationHistorySchema);

module.exports = DonationHistory;
