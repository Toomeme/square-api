// routes/pricing.js (Create this file)

const express = require('express');
const router = express.Router();
const pricing = require('../services/pricing'); // Your existing pricing service
const Holiday = require('../models/Holiday');
const {addWeeks} = require('date-fns');
// Endpoint to calculate Playgroup Semester Cost
// POST /api/pricing/calculate-playgroup


router.post('/calculate-rolling-playgroup', async (req, res) => {
    console.log("--- CALCULATE ROLLING PLAYGROUP COST HANDLER ---");
    const { startDate: startDateString, daysPerWeekBitmask, paymentType, durationWeeks } = req.body;

        // Basic Input Validation
        if (!startDateString || daysPerWeekBitmask === undefined || !paymentType || !durationWeeks) {
            return res.status(400).json({ message: 'Missing required fields for cost calculation.' });
        }
        if (typeof daysPerWeekBitmask !== 'number' || daysPerWeekBitmask <= 0) {
            return res.status(400).json({ message: 'Invalid daysPerWeekBitmask.' });
        }
        const parsedDuration = parseInt(durationWeeks, 10);
        if (isNaN(parsedDuration) || parsedDuration <= 0) {
            return res.status(400).json({ message: "Invalid durationWeeks." });
        }
    // Validate date format
    const enrollmentStartDate = new Date(startDateString + 'T00:00:00.000Z'); // Treat as UTC start day
    if (isNaN(enrollmentStartDate.getTime())) return res.status(400).json({ message: 'Invalid start date format (YYYY-MM-DD required).' });

    try {
        // Calculate end date for holiday fetching
        const enrollmentEndDate = addWeeks(enrollmentStartDate, parsedDuration);
        enrollmentEndDate.setDate(enrollmentEndDate.getDate() - 1);

        // Fetch holidays within the specific range
        const holidays = await Holiday.find({ date: { $gte: enrollmentStartDate, $lte: enrollmentEndDate } }).lean();
        const holidayDates = holidays.map(h => h.date);

        let numberOfDaysSelected = 0;
        let tempMask = daysPerWeekBitmask;
        while (tempMask > 0) {
            if (tempMask & 1) numberOfDaysSelected++;
            tempMask >>= 1; // Shift right
        }
         // Recalculate numberOfDays based on the bitmask, as the frontend might not send it
         numberOfDaysSelected = 0;
         tempMask = daysPerWeekBitmask;
         while (tempMask > 0) {
             tempMask &= (tempMask - 1); // Brian Kernighan's algorithm to count set bits
             numberOfDaysSelected++;
         }

        // Call the modified pricing function
        const costDetails = pricing.calculateRollingPlaygroupCost(
            numberOfDaysSelected,
            daysPerWeekBitmask,
            paymentType,
            holidayDates,         // Corrected order
            enrollmentStartDate,  // Corrected order
            parsedDuration              // Pass Date objects
        );

        if (costDetails.error) return res.status(400).json({ message: costDetails.error });
        res.json(costDetails);

    } catch (err) {
        console.error('Error calculating playgroup cost:', err);
        res.status(500).json({ message: 'Server error calculating cost' });
    }
});

// Add other pricing calculation endpoints if needed (e.g., dynamic birthday costs)

module.exports = router;