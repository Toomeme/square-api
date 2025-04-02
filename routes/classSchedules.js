// routes/classSchedules.js (Create this file)

const express = require('express');
const router = express.Router();
const ClassSchedule = require('../models/ClassSchedule');

// GET /api/class-schedules?serviceType=playgroup
router.get('/', async (req, res) => {
    const { serviceType } = req.query;

    if (!serviceType) {
        return res.status(400).json({ message: 'serviceType query parameter is required' });
    }

    try {
        const schedules = await ClassSchedule.find({ serviceType: serviceType })
            .sort({ dayOfWeek: 1, startTime: 1 }); // Sort for predictable order on frontend

        res.json(schedules);
    } catch (err) {
        console.error('Error fetching class schedules:', err);
        res.status(500).json({ message: 'Error fetching class schedules' });
    }
});

module.exports = router;