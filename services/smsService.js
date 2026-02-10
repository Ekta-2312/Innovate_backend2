const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;

let client;
if (accountSid && authToken) {
    client = twilio(accountSid, authToken);
}

const sendSMS = async (to, body) => {
    if (!client) {
        console.warn('[SMS] Twilio client not initialized. Mocking response.');
        console.log(`[MOCK SMS] To: ${to}, Body: ${body}`);
        return { success: true, sid: 'mock_sid_' + Date.now() };
    }

    try {
        // Basic normalization: ensure it starts with +
        let formattedTo = to.trim();
        if (!formattedTo.startsWith('+')) {
            // Assume +91 (India) if 10 digits and no prefix, or adjust as needed
            if (formattedTo.length === 10) {
                formattedTo = '+91' + formattedTo;
            } else {
                formattedTo = '+' + formattedTo;
            }
        }

        console.log(`[SMS] Sending real SMS to ${formattedTo}...`);
        const message = await client.messages.create({
            body: body,
            from: twilioNumber,
            to: formattedTo
        });
        console.log(`[SMS] Success! SID: ${message.sid}`);
        return { success: true, sid: message.sid };
    } catch (error) {
        console.error('[SMS] Error sending SMS:', error);
        return { success: false, error: error.message };
    }
};


const getSMSTemplate = async (priority) => {
    return "URGENT BLOOD REQUEST: {quantity} units of {bloodType} needed at {hospital}. {urgency}. Respond: {responseUrl}";
};

const formatSMSMessage = (template, vars) => {
    let msg = template;
    for (const key in vars) {
        msg = msg.replace(`{${key}}`, vars[key]);
    }
    return msg;
};

module.exports = { sendSMS, getSMSTemplate, formatSMSMessage };

