const BloodRequest = require('../models/BloodRequest');
const Donor = require('../models/Donor');
const Hospital = require('../models/Hospital');
const ResponseToken = require('../models/ResponseToken');
const Notification = require('../models/Notification');
const { sendSMS, getSMSTemplate, formatSMSMessage } = require('../services/smsService');
const { broadcastNotification } = require('../utils/notificationStream');

// Send next batch of SMS
const sendNextBatch = async (requestId) => {
  try {
    const request = await BloodRequest.findById(requestId).populate('hospitalId');
    if (!request) return;

    // Check if request is already fulfilled or cancelled
    if (request.status === 'fulfilled' || request.status === 'cancelled' || request.status === 'expired') {
      return;
    }

    // Check if queue is empty
    if (request.remainingDonorsQueue.length === 0) {
      console.log(`[Batch] No more donors in queue for request ${requestId}`);
      return;
    }

    const batchSize = request.batchSize || 1;

    // Extract batch
    const nextBatchIds = request.remainingDonorsQueue.slice(0, batchSize);

    // Remove from queue and add to notified
    request.remainingDonorsQueue = request.remainingDonorsQueue.slice(batchSize);
    request.notifiedDonors.push(...nextBatchIds);

    // Set batch tracking
    request.batchSentAt = new Date();
    request.batchInProgress = true;

    await request.save();

    console.log(`\n📦 === SENDING BATCH SMS ===`);
    console.log(`Request ID: ${requestId}`);
    console.log(`Batch Size: ${nextBatchIds.length}`);

    // Fetch donor details
    const donors = await Donor.find({ _id: { $in: nextBatchIds } });
    const hospital = request.hospitalId;

    let smsSuccessCount = 0;

    // Process batch
    const smsPromises = donors.map(async (donor) => {
      try {
        const donorPhone = donor.phoneNumber || donor["Mobile No"] || donor.phone;
        const donorName = donor["Student Name"] || donor.name || donor._id;

        if (!donorPhone) return;

        // Generate tracking token
        const responseToken = Math.random().toString(36).substr(2, 8);

        await ResponseToken.create({
          token: responseToken,
          requestId: request._id,
          donorId: donor._id
        });

        // Prepare SMS content
        let urgencyText;
        if (request.urgency === 'pregnancy') urgencyText = 'PREGNANCY EMERGENCY - URGENT';
        else if (request.urgency === 'high') urgencyText = 'HIGH PRIORITY - EMERGENCY';
        else if (request.urgency === 'medium') urgencyText = 'MEDIUM PRIORITY';
        else urgencyText = 'LOW PRIORITY';

        const priority = (request.urgency === 'high' || request.urgency === 'pregnancy') ? 'high' : 'normal';
        const smsTemplate = await getSMSTemplate(priority);

        const templateVars = {
          hospital: hospital.name,
          bloodType: request.bloodGroup,
          quantity: request.quantity,
          urgency: urgencyText,
          donorName: donorName,
          responseUrl: `https://innovate-tracker2.vercel.app/${request._id}`,
        };

        let message;
        if (request.urgency === 'pregnancy') {
          message = `PREGNANCY EMERGENCY: ${request.quantity} units ${request.bloodGroup} blood needed URGENTLY for pregnant patient at ${hospital.name}. Please respond: ${templateVars.responseUrl}`;
        } else {
          message = formatSMSMessage(smsTemplate, templateVars);
          if (!message.includes('http') && !message.includes('{responseUrl}')) {
            message += ` Respond: ${templateVars.responseUrl}`;
          }
        }

        const smsResult = await sendSMS(donorPhone, message);

        if (smsResult.success) {
          smsSuccessCount++;
          try {
            const notif = await Notification.create({
              hospitalId: hospital.id,
              type: 'info',
              title: 'SMS Sent (Batch)',
              message: `SMS sent to ${donorName} (${donorPhone})`,
              meta: { bloodRequestId: request._id, donorId: donor._id, smsId: smsResult.sid }
            });
            broadcastNotification(notif);
          } catch (e) {
            console.error('Failed to create notification', e);
          }
        }
      } catch (err) {
        console.error(`Failed to process donor ${donor._id} in batch:`, err);
      }
    });

    await Promise.allSettled(smsPromises);
    console.log(`✅ Batch complete. Sent: ${smsSuccessCount}/${donors.length}`);

  } catch (error) {
    console.error('Error in sendNextBatch:', error);
  }
};

// Create a new blood request
const createBloodRequest = async (req, res) => {
  try {
    const { bloodGroup, quantity, urgency, requiredBy, description, patientAge, patientCondition } = req.body;
    const hospital = req.user;

    const bloodRequest = new BloodRequest({
      hospitalId: hospital.id,
      bloodGroup,
      quantity,
      urgency,
      requiredBy,
      description,
      patientAge,
      patientCondition,
      confirmedUnits: 0,
      batchSize: 1,
      responseWindow: 2,
      batchInProgress: false,
      status: 'active'
    });

    const allDonors = await Donor.find({});
    const matchingDonors = allDonors.filter(donor => {
      const donorBloodGroup = donor.bloodGroup || donor["Blood Group"];
      if (donor.lastDonationDate) {
        const lastDonation = new Date(donor.lastDonationDate);
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        if (lastDonation > threeMonthsAgo) return false;
      }
      const normalizedRequested = bloodGroup.replace(/\s+/g, '').toUpperCase();
      const normalizedDonor = donorBloodGroup ? donorBloodGroup.replace(/\s+/g, '').toUpperCase() : '';
      return normalizedDonor === normalizedRequested;
    });

    matchingDonors.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const donorIds = matchingDonors.map(d => d._id);
    bloodRequest.remainingDonorsQueue = donorIds;

    await bloodRequest.save();

    try {
      const notification = await Notification.create({
        hospitalId: hospital.id,
        type: 'info',
        title: 'Blood Request Created',
        message: `${quantity} unit(s) of ${bloodGroup} requested. Queued ${donorIds.length} donors.`,
        meta: { bloodRequestId: bloodRequest._id }
      });
      broadcastNotification(notification);
    } catch (e) { }

    sendNextBatch(bloodRequest._id);

    res.status(201).json({
      success: true,
      data: { requestId: bloodRequest._id }
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getAllBloodRequests = async (req, res) => {
  try {
    const requests = await BloodRequest.find({}).populate('hospitalId', 'name').sort({ createdAt: -1 });
    res.json({ success: true, data: requests });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getBloodRequestById = async (req, res) => {
  try {
    const { id } = req.params;
    const request = await BloodRequest.findById(id).populate('hospitalId', 'name');

    if (!request) {
      return res.status(404).json({ success: false, message: 'Blood request not found' });
    }

    const now = new Date();
    const isExpired = now > new Date(request.requiredBy);
    const isFull = request.confirmedUnits >= request.quantity;

    // Check if we need to update status automatically
    if (request.status === 'active') {
      if (isFull) {
        request.status = 'fulfilled';
        await request.save();
      } else if (isExpired) {
        request.status = 'expired';
        await request.save();
      }
    }

    // Requirements: If not active, or fulfilled, or expired -> return closed
    if (request.status !== 'active' || isFull || isExpired) {
      return res.json({
        success: true,
        status: 'closed',
        message: 'Blood request fulfilled. Thank you.'
      });
    }

    res.json({ success: true, data: request });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const confirmDonation = async (req, res) => {
  try {
    const { requestId } = req.body;
    const now = new Date();

    // Atomic update to prevent race conditions and overbooking
    // Criteria: ID matches, status is active, confirmed < quantity, and not expired
    const updatedRequest = await BloodRequest.findOneAndUpdate(
      {
        _id: requestId,
        status: 'active',
        $expr: { $lt: ['$confirmedUnits', '$quantity'] },
        requiredBy: { $gte: now }
      },
      { $inc: { confirmedUnits: 1 } },
      { new: true }
    );

    if (!updatedRequest) {
      return res.status(400).json({
        success: false,
        message: 'Blood request already fulfilled or expired.'
      });
    }

    // After increment, check if it just became fulfilled
    if (updatedRequest.confirmedUnits >= updatedRequest.quantity) {
      updatedRequest.status = 'fulfilled';
      await updatedRequest.save();
    }

    res.json({
      success: true,
      message: 'Donation confirmed successfully.',
      data: updatedRequest
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};


module.exports = {
  createBloodRequest,
  getAllBloodRequests,
  getBloodRequestById,
  confirmDonation,
  sendNextBatch
};
