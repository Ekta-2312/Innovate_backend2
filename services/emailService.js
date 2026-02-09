const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

const sendRegistrationOTP = async (email, otp) => {
    console.log(`[MOCK EMAIL] Sending registration OTP ${otp} to ${email}`);
    return true;
};

const sendPasswordResetOTP = async (email, otp) => {
    console.log(`[MOCK EMAIL] Sending password reset OTP ${otp} to ${email}`);
    return true;
};

module.exports = { generateOTP, sendRegistrationOTP, sendPasswordResetOTP };
