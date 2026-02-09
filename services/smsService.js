const sendSMS = async (to, body) => {
    console.log(`[MOCK SMS] To: ${to}, Body: ${body}`);
    return { success: true, sid: 'mock_sid_' + Date.now() };
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
