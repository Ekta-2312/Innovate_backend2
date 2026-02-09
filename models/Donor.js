const mongoose = require('mongoose');

const donorSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  rollNo: {
    type: String,
    trim: true
  },
  uniqueId: {
    type: String,
    unique: true,
    sparse: true, // Allows null values while maintaining uniqueness
    trim: true,
    uppercase: true
  },
  bloodGroup: {
    type: String,
    required: true,
    enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'NK'],
    uppercase: true,
    trim: true
  },
  phone: {
    type: String,
    required: true,
    trim: true
  },
  role: {
    type: String,
    default: 'donor',
    enum: ['donor']
  },
  lastDonationDate: {
    type: Date
  },
  password: {
    type: String,
    required: true
  }
}, {
  timestamps: true // Adds createdAt and updatedAt fields automatically
});

const Donor = mongoose.model('Donor', donorSchema);

module.exports = Donor;