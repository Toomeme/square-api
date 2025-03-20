const express = require('express');
const router = express.Router();
const calendar = require('../config/googleCalendar');
const Booking = require('../models/Booking');
const pricing = require('../services/pricing');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const ClassSchedule = require('../models/ClassSchedule'); // Import
const Holiday = require('../models/Holiday'); // Import
const { authMiddleware } = require('../utils/auth'); // Import authMiddleware

// --- Get Available Slots ---
router.get('/available-slots', async (req, res) => {
    const { serviceType, date } = req.query;
    const requestedDate = new Date(date);
    requestedDate.setHours(0, 0, 0, 0); // Set to start of day for accurate comparison

    try {
        // 1. Check if the requested date is a holiday
        const holiday = await Holiday.findOne({ date: requestedDate });
        if (holiday) {
            return res.json([]); // Return an empty array if it's a holiday
            // OR: return res.json({ message: 'Closed for holiday' });
        }

        // 2. If not a holiday, proceed with checking class schedule and Google Calendar
        const calendarId = process.env.GOOGLE_CALENDAR_ID;
        const timeMin = new Date(date);
        timeMin.setHours(0, 0, 0, 0);
        const timeMax = new Date(date);
        timeMax.setHours(23, 59, 59, 999);

        const response = await calendar.freebusy.query({
            requestBody: {
                timeMin: timeMin.toISOString(),
                timeMax: timeMax.toISOString(),
                items: [{ id: calendarId }],
            },
        });

        const busySlots = response.data.calendars[calendarId].busy;

        // 3. Get the day of the week (0 = Sunday, 1 = Monday, ...)
        const dayOfWeek = requestedDate.getDay();

        // 4. Query the ClassSchedule for the relevant service type and day of the week
        const classSchedules = await ClassSchedule.find({
            serviceType: serviceType,
            dayOfWeek: dayOfWeek,
        });

        const availableSlots = [];

        // 5. Iterate through the scheduled class times
        for (const schedule of classSchedules) {
            const startTime = new Date(timeMin);
            const [startHour, startMinute] = schedule.startTime.split(':').map(Number);
            startTime.setHours(startHour, startMinute, 0, 0);

            const endTime = new Date(timeMin);
            const [endHour, endMinute] = schedule.endTime.split(':').map(Number);
            endTime.setHours(endHour, endMinute, 0, 0);

            // 6. Check if this class time is busy
            const isBusy = busySlots.some(busySlot => {
                const busyStart = new Date(busySlot.start);
                const busyEnd = new Date(busySlot.end);
                return (startTime < busyEnd && endTime > busyStart);
            });

            if (!isBusy) {
                availableSlots.push({
                    start: startTime.toISOString(),
                    end: endTime.toISOString(),
                });
            }
        }

        res.json(availableSlots);

    } catch (err) {
        console.error('Error fetching available slots:', err);
        res.status(500).json({ message: 'Error fetching available slots' });
    }
});

// --- Create a Booking ---
router.post('/', authMiddleware, async (req, res) => { // Protect with authMiddleware
    const { serviceType, daysPerWeek, paymentType, openPlayOption, partyDuration, selectedSlot, classId, semesterStartDate, semesterEndDate } = req.body;
    const userId = req.user._id; // Get user ID from authMiddleware

    try {
        // 1. Get relevant holidays
        const holidays = await Holiday.find({
            date: { $gte: semesterStartDate, $lte: semesterEndDate }
        });

        // Convert holidays to Date objects (if they aren't already)
        const holidayDates = holidays.map(h => new Date(h.date));

        // 2. Calculate the cost
        let costDetails;
        if (serviceType === 'playgroup') {
            costDetails = pricing.calculatePlayGroupCost(daysPerWeek, paymentType, semesterStartDate, semesterEndDate, holidayDates);
        } else if (serviceType === 'openplay') {
            costDetails = pricing.calculateOpenPlayCost(openPlayOption);
        } else if (serviceType === 'birthday') {
            costDetails = pricing.calculateBirthdayPartyCost(partyDuration);
        } else {
            return res.status(400).json({ message: 'Invalid service type' });
        }

        if (costDetails.error) {
            return res.status(400).json({ message: costDetails.error });
        }

        // 3. Check for double-booking
        const timeMin = new Date(selectedSlot.start);
        const timeMax = new Date(selectedSlot.end);
        const existingBookings = await Booking.find({
            start: { $lt: timeMax },
            end: { $gt: timeMin },
            status: { $ne: 'cancelled' }
        });

        if (existingBookings.length > 0) {
            return res.status(409).json({ message: 'Slot is no longer available' });
        }

        // --- STRIPE INTEGRATION (Start) --- (Still a placeholder)
        // ... (Your Stripe PaymentIntent creation logic here) ...

        // 4. Create the booking in your database
        const newBooking = new Booking({
            user: userId, // Use the authenticated user's ID
            class: classId,
            serviceType: serviceType,
            cost: costDetails.totalActualCost, // Use totalActualCost
            details: costDetails,
            start: selectedSlot.start,
            end: selectedSlot.end,
        });

        const savedBooking = await newBooking.save();

        // 5. Create the event in Google Calendar
        const event = {
            summary: `${serviceType} Booking - ${userId}`, // Consider including user's name
            start: { dateTime: selectedSlot.start, timeZone: 'America/New_York' },
            end: { dateTime: selectedSlot.end, timeZone: 'America/New_York' },
            description: `Booking ID: ${savedBooking._id}\nService: ${serviceType}\nCost: ${costDetails.totalActualCost}`, // Use totalActualCost
            attendees: [],
        };

        const calendarResponse = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: event,
        });

        savedBooking.googleCalendarEventId = calendarResponse.data.id;
        await savedBooking.save();

        // --- STRIPE INTEGRATION (End) --- (Still a placeholder)
        // ... (Your Stripe booking confirmation logic here) ...

        res.status(201).json(savedBooking);

    } catch (err) {
        console.error('Error creating booking:', err);
        res.status(500).json({ message: 'Error creating booking' });
    }
});

// --- Delete a Booking ---
router.delete('/:id', authMiddleware, async (req, res) => { // Protect with authMiddleware
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) {
            return res.status(404).json({ message: 'Booking not found' });
        }

        // Check if the user making the request owns the booking
        if (booking.user.toString() !== req.user._id) {
            return res.status(403).json({ message: 'Unauthorized' }); // 403 Forbidden
        }

        if (booking.googleCalendarEventId) {
            await calendar.events.delete({
                calendarId: process.env.GOOGLE_CALENDAR_ID,
                eventId: booking.googleCalendarEventId,
            });
        }

        await Booking.findByIdAndDelete(req.params.id);
        res.json({ message: 'Booking deleted' });

    } catch (err) {
        console.error('Error deleting booking:', err);
        res.status(500).json({ message: 'Error deleting booking' });
    }
});
// --- Stripe Webhook Endpoint (VERY IMPORTANT) --- (No changes needed)
router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed.', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    // Handle the event
    switch (event.type) {
        case 'payment_intent.succeeded':
            const paymentIntent = event.data.object;
            // Find the booking by the ID in metadata (you'd need to have stored it there)
            // Update the booking status to 'paid'
            // Potentially create the Google Calendar event here (if you didn't do it earlier)
            console.log('PaymentIntent was successful!');
            break;
        case 'payment_intent.payment_failed':
            // Handle payment failure
            console.log('PaymentIntent failed!');
            break;
        // ... handle other event types
        default:
            console.log(`Unhandled event type ${event.type}`);
    }
    
    res.json({received: true});

    });
    module.exports = router;