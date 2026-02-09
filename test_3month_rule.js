const mongoose = require('mongoose');
const Donor = require('./models/Donor');

require('dotenv').config();

const uri = process.env.MONGODB_URI;

async function runTest() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(uri);
        console.log('Connected!');

        // 1. Setup Test Data
        const baseEmail = `test.donor.${Date.now()}@example.com`;

        // Donor 1: Donated 1 month ago (Should be BLOCKED)
        const recentDonorDate = new Date();
        recentDonorDate.setMonth(recentDonorDate.getMonth() - 1);

        // Donor 2: Donated 4 months ago (Should be ALLOWED)
        const eligibleDonorDate = new Date();
        eligibleDonorDate.setMonth(eligibleDonorDate.getMonth() - 4);

        // Donor 3: Never donated (Should be ALLOWED)
        // No date set

        const testDonors = [
            {
                name: 'Test Recent',
                email: 'recent.' + baseEmail,
                bloodGroup: 'O+',
                phone: '1234567890',
                password: 'pass',
                lastDonationDate: recentDonorDate
            },
            {
                name: 'Test Eligible',
                email: 'eligible.' + baseEmail,
                bloodGroup: 'O+',
                phone: '1234567891',
                password: 'pass',
                lastDonationDate: eligibleDonorDate
            },
            {
                name: 'Test New',
                email: 'new.' + baseEmail,
                bloodGroup: 'O+',
                phone: '1234567892',
                password: 'pass'
                // No lastDonationDate
            }
        ];

        console.log('\nCreating test donors...');
        const createdDonors = await Donor.create(testDonors);
        console.log('Created 3 test donors.');

        // 2. Run the Filtering Logic (Simulating bloodRequestController.js)
        console.log('\n--- TESTING FILTER LOGIC ---');
        console.log('Simulating request for O+ blood...');

        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        console.log('Cutoff Date (3 months ago):', threeMonthsAgo.toLocaleDateString());

        const matchingDonors = createdDonors.filter(donor => {
            // Logic copied from controller
            if (donor.lastDonationDate) {
                const lastDonation = new Date(donor.lastDonationDate);

                if (lastDonation > threeMonthsAgo) {
                    console.log(`❌ BLOCKING: ${donor.name} (Donated: ${lastDonation.toLocaleDateString()}) - Too recent`);
                    return false;
                }
            }

            console.log(`✅ ALLOWING: ${donor.name} (Donated: ${donor.lastDonationDate ? new Date(donor.lastDonationDate).toLocaleDateString() : 'Never'})`);
            return true;
        });

        console.log('---------------------------');
        console.log(`\nResult: Selected ${matchingDonors.length} out of ${createdDonors.length} donors.`);

        const recentPassed = !matchingDonors.find(d => d.name === 'Test Recent');
        const eligiblePassed = !!matchingDonors.find(d => d.name === 'Test Eligible');
        const newPassed = !!matchingDonors.find(d => d.name === 'Test New');

        if (recentPassed && eligiblePassed && newPassed) {
            console.log('\n🟢 TEST PASSED: Logic correctly filtered donors.');
        } else {
            console.log('\n🔴 TEST FAILED: Logic did not work as expected.');
            console.log('Recent blocked?', recentPassed);
            console.log('Eligible allowed?', eligiblePassed);
            console.log('New allowed?', newPassed);
        }

        // 3. Cleanup
        console.log('\nCleaning up test data...');
        await Donor.deleteMany({ email: { $in: testDonors.map(d => d.email) } });
        console.log('Cleanup done.');

    } catch (err) {
        console.error('Test Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

runTest();
