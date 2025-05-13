// routes/pricing.js (Create this file)

const express = require('express');
const router = express.Router();
const pricing = require('../services/pricing'); // Your existing pricing service
const Holiday = require('../models/Holiday');
const { authMiddleware } = require('../utils/auth'); // Protect if needed, though cost calc might be public

// Endpoint to calculate Playgroup Semester Cost
// POST /api/pricing/calculate-playgroup
router.post('/calculate-playgroup', async (req, res) => {
    console.log("--- CALCULATE PLAYGROUP COST HANDLER ---");
    const { semesterStartDate, semesterEndDate, daysPerWeekBitmask, paymentType } = req.body;

    // Basic Input Validation
    if (!semesterStartDate || !semesterEndDate || daysPerWeekBitmask === undefined || !paymentType) {
        return res.status(400).json({ message: 'Missing required fields for cost calculation.' });
    }
    if (typeof daysPerWeekBitmask !== 'number' || daysPerWeekBitmask <= 0) {
        return res.status(400).json({ message: 'Invalid daysPerWeekBitmask.' });
    }

    try {
        const startDate = new Date(semesterStartDate);
        const endDate = new Date(semesterEndDate);

        // Fetch holidays within the semester range
        const holidays = await Holiday.find({
            date: { $gte: startDate, $lte: endDate }
        });
        const holidayDates = holidays.map(h => new Date(h.date)); // Pass Date objects to pricing function

        console.log("Calculating cost with:", { daysPerWeekBitmask, paymentType, startDate, endDate, holidayCount: holidayDates.length });

        // Calculate number of days selected from bitmask (needed for the pricing function)
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

        console.log("Number of days selected from bitmask:", numberOfDaysSelected);


        // Call your existing pricing function
        const costDetails = pricing.calculatePlayGroupCost(
            numberOfDaysSelected, // Correctly calculated number of days
            daysPerWeekBitmask,   // Pass the bitmask itself
            paymentType,
            startDate,           // Pass Date objects
            endDate,             // Pass Date objects
            holidayDates         // Pass Date objects
        );

        if (costDetails.error) {
            console.error("Pricing calculation error:", costDetails.error);
            return res.status(400).json({ message: costDetails.error });
        }

        console.log("Calculated cost details:", costDetails);
        res.json(costDetails);

    } catch (err) {
        console.error('Error calculating playgroup cost:', err);
        res.status(500).json({ message: 'Server error calculating cost' });
    }
});

router.post('/calculate-rolling-playgroup', async (req, res) => {
    console.log("--- CALCULATE ROLLING PLAYGROUP COST HANDLER ---");
    const { startDate: startDateString, daysPerWeekBitmask, paymentType } = req.body;
    const durationWeeks = 6; // Define duration

        // Basic Input Validation
        if (!semesterStartDate || !semesterEndDate || daysPerWeekBitmask === undefined || !paymentType) {
            return res.status(400).json({ message: 'Missing required fields for cost calculation.' });
        }
        if (typeof daysPerWeekBitmask !== 'number' || daysPerWeekBitmask <= 0) {
            return res.status(400).json({ message: 'Invalid daysPerWeekBitmask.' });
        }
    // Validate date format
    const enrollmentStartDate = new Date(startDateString + 'T00:00:00.000Z'); // Treat as UTC start day
    if (isNaN(enrollmentStartDate.getTime())) return res.status(400).json({ message: 'Invalid start date format (YYYY-MM-DD required).' });

    try {
        // Calculate end date for holiday fetching
        const enrollmentEndDate = addWeeks(enrollmentStartDate, durationWeeks);
        enrollmentEndDate.setDate(enrollmentEndDate.getDate() - 1);

        // Fetch holidays within the specific range
        const holidays = await Holiday.find({ date: { $gte: enrollmentStartDate, $lte: enrollmentEndDate } }).lean();
        const holidayDates = holidays.map(h => h.date);

        let numberOfDaysSelected = 0; /* ... calculate from bitmask ... */

        // Call the modified pricing function
        const costDetails = pricing.calculateRollingPlaygroupCost(
            numberOfDaysSelected,
            daysPerWeekBitmask,
            paymentType,
            enrollmentStartDate, // Pass Date object
            durationWeeks,
            holidayDates         // Pass Date objects
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