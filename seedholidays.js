// seedHolidays.js
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db'); // Adjust path if needed
const Holiday = require('./models/Holiday'); // Adjust path if needed

// --- Configure Holidays Here ---
// Use YYYY-MM-DD format. The script stores them as UTC midnight.
const holidaysToSeed = [
    { name: "New Year's Day", date: "2026-01-01" },
    { name: "Martin Luther King, Jr. Day", date: "2026-01-15" },
    { name: "Presidents' Day", date: "2026-02-19" },
    { name: "Labor Day", date: "2025-09-02" },
    { name: "Thanksgiving Day", date: "2025-11-28" },
    { name: "Christmas Eve", date: "2025-12-24" }, // Example custom
    { name: "Christmas Day", date: "2025-12-25" },
    { name: "Memorial Day", date: "2025-05-26" },
    { name: "Independence Day", date: "2025-07-04" },
    { name: "Normal Closed", date: "2025-04-06" },
    { name: "Normal Closed", date: "2025-04-07" },
    { name: "Normal Closed", date: "2025-04-08" },
    { name: "Normal Closed", date: "2025-04-09" },
    { name: "Normal Closed", date: "2025-04-10" },
    { name: "Normal Closed", date: "2025-04-11" },
    { name: "Normal Closed", date: "2025-04-12" },
    { name: "Normal Closed", date: "2025-04-13" },
    { name: "Normal Closed", date: "2025-04-14" },
    { name: "Normal Closed", date: "2025-04-15" },
    { name: "Normal Closed", date: "2025-04-16" },
    { name: "Normal Closed", date: "2025-04-17" },
    { name: "Normal Closed", date: "2025-04-18" },
    { name: "Normal Closed", date: "2025-04-19" },
    { name: "Normal Closed", date: "2025-04-20" },
    // Add more holidays as needed for future years or specific closures
];
// --- End Configuration ---

const seedDB = async () => {
    let connection; // Define connection variable in the outer scope
    try {
        console.log('Connecting to MongoDB...');
        connection = await connectDB(); // Assuming connectDB returns the connection or resolves on success
        console.log('MongoDB Connected.');

        // Optional: Clear existing holidays first
        // Be careful with this in production!
        const shouldClear = process.argv.includes('--clear'); // Check for command-line flag
        if (shouldClear) {
            console.warn('Clearing existing holidays...');
            await Holiday.deleteMany({});
            console.log('Existing holidays cleared.');
        } else {
             console.log('Skipping clearing of existing holidays. Use --clear flag to delete existing ones first.');
        }


        console.log(`Attempting to seed ${holidaysToSeed.length} holidays...`);

        let seededCount = 0;
        let skippedCount = 0;

        for (const holidayData of holidaysToSeed) {
            // Convert YYYY-MM-DD string to a Date object representing UTC midnight
            // This ensures consistent storage regardless of server timezone
            const dateUTC = new Date(holidayData.date + 'T00:00:00.000Z');

            if (isNaN(dateUTC.getTime())) {
                 console.error(`Skipping invalid date format: ${holidayData.date} for ${holidayData.name}`);
                 skippedCount++;
                 continue; // Skip if date is invalid
            }


            // Optional: Check if holiday with the same name and date already exists
            const existing = await Holiday.findOne({ name: holidayData.name, date: dateUTC });
            if (existing) {
                 console.log(`Skipping existing holiday: ${holidayData.name} on ${holidayData.date}`);
                 skippedCount++;
            } else {
                const newHoliday = new Holiday({
                    name: holidayData.name,
                    date: dateUTC, // Store the UTC Date object
                });
                await newHoliday.save();
                seededCount++;
                console.log(`Seeded: ${holidayData.name} on ${holidayData.date}`);
            }
        }

        console.log('\n--- Seeding Complete ---');
        console.log(`Successfully seeded: ${seededCount}`);
        console.log(`Skipped (duplicate or invalid): ${skippedCount}`);

    } catch (err) {
        console.error('\n--- Seeding Failed ---');
        console.error(err);
        process.exitCode = 1; // Indicate failure
    } finally {
        // Ensure connection is closed
        // The exact method depends on how connectDB sets up the connection
        // Option 1: If connectDB returns the connection instance
        // if (connection && connection.close) {
        //     await connection.close();
        //     console.log('MongoDB connection closed.');
        // }
        // Option 2: Use mongoose.connection directly (common)
        if (mongoose.connection && mongoose.connection.readyState === 1) { // Check if connected
            await mongoose.connection.close();
            console.log('MongoDB connection closed.');
        }
    }
};

// Run the seeding function
seedDB();