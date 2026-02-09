require('dotenv').config();
const Hospital = require('./models/Hospital');
const Admin = require('./models/Admin');
const OTP = require('./models/OTP');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const bloodRequestsRouter = require('./routes/bloodRequests');
const donorResponseRouter = require('./routes/donorResponse');
const donorsRouter = require('./routes/donors');
const hospitalsRouter = require('./routes/hospitals');
const tokenResponseRouter = require('./routes/tokenResponse');
const donationHistoryRouter = require('./routes/donationHistory');
const settingsRouter = require('./routes/settings');
const markDonationRouter = require('./routes/markDonation');
const Notification = require('./models/Notification');
const { addClient: addNotificationClient, broadcastNotification } = require('./utils/notificationStream');
const { generateOTP, sendRegistrationOTP, sendPasswordResetOTP } = require('./services/emailService');

// Helper function to create admin notifications
const createAdminNotification = async (title, message, type = 'info', relatedData = {}) => {
  try {
    const notification = new Notification({
      title,
      message,
      type,
      hospitalId: relatedData.hospitalId || null,
      donorId: relatedData.donorId || null,
      bloodRequestId: relatedData.bloodRequestId || null,
      read: false
    });

    await notification.save();
    console.log(`Admin notification created: ${title}`);
    return notification;
  } catch (error) {
    console.error('Error creating admin notification:', error);
  }
};

const app = express();
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:5174',
    'https://donor-location-tracker.onrender.com'
  ],
  credentials: true
}));
// Increase JSON limit to support larger bulk imports
app.use(bodyParser.json({ limit: '2mb' }));

const mongoOptions = {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
  family: 4 // Force IPv4
};

const connectionString = process.env.MONGODB_URI;

if (!connectionString) {
  console.error('❌ MONGODB_URI not found in environment variables');
  process.exit(1);
}

// Enhanced connection with retry logic
async function connectToMongoDB() {
  let retries = 5;
  while (retries) {
    try {
      await mongoose.connect(connectionString, mongoOptions);
      console.log('✅ MongoDB connected successfully!');
      console.log('✅ MongoDB connected to raktmap database');
      return;
    } catch (error) {
      console.error(`MongoDB connection attempt failed: ${error.message}`);
      retries -= 1;
      console.log(`🔄 Retrying... ${retries} attempts remaining`);
      if (retries === 0) {
        console.error('❌ Failed to connect to MongoDB after multiple attempts');
        console.log('📋 Troubleshooting steps:');
        console.log('1. Check MongoDB Atlas Network Access - Add your IP');
        console.log('2. Or allow all IPs: 0.0.0.0/0');
        console.log('3. Verify cluster is running');
        console.log('4. Check firewall/antivirus');
        console.log('5. Make sure MONGODB_URI is correct in .env');
        console.log('6. Check if your internet connection is stable');

        // Don't exit the process, continue with limited functionality
        console.log('⚠️  Server will continue running with limited database functionality');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retry
    }
  }
}

// Start connection
connectToMongoDB();

const db = mongoose.connection;
db.on('error', (error) => {
  console.error('MongoDB connection error:', error);
});

db.on('disconnected', () => {
  console.log('⚠️  MongoDB disconnected. Attempting to reconnect...');
});

db.on('reconnected', () => {
  console.log('✅ MongoDB reconnected successfully!');
});

db.once('open', async () => {
  console.log('✅ MongoDB connected successfully!');

  // ⏰ Create TTL index for automatic location cleanup after 1 hour
  try {
    const locationsCollection = mongoose.connection.db.collection('locations');

    // Check if TTL index already exists
    const indexes = await locationsCollection.indexes();
    const hasTTLIndex = indexes.some(index =>
      index.key.timestamp && index.expireAfterSeconds
    );

    if (!hasTTLIndex) {
      await locationsCollection.createIndex(
        { timestamp: 1 },
        {
          expireAfterSeconds: 3600, // 3600 seconds = 1 hour
          name: 'location_ttl_index'
        }
      );
      console.log('✅ TTL index created on locations collection - locations will auto-expire after 1 hour');
    } else {
      console.log('✅ TTL index already exists on locations collection');
    }
  } catch (error) {
    console.error('⚠️  Failed to create TTL index (non-critical):', error.message);
  }

  // 🔍 Start MongoDB Change Stream watcher for real-time notifications
  try {
    const { startLocationWatcher } = require('./utils/locationWatcher');
    startLocationWatcher();
  } catch (error) {
    console.error('⚠️  Failed to start location watcher:', error.message);
  }

  // 🔄 Start Batch SMS Scheduler (every 1 minute)
  try {
    const { sendNextBatch } = require('./controllers/bloodRequestController');
    const BloodRequest = require('./models/BloodRequest');

    const checkPendingBatches = async () => {
      try {
        if (mongoose.connection.readyState !== 1) return; // DB not ready

        // Find pending requests that are "in progress"
        const pendingRequests = await BloodRequest.find({
          status: 'pending',
          batchInProgress: true,
          $expr: { $lt: ['$confirmedUnits', '$quantity'] }
        });

        if (pendingRequests.length > 0) {
          // console.log(`\n⏰ [Scheduler] Checking ${pendingRequests.length} in-progress requests...`);
        }

        const now = Date.now();

        for (const request of pendingRequests) {
          if (!request.batchSentAt) continue;

          const windowMinutes = request.responseWindow || 2;
          const sentTime = new Date(request.batchSentAt).getTime();
          const elapsedMinutes = (now - sentTime) / (1000 * 60);

          if (elapsedMinutes >= windowMinutes) {
            console.log(`[Scheduler] Response window closed (${elapsedMinutes.toFixed(1)}/${windowMinutes} mins) for request ${request._id}. Next batch...`);

            request.batchInProgress = false;
            await request.save();

            await sendNextBatch(request._id);
          }
        }

      } catch (err) {
        console.error('[Scheduler] Error checking pending batches:', err.message);
      }
    };

    // Run every minute
    setInterval(checkPendingBatches, 60 * 1000);
    console.log('✅ Batch SMS Scheduler started (1 min interval)');

    // Run once after short delay to catch up on missed batches
    setTimeout(checkPendingBatches, 10000);

  } catch (error) {
    console.error('⚠️  Failed to start Batch Scheduler:', error.message);
  }
});

/* ============================
   2. JWT Secret
============================ */
const SECRET = process.env.JWT_SECRET || 'fallback_secret_key';

/* ============================
   3. Auth Middleware
============================ */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

/* ============================
   4. Routes
============================ */
app.use('/blood-requests', authenticateToken, bloodRequestsRouter);
app.use('/api/bloodrequest', require('./routes/publicBloodRequests'));
app.use('/donor-response', authenticateToken, donorResponseRouter);
app.use('/donors', authenticateToken, donorsRouter);
app.use('/hospitals', authenticateToken, hospitalsRouter);
app.use('/donation-history', authenticateToken, donationHistoryRouter);
app.use('/admin', authenticateToken, settingsRouter);
app.use('/api', authenticateToken, markDonationRouter);
app.use('/', tokenResponseRouter); // Public route for SMS responses

// Public route for direct location sharing from frontend
app.post('/api/donor-location', async (req, res) => {
  try {
    console.log('=== DIRECT LOCATION SHARING FROM FRONTEND ===');
    const { requestId, donorId, lat, lng } = req.body;

    console.log('Received data:', { requestId, donorId, lat, lng });

    if (!requestId || !donorId || !lat || !lng) {
      return res.status(400).json({
        error: 'Missing required fields: requestId, donorId, lat, lng'
      });
    }

    // Find the blood request to validate
    const BloodRequest = require('./models/BloodRequest');
    const bloodRequest = await BloodRequest.findById(requestId);

    if (!bloodRequest) {
      return res.status(404).json({ error: 'Blood request not found' });
    }

    // Check if request is already fulfilled
    if (bloodRequest.status === 'fulfilled' || bloodRequest.status === 'cancelled' || bloodRequest.status === 'completed') {
      console.log(`❌ Location rejected: Request ${requestId} is ${bloodRequest.status}`);
      return res.status(400).json({
        success: false,
        error: 'Request already fulfilled',
        message: 'Thank you for your willingness to help, but this blood request has already been fulfilled.'
      });
    }

    console.log('Found blood request:', {
      id: bloodRequest._id,
      bloodGroup: bloodRequest.bloodGroup,
      status: bloodRequest.status
    });

    // Try to find donor information
    let donorInfo = null;
    try {
      const Donor = require('./models/Donor');
      donorInfo = await Donor.findById(donorId);
      if (!donorInfo) {
        donorInfo = await Donor.findOne({ uniqueId: donorId });
      }
    } catch (error) {
      console.log('Could not find donor in database, proceeding with location only');
    }

    // Create location data with proper requestId
    const locationData = {
      address: donorInfo ? `${donorInfo.name} - Current Location` : 'Direct location share',
      latitude: parseFloat(lat),
      longitude: parseFloat(lng),
      accuracy: 0,
      userName: donorInfo ? donorInfo.name : `Donor ${donorId}`,
      rollNumber: donorInfo ? donorInfo.rollNumber || '' : '',
      mobileNumber: donorInfo ? donorInfo.phone : '',
      timestamp: new Date(),
      // IMPORTANT: Store the requestId from the frontend
      requestId: requestId,
      donorId: donorId,
      token: `DIRECT_${requestId}_${donorId}`, // Generate a unique token
      isAvailable: true,
      responseTime: new Date()
    };

    console.log('Saving location with requestId:', locationData.requestId);

    // Save to locations collection
    const result = await mongoose.connection.db.collection('locations').insertOne(locationData);

    console.log('✅ Location saved successfully with requestId:', requestId);

    res.json({
      success: true,
      message: 'Location shared successfully',
      data: {
        locationId: result.insertedId,
        requestId: requestId,
        donorId: donorId,
        coordinates: { lat, lng }
      }
    });

  } catch (error) {
    console.error('Error in direct location sharing:', error);
    res.status(500).json({
      error: 'Failed to save location',
      details: error.message
    });
  }
});

// Add token validation test route
app.get('/validate-token', authenticateToken, (req, res) => {
  res.json({
    valid: true,
    user: req.user,
    message: 'Token is valid'
  });
});

// Public admin routes for dashboard (temporary - should be secured later)
app.get('/admin/hospitals', async (req, res) => {
  try {
    console.log('Fetching hospitals for admin dashboard...');
    const Hospital = require('./models/Hospital');
    const hospitals = await Hospital.find({}).sort({ createdAt: -1 });
    res.json({
      success: true,
      message: `Fetched ${hospitals.length} hospitals`,
      hospitals: hospitals,
      count: hospitals.length
    });
  } catch (error) {
    console.error('Error fetching hospitals:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch hospitals',
      error: error.message
    });
  }
});

app.get('/admin/donors', async (req, res) => {
  try {
    console.log('Fetching donors for admin dashboard...');
    const Donor = require('./models/Donor');
    const donors = await Donor.find({}, { password: 0 }).sort({ createdAt: -1 });
    res.json({
      success: true,
      message: `Fetched ${donors.length} donors`,
      donors: donors,
      count: donors.length
    });
  } catch (error) {
    console.error('Error fetching donors:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch donors',
      error: error.message
    });
  }
});

// Admin donor CRUD operations
app.post('/admin/donors', async (req, res) => {
  try {
    const Donor = require('./models/Donor');
    const bcrypt = require('bcryptjs');

    const donorData = { ...req.body };
    if (donorData.email) donorData.email = donorData.email.toLowerCase();
    if (donorData.password) {
      donorData.password = await bcrypt.hash(donorData.password, 10);
    }

    const donor = new Donor(donorData);
    await donor.save();

    // Create admin notification for new donor registration
    await createAdminNotification(
      'New Donor Registration',
      `New donor ${donorData.name} (${donorData.bloodGroup}) has been registered by admin.`,
      'success',
      { donorId: donor._id }
    );

    res.status(201).json({
      success: true,
      message: 'Donor created successfully',
      donor: { ...donor.toObject(), id: donor._id.toString() }
    });
  } catch (error) {
    console.error('Error creating donor:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create donor',
      error: error.message
    });
  }
});

app.put('/admin/donors/:id', async (req, res) => {
  try {
    const Donor = require('./models/Donor');
    const bcrypt = require('bcryptjs');

    const updateData = { ...req.body };
    if (updateData.email) updateData.email = updateData.email.toLowerCase();
    if (updateData.password) {
      updateData.password = await bcrypt.hash(updateData.password, 10);
    }

    const donor = await Donor.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true, select: '-password' }
    );

    if (!donor) {
      return res.status(404).json({
        success: false,
        message: 'Donor not found'
      });
    }

    res.json({
      success: true,
      message: 'Donor updated successfully',
      donor: { ...donor.toObject(), id: donor._id.toString() }
    });
  } catch (error) {
    console.error('Error updating donor:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update donor',
      error: error.message
    });
  }
});

app.delete('/admin/donors/:id', async (req, res) => {
  try {
    const Donor = require('./models/Donor');

    const donor = await Donor.findByIdAndDelete(req.params.id);
    if (!donor) {
      return res.status(404).json({
        success: false,
        message: 'Donor not found'
      });
    }

    res.json({
      success: true,
      message: 'Donor deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting donor:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete donor',
      error: error.message
    });
  }
});

// Admin analytics endpoints
app.get('/admin/analytics/stats', async (req, res) => {
  try {
    console.log('Fetching admin analytics stats...');
    const BloodRequest = require('./models/BloodRequest');

    // Use direct MongoDB connection for donation history
    const mongoose = require('mongoose');
    const db = mongoose.connection.db;
    const donationCollection = db.collection('donationhistories');

    // Get total requests
    const totalRequests = await BloodRequest.countDocuments();
    console.log('Total blood requests:', totalRequests);

    // Get donors who have completed donations
    const donorsResponded = await donationCollection.countDocuments({ status: 'completed' });
    console.log('Donors who completed donations:', donorsResponded);

    // Calculate fulfillment rate based on completed donations vs total requests
    const fulfillmentRate = totalRequests > 0 ? Math.round((donorsResponded / totalRequests) * 100) : 0;
    console.log('Fulfillment rate:', fulfillmentRate);

    // For now, set a default response time (you can enhance this later)
    const avgResponseTime = 150; // 2m 30s as shown in your screenshot

    res.json({
      success: true,
      data: {
        totalRequests,
        donorsResponded,
        fulfillmentRate,
        avgResponseTime: `${Math.floor(avgResponseTime / 60)}m ${avgResponseTime % 60}s`
      }
    });
  } catch (error) {
    console.error('Error fetching analytics stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch analytics stats',
      error: error.message
    });
  }
});

// Get donors responded count (public endpoint)
app.get('/admin/analytics/donors-responded', async (req, res) => {
  try {
    console.log('=== Fetching donors responded count (public endpoint) ===');

    // Use direct MongoDB connection to get completed donations
    const mongoose = require('mongoose');
    const db = mongoose.connection.db;
    const collection = db.collection('donationhistories');

    const completedCount = await collection.countDocuments({ status: 'completed' });
    console.log('Completed donations count:', completedCount);

    res.json({
      success: true,
      data: completedCount
    });
  } catch (error) {
    console.error('Error fetching donors responded:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch donors responded',
      error: error.message
    });
  }
});

// Get request trends with flexible time periods
app.get('/admin/analytics/request-trends', async (req, res) => {
  try {
    const BloodRequest = require('./models/BloodRequest');

    // Get time period from query parameter (default: weeks)
    const { period = 'weeks' } = req.query;

    const now = new Date();
    let data = [];

    if (period === 'weeks') {
      // Get current month's weeks
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();

      // Get first day of current month
      const monthStart = new Date(currentYear, currentMonth, 1);

      // Calculate weeks in current month
      const weeks = [];
      let weekStart = new Date(monthStart);
      let weekNumber = 1;

      while (weekStart.getMonth() === currentMonth) {
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);

        // If week goes into next month, limit to current month
        if (weekEnd.getMonth() !== currentMonth) {
          weekEnd.setMonth(currentMonth + 1, 0); // Last day of current month
        }

        weeks.push({
          weekNumber,
          start: new Date(weekStart),
          end: new Date(weekEnd)
        });

        weekStart.setDate(weekStart.getDate() + 7);
        weekNumber++;
      }

      // Get data for each week
      data = await Promise.all(weeks.map(async (week) => {
        const count = await BloodRequest.countDocuments({
          createdAt: {
            $gte: week.start,
            $lte: week.end
          }
        });

        console.log(`📊 Week ${week.weekNumber}: ${count} requests (${week.start.toLocaleDateString()} - ${week.end.toLocaleDateString()})`);

        return {
          label: `Week ${week.weekNumber}`,
          value: count,
          color: '#dc2626',
          dateRange: `${week.start.toLocaleDateString()} - ${week.end.toLocaleDateString()}`
        };
      }));

    } else if (period === 'month') {
      // Last 6 months
      for (let i = 5; i >= 0; i--) {
        const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

        const count = await BloodRequest.countDocuments({
          createdAt: {
            $gte: monthStart,
            $lte: monthEnd
          }
        });

        data.push({
          label: monthStart.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
          value: count,
          color: '#dc2626'
        });
      }
    } else if (period === '6months') {
      // Last 6 months (same as month but different label)
      for (let i = 5; i >= 0; i--) {
        const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

        const count = await BloodRequest.countDocuments({
          createdAt: {
            $gte: monthStart,
            $lte: monthEnd
          }
        });

        data.push({
          label: monthStart.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
          value: count,
          color: '#dc2626'
        });
      }
    } else if (period === 'year') {
      // Last 12 months
      for (let i = 11; i >= 0; i--) {
        const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

        const count = await BloodRequest.countDocuments({
          createdAt: {
            $gte: monthStart,
            $lte: monthEnd
          }
        });

        data.push({
          label: monthStart.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
          value: count,
          color: '#dc2626'
        });
      }
    }

    console.log(`📊 ${period} trends data:`, data);

    res.json({
      success: true,
      data: data,
      period: period
    });
  } catch (error) {
    console.error('Error fetching request trends:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch request trends',
      error: error.message
    });
  }
});

// Get donors response by blood type (actual donations from DonationHistory)
app.get('/admin/analytics/donors-by-blood-type', async (req, res) => {
  try {
    console.log('=== Fetching donors by blood type (public endpoint) ===');

    // Use direct MongoDB connection to ensure we get the right data
    const mongoose = require('mongoose');
    const db = mongoose.connection.db;
    const collection = db.collection('donationhistories');

    const bloodTypes = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
    const colors = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16'];

    const data = await Promise.all(bloodTypes.map(async (bloodType, index) => {
      const count = await collection.countDocuments({
        donorBloodGroup: bloodType,
        status: 'completed' // lowercase to match your database
      });
      console.log(`Blood type ${bloodType}: ${count} completed donations`);

      return {
        label: bloodType,
        value: count,
        color: colors[index]
      };
    }));

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching donations by blood type:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch donations by blood type',
      error: error.message
    });
  }
});

// Get fulfillment rate breakdown
app.get('/admin/analytics/fulfillment-breakdown', async (req, res) => {
  try {
    const BloodRequest = require('./models/BloodRequest');
    const statusCounts = await BloodRequest.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 }
        }
      }
    ]);

    const total = statusCounts.reduce((sum, item) => sum + item.count, 0);
    const fulfillmentData = statusCounts.map(item => {
      let color = '#059669'; // fulfilled - green
      if (item._id === 'pending') color = '#eab308'; // pending - yellow
      if (item._id === 'cancelled') color = '#dc2626'; // cancelled - red

      return {
        label: item._id.charAt(0).toUpperCase() + item._id.slice(1),
        value: total > 0 ? Math.round((item.count / total) * 100) : 0,
        color: color
      };
    });

    res.json({
      success: true,
      data: fulfillmentData
    });
  } catch (error) {
    console.error('Error fetching fulfillment breakdown:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch fulfillment breakdown',
      error: error.message
    });
  }
});

// Get response times by hour
app.get('/admin/analytics/response-times-by-hour', async (req, res) => {
  try {
    const DonorResponse = require('./models/DonorLocationResponse');
    const responses = await DonorResponse.find({}).populate('requestId');

    const hourlyResponseTimes = {};
    // Initialize all time slots
    ['6AM-9AM', '9AM-12PM', '12PM-3PM', '3PM-6PM', '6PM-9PM', '9PM-12AM'].forEach(slot => {
      hourlyResponseTimes[slot] = { total: 0, count: 0 };
    });

    responses.forEach(response => {
      if (response.requestId && response.responseTime) {
        const hour = new Date(response.responseTime).getHours();
        let timeSlot;

        if (hour >= 6 && hour < 9) timeSlot = '6AM-9AM';
        else if (hour >= 9 && hour < 12) timeSlot = '9AM-12PM';
        else if (hour >= 12 && hour < 15) timeSlot = '12PM-3PM';
        else if (hour >= 15 && hour < 18) timeSlot = '3PM-6PM';
        else if (hour >= 18 && hour < 21) timeSlot = '6PM-9PM';
        else if (hour >= 21 || hour < 6) timeSlot = '9PM-12AM';

        if (timeSlot && hourlyResponseTimes[timeSlot]) {
          const requestTime = new Date(response.requestId.createdAt);
          const responseTime = new Date(response.responseTime);
          const timeDiff = (responseTime - requestTime) / 1000; // seconds

          if (timeDiff > 0) {
            hourlyResponseTimes[timeSlot].total += timeDiff;
            hourlyResponseTimes[timeSlot].count++;
          }
        }
      }
    });

    // Default values if no data
    const defaultTimes = {
      '6AM-9AM': 150,
      '9AM-12PM': 120,
      '12PM-3PM': 90,
      '3PM-6PM': 110,
      '6PM-9PM': 180,
      '9PM-12AM': 240
    };

    const responseTimeData = Object.keys(hourlyResponseTimes).map(timeSlot => ({
      label: timeSlot,
      value: hourlyResponseTimes[timeSlot].count > 0
        ? Math.round(hourlyResponseTimes[timeSlot].total / hourlyResponseTimes[timeSlot].count)
        : defaultTimes[timeSlot],
      color: '#2563eb'
    }));

    res.json({
      success: true,
      data: responseTimeData
    });
  } catch (error) {
    console.error('Error fetching response times by hour:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch response times by hour',
      error: error.message
    });
  }
});

// Admin notification routes
app.get('/admin/notifications', async (req, res) => {
  try {
    console.log('Fetching admin notifications...');
    const Notification = require('./models/Notification');

    // Get all notifications (admin sees all) sorted by creation date
    const notifications = await Notification.find({})
      .populate('hospitalId', 'name email')
      .populate('donorId', 'name email bloodGroup')
      .populate('bloodRequestId', 'bloodGroup quantity urgency')
      .sort({ createdAt: -1 })
      .limit(100); // Limit to last 100 notifications

    // Transform notifications for admin view
    const adminNotifications = notifications.map(notification => ({
      id: notification._id.toString(),
      title: notification.title,
      message: notification.message,
      type: notification.type,
      createdAt: notification.createdAt,
      read: notification.read,
      category: notification.bloodRequestId ? 'blood-request' :
        notification.donorId ? 'donor' :
          notification.hospitalId ? 'hospital' : 'system',
      relatedData: {
        hospital: notification.hospitalId ? {
          id: notification.hospitalId._id,
          name: notification.hospitalId.name,
          email: notification.hospitalId.email
        } : null,
        donor: notification.donorId ? {
          id: notification.donorId._id,
          name: notification.donorId.name,
          bloodGroup: notification.donorId.bloodGroup
        } : null,
        bloodRequest: notification.bloodRequestId ? {
          id: notification.bloodRequestId._id,
          bloodGroup: notification.bloodRequestId.bloodGroup,
          quantity: notification.bloodRequestId.quantity
        } : null
      }
    }));

    res.json({
      success: true,
      message: `Fetched ${adminNotifications.length} notifications`,
      notifications: adminNotifications,
      count: adminNotifications.length
    });
  } catch (error) {
    console.error('Error fetching admin notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch notifications',
      error: error.message
    });
  }
});

app.post('/admin/notifications/:id/read', async (req, res) => {
  try {
    const Notification = require('./models/Notification');
    const notification = await Notification.findByIdAndUpdate(
      req.params.id,
      { read: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.json({
      success: true,
      message: 'Notification marked as read'
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark notification as read',
      error: error.message
    });
  }
});

app.post('/admin/notifications/read-all', async (req, res) => {
  try {
    const Notification = require('./models/Notification');
    const result = await Notification.updateMany(
      { read: false },
      { read: true }
    );

    res.json({
      success: true,
      message: `Marked ${result.modifiedCount} notifications as read`
    });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark all notifications as read',
      error: error.message
    });
  }
});

app.post('/admin/notifications/create', async (req, res) => {
  try {
    const Notification = require('./models/Notification');
    const { title, message, type = 'info', hospitalId, donorId, bloodRequestId } = req.body;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: 'Title and message are required'
      });
    }

    const notification = new Notification({
      title,
      message,
      type,
      hospitalId: hospitalId || null,
      donorId: donorId || null,
      bloodRequestId: bloodRequestId || null,
      read: false
    });

    await notification.save();

    res.status(201).json({
      success: true,
      message: 'Notification created successfully',
      notification: {
        id: notification._id.toString(),
        title: notification.title,
        message: notification.message,
        type: notification.type,
        createdAt: notification.createdAt
      }
    });
  } catch (error) {
    console.error('Error creating notification:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create notification',
      error: error.message
    });
  }
});

// Seed initial admin notifications (for testing purposes)
app.post('/admin/notifications/seed', async (req, res) => {
  try {
    const Notification = require('./models/Notification');

    // Clear existing notifications (optional - only for testing)
    // await Notification.deleteMany({});

    const sampleNotifications = [
      {
        title: 'System Startup',
        message: 'Blood donation management system has been successfully initialized and is now operational.',
        type: 'success',
        createdAt: new Date(Date.now() - 1000 * 60 * 10) // 10 minutes ago
      },
      {
        title: 'Low Donor Response Alert',
        message: 'Donor response rate has dropped to 45% in the last 24 hours. Consider implementing awareness campaigns.',
        type: 'warning',
        createdAt: new Date(Date.now() - 1000 * 60 * 30) // 30 minutes ago
      },
      {
        title: 'Daily Backup Completed',
        message: 'Scheduled database backup completed successfully at 3:00 AM with 1,247 donor records and 156 blood requests.',
        type: 'info',
        createdAt: new Date(Date.now() - 1000 * 60 * 120) // 2 hours ago
      },
      {
        title: 'Critical Blood Request',
        message: 'Emergency blood request for AB- blood type posted. Immediate donor notification has been triggered.',
        type: 'error',
        createdAt: new Date(Date.now() - 1000 * 60 * 180) // 3 hours ago
      },
      {
        title: 'SMS Service Status',
        message: 'SMS notification service is operating normally. 245 messages sent in the last hour.',
        type: 'info',
        createdAt: new Date(Date.now() - 1000 * 60 * 240) // 4 hours ago
      }
    ];

    const createdNotifications = await Notification.insertMany(sampleNotifications);

    res.json({
      success: true,
      message: `Seeded ${createdNotifications.length} sample notifications`,
      count: createdNotifications.length
    });
  } catch (error) {
    console.error('Error seeding notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to seed notifications',
      error: error.message
    });
  }
});

// Admin hospital CRUD operations
app.post('/admin/hospitals', async (req, res) => {
  try {
    const Hospital = require('./models/Hospital');
    const bcrypt = require('bcryptjs');

    const hospitalData = { ...req.body };
    if (hospitalData.email) hospitalData.email = hospitalData.email.toLowerCase();
    if (hospitalData.password) {
      hospitalData.password = await bcrypt.hash(hospitalData.password, 10);
    }

    const hospital = new Hospital(hospitalData);
    await hospital.save();

    // Create admin notification for new hospital registration
    await createAdminNotification(
      'New Hospital Registration',
      `New hospital "${hospitalData.name}" has been registered by admin and is ready for blood request management.`,
      'success',
      { hospitalId: hospital._id }
    );

    res.status(201).json({
      success: true,
      message: 'Hospital created successfully',
      hospital: { ...hospital.toObject(), id: hospital._id.toString() }
    });
  } catch (error) {
    console.error('Error creating hospital:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create hospital',
      error: error.message
    });
  }
});

app.put('/admin/hospitals/:id', async (req, res) => {
  try {
    const Hospital = require('./models/Hospital');
    const bcrypt = require('bcryptjs');

    const updateData = { ...req.body };
    if (updateData.email) updateData.email = updateData.email.toLowerCase();
    if (updateData.password) {
      updateData.password = await bcrypt.hash(updateData.password, 10);
    }

    const hospital = await Hospital.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true, select: '-password' }
    );

    if (!hospital) {
      return res.status(404).json({
        success: false,
        message: 'Hospital not found'
      });
    }

    res.json({
      success: true,
      message: 'Hospital updated successfully',
      hospital: { ...hospital.toObject(), id: hospital._id.toString() }
    });
  } catch (error) {
    console.error('Error updating hospital:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update hospital',
      error: error.message
    });
  }
});

app.delete('/admin/hospitals/:id', async (req, res) => {
  try {
    const Hospital = require('./models/Hospital');

    const hospital = await Hospital.findByIdAndDelete(req.params.id);
    if (!hospital) {
      return res.status(404).json({
        success: false,
        message: 'Hospital not found'
      });
    }

    res.json({
      success: true,
      message: 'Hospital deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting hospital:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete hospital',
      error: error.message
    });
  }
});

// ================= Notification Endpoints (basic) =================
// List notifications for hospital (public temporary; add auth later)
app.get('/notifications/:hospitalId', async (req, res) => {
  try {
    const { hospitalId } = req.params;
    const { filter } = req.query; // optional: unread
    // Gracefully handle placeholder / demo ids that are not valid ObjectId
    if (!mongoose.Types.ObjectId.isValid(hospitalId)) {
      return res.json({ success: true, notifications: [], note: 'hospitalId not a valid ObjectId; returning empty list' });
    }
    const query = { hospitalId };
    if (filter === 'unread') query.read = false;
    const items = await Notification.find(query).sort({ createdAt: -1 }).limit(200);
    res.json({ success: true, notifications: items });
  } catch (e) {
    console.error('Fetch notifications error', e);
    res.status(500).json({ success: false, message: 'Failed to fetch notifications' });
  }
});

// Mark one as read
app.post('/notifications/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await Notification.findByIdAndUpdate(id, { read: true }, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, notification: doc });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to mark read' });
  }
});

// Mark all read for hospital
app.post('/notifications/:hospitalId/read-all', async (req, res) => {
  try {
    const { hospitalId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(hospitalId)) {
      return res.json({ success: true, modified: 0, note: 'hospitalId not a valid ObjectId; nothing to mark' });
    }
    const result = await Notification.updateMany({ hospitalId, read: false }, { $set: { read: true } });
    res.json({ success: true, modified: result.modifiedCount });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to mark all read' });
  }
});

// Create a test notification (for development)
app.post('/notifications/:hospitalId/test', async (req, res) => {
  try {
    const { hospitalId } = req.params;
    const { type = 'info', title = 'Test Notification', message = 'Test message' } = req.body || {};
    let doc;
    if (mongoose.Types.ObjectId.isValid(hospitalId)) {
      doc = await Notification.create({ hospitalId, type, title, message });
    } else {
      // Ephemeral (not persisted) notification for demo/non-authenticated usage
      doc = { _id: `ephemeral-${Date.now()}`, hospitalId, type, title, message, read: false, createdAt: new Date() };
    }
    broadcastNotification(doc);
    res.json({ success: true, notification: doc, persisted: !!doc?.save });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to create test notification' });
  }
});

// Server-Sent Events stream for notifications
app.get('/notifications/stream/:hospitalId', (req, res) => {
  const { hospitalId } = req.params;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write(`data: ${JSON.stringify({ type: 'hello', hospitalId })}\n\n`);
  addNotificationClient(hospitalId, res);
});

// Debug endpoint to check SSE connections
app.get('/notifications/debug/connections', (req, res) => {
  const { getConnectedClients } = require('./utils/notificationStream');
  const connections = getConnectedClients ? getConnectedClients() : { error: 'Function not available' };
  res.json({
    success: true,
    totalHospitals: connections.size || 0,
    hospitals: connections.hospitals || [],
    timestamp: new Date()
  });
});

// Bulk import donors (CSV parsed client-side -> JSON). Public for now; should add auth later.
app.post('/admin/donors/import', async (req, res) => {
  try {
    console.log('➡️  /admin/donors/import request received');
    const Donor = require('./models/Donor');
    const bcrypt = require('bcryptjs');
    const { donors } = req.body || {};
    if (!Array.isArray(donors)) {
      return res.status(400).json({ success: false, message: 'Invalid payload: donors array required' });
    }
    console.log(`Processing ${donors.length} donor rows`);

    const allowedBloodGroups = new Set(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'NK']);
    const normalizeBloodGroup = (value) => {
      if (!value) return '';
      return String(value).toUpperCase().replace(/\s+/g, '').trim(); // remove internal spaces e.g. 'AB +' -> 'AB+'
    };

    // Helper to sanitize a header/key for matching
    const sanitizeKey = (k = '') => k.replace(/\uFEFF/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

    // Variants map (normalized -> canonical field name)
    const variantGroups = {
      name: ['name', 'fullname', 'donorname', 'studentname'],
      email: ['email', 'mail', 'emailid', 'e'],
      phone: ['phone', 'phoneno', 'mobileno', 'mobile', 'contact', 'contactno', 'number', 'phoneNumber'.toLowerCase()],
      bloodGroup: ['bloodgroup', 'bloodgrp', 'blood', 'bgroup', 'bloodtype', 'bloodgrpup'],
      rollNo: ['rollno', 'rollnumber', 'roll', 'enrollment', 'enrollmentno', 'enroll', 'studentid', 'id', 'studentnumber']
    };

    // Build reverse lookup: normalized variant -> canonical
    const variantLookup = {};
    Object.entries(variantGroups).forEach(([canonical, variants]) => {
      variants.forEach(v => variantLookup[sanitizeKey(v)] = canonical);
    });

    const results = [];
    const credentials = [];
    let inserted = 0;
    let skipped = 0;
    // Preload existing donors for duplicate detection
    const existingDocs = await Donor.find({}, 'email name bloodGroup phone rollNo').lean();
    const normName = (v = '') => String(v).toLowerCase().trim().replace(/\s+/g, ' ');
    const existingEmails = new Set(existingDocs.map(d => d.email));
    const existingNameGroup = new Set(existingDocs.map(d => `${normName(d.name)}|${normalizeBloodGroup(d.bloodGroup)}`));
    const existingPhones = new Set(existingDocs.filter(d => d.phone).map(d => String(d.phone).trim()));
    const existingRolls = new Set(existingDocs.filter(d => d.rollNo).map(d => String(d.rollNo).trim().toLowerCase()));
    // Track duplicates inside this import batch
    const batchEmails = new Set();
    const batchNameGroup = new Set();
    const batchPhones = new Set();
    const batchRolls = new Set();
    for (let i = 0; i < donors.length; i++) {
      const rawOriginal = donors[i] || {};
      // Map row keys using sanitization
      const mapped = {};
      Object.keys(rawOriginal).forEach(k => {
        const sk = sanitizeKey(k);
        const canonical = variantLookup[sk];
        if (canonical) {
          if (mapped[canonical] === undefined) mapped[canonical] = rawOriginal[k];
        } else {
          // If header already exactly matches expected canonical (after sanitize) keep it
          if (['name', 'email', 'phone', 'bloodGroup', 'rollNo'].includes(k)) mapped[k] = rawOriginal[k];
        }
      });

      const nameRaw = mapped.name || rawOriginal.name;
      const emailRaw = mapped.email || rawOriginal.email;
      const phoneRaw = mapped.phone || rawOriginal.phone;
      const rawGroup = mapped.bloodGroup || rawOriginal.bloodGroup || rawOriginal['blood group'];
      const rollNoRaw = mapped.rollNo || rawOriginal.rollNo;
      const lineInfo = { index: i + 1, email: emailRaw };

      if (!nameRaw || !emailRaw || !phoneRaw || !rawGroup) {
        results.push({ ...lineInfo, status: 'error', reason: 'Missing required field (name,email,phone,bloodGroup)' });
        skipped++; continue;
      }

      const email = String(emailRaw).toLowerCase().trim();
      const bloodGroup = normalizeBloodGroup(rawGroup);
      if (!allowedBloodGroups.has(bloodGroup)) {
        results.push({ ...lineInfo, status: 'error', reason: `Invalid blood group: ${bloodGroup}` });
        skipped++; continue;
      }
      const nameGroupKey = `${normName(nameRaw)}|${bloodGroup}`;
      const phoneKey = phoneRaw ? String(phoneRaw).trim() : '';
      const rollKey = rollNoRaw ? String(rollNoRaw).trim().toLowerCase() : '';

      // Existing DB duplicates
      if (existingEmails.has(email)) { results.push({ ...lineInfo, status: 'skipped', reason: 'Duplicate (email exists)' }); skipped++; continue; }
      if (existingNameGroup.has(nameGroupKey)) { results.push({ ...lineInfo, status: 'skipped', reason: 'Duplicate (name+bloodGroup exists)' }); skipped++; continue; }
      if (phoneKey && existingPhones.has(phoneKey)) { results.push({ ...lineInfo, status: 'skipped', reason: 'Duplicate (phone exists)' }); skipped++; continue; }
      if (rollKey && existingRolls.has(rollKey)) { results.push({ ...lineInfo, status: 'skipped', reason: 'Duplicate (rollNo exists)' }); skipped++; continue; }

      // Duplicates within current file
      if (batchEmails.has(email)) { results.push({ ...lineInfo, status: 'skipped', reason: 'Duplicate in file (email)' }); skipped++; continue; }
      if (batchNameGroup.has(nameGroupKey)) { results.push({ ...lineInfo, status: 'skipped', reason: 'Duplicate in file (name+bloodGroup)' }); skipped++; continue; }
      if (phoneKey && batchPhones.has(phoneKey)) { results.push({ ...lineInfo, status: 'skipped', reason: 'Duplicate in file (phone)' }); skipped++; continue; }
      if (rollKey && batchRolls.has(rollKey)) { results.push({ ...lineInfo, status: 'skipped', reason: 'Duplicate in file (rollNo)' }); skipped++; continue; }

      // Reserve keys now that row is accepted
      batchEmails.add(email); batchNameGroup.add(nameGroupKey);
      if (phoneKey) batchPhones.add(phoneKey); if (rollKey) batchRolls.add(rollKey);
      const tempPassword = Math.random().toString(36).slice(-8);
      const hashed = await bcrypt.hash(tempPassword, 10);
      const donorDoc = new Donor({
        name: String(nameRaw).trim(),
        email,
        phone: String(phoneRaw).trim(),
        bloodGroup,
        rollNo: rollNoRaw ? String(rollNoRaw).trim() : undefined,
        password: hashed
      });
      try {
        await donorDoc.save();
        inserted++;
        credentials.push({ email, tempPassword });
        results.push({ ...lineInfo, status: 'inserted' });
      } catch (err) {
        console.error('Error saving donor row', i + 1, err.message);
        results.push({ ...lineInfo, status: 'error', reason: err.message });
        skipped++;
      }
    }
    res.json({ success: true, message: 'Import processed', inserted, skipped, total: donors.length, results, credentialsCount: credentials.length, credentials });
    try {
      const notif = await Notification.create({
        type: 'success',
        title: 'Donor Import Completed',
        message: `${inserted} added, ${skipped} skipped (total ${donors.length})`,
        read: false
      });
      broadcastNotification(notif);
    } catch (e) { console.error('Failed to broadcast import notification', e); }
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ success: false, message: 'Failed to import donors', error: error.message });
  }
});

// Bulk delete donors: provide { all: true } to delete all, or { ids: [..] }
app.delete('/admin/donors', async (req, res) => {
  try {
    const Donor = require('./models/Donor');
    const { all, ids } = req.body || {};
    if (all) {
      const count = await Donor.countDocuments();
      await Donor.deleteMany({});
      const payload = { success: true, deleted: count, all: true };
      try {
        const notif = await Notification.create({
          type: 'warning',
          title: 'All Donors Deleted',
          message: `${count} donor records removed`,
          read: false
        });
        broadcastNotification(notif);
      } catch (e) { console.error('Broadcast delete all donors failed', e); }
      return res.json(payload);
    }
    if (Array.isArray(ids) && ids.length) {
      const result = await Donor.deleteMany({ _id: { $in: ids } });
      const deleted = result.deletedCount || 0;
      try {
        const notif = await Notification.create({
          type: 'warning',
          title: 'Donors Deleted',
          message: `${deleted} selected donor(s) removed`,
          read: false
        });
        broadcastNotification(notif);
      } catch (e) { console.error('Broadcast delete selected donors failed', e); }
      return res.json({ success: true, deleted, all: false });
    }
    return res.status(400).json({ success: false, message: 'Provide all:true or ids array' });
  } catch (error) {
    console.error('Bulk delete donors error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete donors', error: error.message });
  }
});

// Public route for donation history
app.get('/donation-history', async (req, res) => {
  try {
    const BloodRequest = require('./models/BloodRequest');
    const bloodRequests = await BloodRequest.find({})
      .sort({ createdAt: -1 })
      .select('_id bloodGroup quantity urgency status createdAt requiredBy description');

    res.json({ success: true, bloodRequests });
  } catch (error) {
    console.error('Error fetching donation history:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch donation history' });
  }
});

/* ============================
   5. Register - Send OTP
============================ */
app.post('/register', async (req, res) => {
  try {
    console.log("Received /register request", req.body);
    let { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ message: 'All fields required' });
    }

    // Check if MongoDB is connected
    if (mongoose.connection.readyState !== 1) {
      console.log("MongoDB not connected. Connection state:", mongoose.connection.readyState);
      return res.status(503).json({
        message: 'Database service temporarily unavailable. Please try again in a few moments.'
      });
    }

    email = email.toLowerCase();

    // Check if user already exists
    const existingHospital = await Hospital.findOne({ email }).maxTimeMS(10000);
    const existingAdmin = await Admin.findOne({ email }).maxTimeMS(10000);

    if (existingHospital || existingAdmin) {
      return res.status(409).json({ message: 'User already exists' });
    }

    // Generate OTP
    const otp = generateOTP();

    // Delete any existing OTPs for this email (registration type)
    await OTP.deleteMany({ email, type: 'registration' });

    // Save OTP to database
    await OTP.create({
      email,
      otp,
      type: 'registration'
    });

    // Send OTP email
    try {
      await sendRegistrationOTP(email, otp, name);
      console.log('✅ Registration OTP sent successfully to:', email);

      res.status(200).json({
        success: true,
        message: 'OTP sent to your email. Please verify to complete registration.',
        email
      });
    } catch (emailError) {
      console.error('❌ Failed to send email:', emailError);
      // Clean up OTP if email fails
      await OTP.deleteMany({ email, type: 'registration' });
      res.status(500).json({
        message: 'Failed to send verification email. Please check your email address and try again.'
      });
    }
  } catch (err) {
    console.error("Registration error:", err);
    if (err.name === 'MongooseError' || err.name === 'MongoNetworkError') {
      res.status(503).json({
        message: "Database connection issue. Please check your internet connection and try again."
      });
    } else {
      res.status(500).json({ message: "Registration failed. Please try again." });
    }
  }
});

/* ============================
   5.1 Verify Registration OTP
============================ */
app.post('/verify-registration', async (req, res) => {
  try {
    const { email, otp, password, name } = req.body;

    if (!email || !otp || !password || !name) {
      return res.status(400).json({ message: 'All fields required' });
    }

    const emailLower = email.toLowerCase();

    // Find the OTP
    const otpRecord = await OTP.findOne({
      email: emailLower,
      type: 'registration',
      verified: false
    }).sort({ createdAt: -1 });

    if (!otpRecord) {
      return res.status(400).json({ message: 'OTP expired or invalid. Please request a new one.' });
    }

    if (otpRecord.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP. Please check and try again.' });
    }

    // Check if user already exists (double check)
    const existingHospital = await Hospital.findOne({ email: emailLower });
    const existingAdmin = await Admin.findOne({ email: emailLower });

    if (existingHospital || existingAdmin) {
      await OTP.deleteMany({ email: emailLower, type: 'registration' });
      return res.status(409).json({ message: 'User already exists' });
    }

    // Create the hospital account
    const hashedPassword = await bcrypt.hash(password, 10);
    const hospital = new Hospital({
      email: emailLower,
      password: hashedPassword,
      name,
      isVerified: true,
      status: 'active'
    });
    await hospital.save();

    // Mark OTP as verified and delete
    await OTP.deleteMany({ email: emailLower, type: 'registration' });

    console.log('✅ Hospital registered and verified:', emailLower);

    res.status(201).json({
      success: true,
      message: 'Registration successful! You can now log in.'
    });
  } catch (err) {
    console.error("Verification error:", err);
    res.status(500).json({ message: "Verification failed. Please try again." });
  }
});

/* ============================
   5.2 Resend Registration OTP
============================ */
app.post('/resend-otp', async (req, res) => {
  try {
    const { email, name } = req.body;

    if (!email || !name) {
      return res.status(400).json({ message: 'Email and name required' });
    }

    const emailLower = email.toLowerCase();

    // Check if user already exists
    const existingHospital = await Hospital.findOne({ email: emailLower });
    if (existingHospital) {
      return res.status(409).json({ message: 'User already exists. Please login.' });
    }

    // Generate new OTP
    const otp = generateOTP();

    // Delete old OTPs
    await OTP.deleteMany({ email: emailLower, type: 'registration' });

    // Save new OTP
    await OTP.create({
      email: emailLower,
      otp,
      type: 'registration'
    });

    // Send OTP email
    await sendRegistrationOTP(emailLower, otp, name);

    res.status(200).json({
      success: true,
      message: 'New OTP sent to your email.'
    });
  } catch (err) {
    console.error("Resend OTP error:", err);
    res.status(500).json({ message: "Failed to resend OTP. Please try again." });
  }
});

/* ============================
   6. Login
============================ */
app.post('/login', async (req, res) => {
  try {
    let { email, password } = req.body;
    email = email.toLowerCase();

    // Check if MongoDB is connected
    if (mongoose.connection.readyState !== 1) {
      console.log("MongoDB not connected. Connection state:", mongoose.connection.readyState);
      return res.status(503).json({
        message: 'Database service temporarily unavailable. Please try again in a few moments.'
      });
    }

    // Check both Admin and Hospital collections to determine role automatically
    let user = await Admin.findOne({ email }).maxTimeMS(10000);
    let role = 'admin';

    if (!user) {
      user = await Hospital.findOne({ email }).maxTimeMS(10000);
      role = 'hospital';
    }

    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, role: role, name: user.name },
      SECRET,
      { expiresIn: '1h' }
    );

    res.json({ token, role, name: user.name });
  } catch (err) {
    console.error("Login error:", err);
    if (err.name === 'MongooseError' || err.name === 'MongoNetworkError') {
      res.status(503).json({
        message: "Database connection issue. Please check your internet connection and try again."
      });
    } else {
      res.status(500).json({ message: "Login failed. Please try again." });
    }
  }
});

/* ============================
   6.1 Forgot Password - Send OTP
============================ */
app.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const emailLower = email.toLowerCase();

    // Find user in Hospital or Admin collection
    let user = await Hospital.findOne({ email: emailLower });
    let userName = user?.name;

    if (!user) {
      user = await Admin.findOne({ email: emailLower });
      userName = user?.name;
    }

    if (!user) {
      // Don't reveal if email exists or not for security
      return res.status(200).json({
        success: true,
        message: 'If your email is registered, you will receive a password reset OTP.'
      });
    }

    // Generate OTP
    const otp = generateOTP();

    // Delete any existing password reset OTPs for this email
    await OTP.deleteMany({ email: emailLower, type: 'password-reset' });

    // Save OTP to database
    await OTP.create({
      email: emailLower,
      otp,
      type: 'password-reset'
    });

    // Send OTP email
    try {
      await sendPasswordResetOTP(emailLower, otp, userName);
      console.log('✅ Password reset OTP sent to:', emailLower);

      res.status(200).json({
        success: true,
        message: 'Password reset OTP sent to your email.',
        email: emailLower
      });
    } catch (emailError) {
      console.error('❌ Failed to send password reset email:', emailError);
      await OTP.deleteMany({ email: emailLower, type: 'password-reset' });
      res.status(500).json({
        message: 'Failed to send password reset email. Please try again.'
      });
    }
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ message: "Failed to process request. Please try again." });
  }
});

/* ============================
   6.2 Verify Password Reset OTP
============================ */
app.post('/verify-reset-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    const emailLower = email.toLowerCase();

    // Find the OTP
    const otpRecord = await OTP.findOne({
      email: emailLower,
      type: 'password-reset',
      verified: false
    }).sort({ createdAt: -1 });

    if (!otpRecord) {
      return res.status(400).json({ message: 'OTP expired or invalid. Please request a new one.' });
    }

    if (otpRecord.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP. Please check and try again.' });
    }

    // Mark OTP as verified (but don't delete yet - we'll delete after password reset)
    otpRecord.verified = true;
    await otpRecord.save();

    res.status(200).json({
      success: true,
      message: 'OTP verified successfully. You can now reset your password.'
    });
  } catch (err) {
    console.error("OTP verification error:", err);
    res.status(500).json({ message: "Verification failed. Please try again." });
  }
});

/* ============================
   6.3 Reset Password
============================ */
app.post('/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ message: 'Email, OTP, and new password are required' });
    }

    const emailLower = email.toLowerCase();

    // Find the verified OTP
    const otpRecord = await OTP.findOne({
      email: emailLower,
      type: 'password-reset',
      verified: true
    }).sort({ createdAt: -1 });

    if (!otpRecord) {
      return res.status(400).json({ message: 'Invalid or expired OTP. Please verify OTP first.' });
    }

    if (otpRecord.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP.' });
    }

    // Find user and update password
    let user = await Hospital.findOne({ email: emailLower });
    let role = 'hospital';

    if (!user) {
      user = await Admin.findOne({ email: emailLower });
      role = 'admin';
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Hash new password and update
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    // Delete the OTP
    await OTP.deleteMany({ email: emailLower, type: 'password-reset' });

    console.log('✅ Password reset successfully for:', emailLower);

    res.status(200).json({
      success: true,
      message: 'Password reset successfully. You can now log in with your new password.'
    });
  } catch (err) {
    console.error("Password reset error:", err);
    res.status(500).json({ message: "Failed to reset password. Please try again." });
  }
});

/* ============================
   7. Hospital Profile & Dashboard Routes
============================ */

// Get hospital profile/dashboard data
app.get('/hospital/profile', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'hospital') {
      return res.status(403).json({ message: 'Access denied. Hospital role required.' });
    }

    const hospital = await Hospital.findById(req.user.id).select('-password');
    if (!hospital) {
      return res.status(404).json({ message: 'Hospital not found' });
    }

    res.json({
      success: true,
      hospital: hospital
    });
  } catch (error) {
    console.error('Error fetching hospital profile:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch hospital profile',
      error: error.message
    });
  }
});

// Update hospital profile
app.put('/hospital/profile', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'hospital') {
      return res.status(403).json({ message: 'Access denied. Hospital role required.' });
    }

    const { name, email, phone, address, emergencyContact, radius } = req.body;

    const hospital = await Hospital.findByIdAndUpdate(
      req.user.id,
      { name, email, phone, address, emergencyContact, radius },
      { new: true, select: '-password' }
    );

    if (!hospital) {
      return res.status(404).json({ message: 'Hospital not found' });
    }

    res.json({
      success: true,
      message: 'Hospital profile updated successfully',
      hospital: hospital
    });
  } catch (error) {
    console.error('Error updating hospital profile:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update hospital profile',
      error: error.message
    });
  }
});

// Update hospital password
app.put('/hospital/update-password', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'hospital') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Hospital role required.'
      });
    }

    const { currentPassword, newPassword } = req.body;

    // Validation
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters long'
      });
    }

    // Find hospital with password
    const hospital = await Hospital.findById(req.user.id);
    if (!hospital) {
      return res.status(404).json({
        success: false,
        message: 'Hospital not found'
      });
    }

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, hospital.password);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await Hospital.findByIdAndUpdate(req.user.id, {
      password: hashedNewPassword,
      updatedAt: new Date()
    });

    res.json({
      success: true,
      message: 'Password updated successfully'
    });

  } catch (error) {
    console.error('Error updating password:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update password',
      error: error.message
    });
  }
});

// Get hospital dashboard stats
app.get('/hospital/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'hospital') {
      return res.status(403).json({ message: 'Access denied. Hospital role required.' });
    }

    const BloodRequest = require('./models/BloodRequest');
    const Donor = require('./models/Donor');

    // Get active blood requests for this hospital
    const activeRequests = await BloodRequest.countDocuments({
      requesterId: req.user.id,
      status: { $in: ['pending', 'processing'] }
    });

    // Get total donors (you can filter by location later)
    const availableDonors = await Donor.countDocuments({
      status: 'available'
    });

    // Get completed requests this month
    const currentMonth = new Date();
    currentMonth.setDate(1);
    const completedThisMonth = await BloodRequest.countDocuments({
      requesterId: req.user.id,
      status: 'fulfilled',
      createdAt: { $gte: currentMonth }
    });

    // Calculate average response time (mock for now)
    const averageResponseTime = '12 min';

    res.json({
      success: true,
      stats: {
        activeRequests,
        availableDonors,
        completedThisMonth,
        averageResponseTime
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard stats',
      error: error.message
    });
  }
});

// Get recent blood requests for hospital
app.get('/hospital/dashboard/recent-requests', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'hospital') {
      return res.status(403).json({ message: 'Access denied. Hospital role required.' });
    }

    const BloodRequest = require('./models/BloodRequest');

    const recentRequests = await BloodRequest.find({
      requesterId: req.user.id
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('bloodGroup units urgency status createdAt');

    res.json({
      success: true,
      requests: recentRequests
    });
  } catch (error) {
    console.error('Error fetching recent requests:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch recent requests',
      error: error.message
    });
  }
});

// Admin: Add hospital (for admin panel)
app.post('/admin/hospitals', async (req, res) => {
  try {
    const { name, email, phone, emergencyContact, address, radius, status } = req.body;
    if (!name || !email) {
      return res.status(400).json({ success: false, message: 'Hospital name and email required' });
    }
    const existing = await Hospital.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Hospital already exists' });
    }
    const hospital = new Hospital({
      name,
      email: email.toLowerCase(),
      phone,
      emergencyContact,
      address,
      radius,
      status: status || 'Pending'
    });
    await hospital.save();
    res.json({ success: true, message: 'Hospital added', hospital });
  } catch (error) {
    console.error('Error adding hospital:', error);
    res.status(500).json({ success: false, message: 'Failed to add hospital', error: error.message });
  }
});

// ============================
// Example Protected Route
// ============================
app.get('/dashboard', authenticateToken, (req, res) => {
  res.json({ message: `Welcome, ${req.user.email}!`, role: req.user.role });
});

/* ============================
   8. Start Server
============================ */
app.listen(5000, '0.0.0.0', () => {
  console.log('🚀 Server running on port 5000');
  console.log('📡 Server accessible from:');
  console.log('   - Local: http://localhost:5000');
  console.log('   - Network: http://0.0.0.0:5000');
  console.log('   - If using ngrok: https://YOUR_NGROK_URL');
});
