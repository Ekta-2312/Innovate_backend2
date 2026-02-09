const mongoose = require('mongoose');

const donorResponseSchema = new mongoose.Schema({
  donorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Donor',
    required: true
  },
  requestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BloodRequest',
    required: true
  },
  latitude: {
    type: Number,
    required: true
  },
  longitude: {
    type: Number,
    required: true
  },
  isAvailable: {
    type: Boolean,
    default: true
  },
  address: {
    type: String
  },
  responseTime: {
    type: Date,
    default: Date.now
  },
  token: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('DonorResponse', donorResponseSchema);
