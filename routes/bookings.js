const express = require('express');
const router = express.Router();
const calendar = require('../config/googleCalendar');
const Booking = require('../models/Booking');
const pricing = require('../services/pricing');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const ClassSchedule = require('../models/ClassSchedule');
const Holiday = require('../models/Holiday');
const { authMiddleware } = require('../utils/auth');
const mongoose = require('mongoose');

router.get('/available-slots', async (req, res) => {
    const { serviceType, date } = req.query;
    const requestedDate = new Date(date);
    requestedDate.setHours(0, 0, 0, 0);

    try {
        // 1. Check if it's a holiday
        const holiday = await Holiday.findOne({ date: requestedDate });
        if (holiday) {
            return res.json([]);
        }

        // 2. Get the day of the week
        const dayOfWeek = requestedDate.getDay();

        // 3. Query ClassSchedule (find all matching schedules)
        const classSchedules = await ClassSchedule.find({
            serviceType: serviceType,
            dayOfWeek: dayOfWeek,
        });

        const availableSlots = [];

        // 4. Iterate through the class schedules
        for (const schedule of classSchedules) {
            const startTime = new Date(requestedDate);
            const [startHour, startMinute] = schedule.startTime.split(':').map(Number);
            startTime.setHours(startHour, startMinute, 0, 0);

            const endTime = new Date(requestedDate);
            const [endHour, endMinute] = schedule.endTime.split(':').map(Number);
            endTime.setHours(endHour, endMinute, 0, 0);

            // 5. Count existing bookings for this specific class schedule
            const existingBookingsCount = await Booking.countDocuments({
                serviceType: serviceType,
                start: startTime,
                end: endTime,
                status: { $ne: 'cancelled' } // Exclude cancelled bookings
            });

            // 6. Check against the capacity from ClassSchedule
            if (existingBookingsCount < schedule.capacity) {
                // 7. Check Google Calendar for conflicts (optional, but recommended)
                const calendarId = process.env.GOOGLE_CALENDAR_ID;
                const response = await calendar.freebusy.query({
                    requestBody: {
                        timeMin: startTime.toISOString(),
                        timeMax: endTime.toISOString(),
                        items: [{ id: calendarId }],
                    },
                });
                const busySlots = response.data.calendars[calendarId].busy;

                // Check if there are any events that would prevent booking (e.g., manual overrides)
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
        }

        res.json(availableSlots);

    } catch (err) {
        console.error('Error fetching available slots:', err);
        res.status(500).json({ message: 'Error fetching available slots' });
    }
});

// --- Create a Booking ---

router.post('/', authMiddleware, async (req, res) => {
    // ... (same as before, up to cost calculation) ...
    const { serviceType, daysPerWeek, paymentType, openPlayOption, partyDuration, selectedSlot, classId, semesterStartDate, semesterEndDate } = req.body;
    const userId = req.user._id;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // ... (holiday retrieval and cost calculation - same as before) ...
        const holidays = await Holiday.find({
            date: { $gte: semesterStartDate, $lte: semesterEndDate }
        }).session(session);
        const holidayDates = holidays.map((h) => new Date(h.date));

        let costDetails;
        if (serviceType === 'playgroup') {
            costDetails = pricing.calculatePlayGroupCost(daysPerWeek, paymentType, semesterStartDate, semesterEndDate, holidayDates);
        } else if (serviceType === 'openplay') {
            costDetails = pricing.calculateOpenPlayCost(openPlayOption);
        } else if (serviceType === 'birthday') {
            costDetails = pricing.calculateBirthdayPartyCost(partyDuration);
        } else {
            await session.abortTransaction();
            return res.status(400).json({ message: 'Invalid service type' });
        }
        if (costDetails.error) {
            await session.abortTransaction();
            return res.status(400).json({ message: costDetails.error });
        }

        const startTime = new Date(selectedSlot.start);
        const endTime = new Date(selectedSlot.end);
        const dayOfWeek = startTime.getDay();

        // 1. Find the relevant ClassSchedule
        const classSchedule = await ClassSchedule.findOne({
            serviceType: serviceType,
            dayOfWeek: dayOfWeek,
            startTime: startTime.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
            endTime: endTime.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
        }).session(session);

        if (!classSchedule) {
            await session.abortTransaction();
            return res.status(400).json({ message: 'No class scheduled for this time' });
        }

        // 2. Count existing bookings for this class (within the transaction)
        const existingBookingsCount = await Booking.countDocuments({
            serviceType: serviceType,
            start: startTime,
            end: endTime,
            status: { $ne: 'cancelled' }
        }).session(session);

        // 3. Check if capacity has been reached
        if (existingBookingsCount >= classSchedule.capacity) {
            await session.abortTransaction();
            return res.status(409).json({ message: 'Class is full' });
        }

        // --- STRIPE INTEGRATION (Start) --- (Still a placeholder, inside the transaction)
        // ... (Your Stripe PaymentIntent creation logic here) ...

        // 4. Create the booking (within the transaction)
        const newBooking = new Booking({
            user: userId,
            class: classId,
            serviceType: serviceType,
            cost: costDetails.totalActualCost,
            details: costDetails,
            start: startTime,
            end: endTime,
        });

        const savedBooking = await newBooking.save({ session });

        // --- 5. Google Calendar Logic (Booking Calendar - Individual Events) ---
        const bookingEvent = {
            summary: `${serviceType} Booking - ${userId}`, // Individual booking event
            start: { dateTime: startTime.toISOString(), timeZone: 'America/New_York' },
            end: { dateTime: endTime.toISOString(), timeZone: 'America/New_York' },
            description: `Booking ID: ${savedBooking._id}\nService: ${serviceType}\nCost: ${costDetails.totalActualCost}`,
            attendees: [],
        };

        const bookingCalendarResponse = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID, // Booking Calendar
            resource: bookingEvent,
        });

        savedBooking.googleCalendarEventId = bookingCalendarResponse.data.id;
        await savedBooking.save({ session });

        // --- 6. Google Calendar Logic (Display Calendar - Single Event per Class) ---
        if (existingBookingsCount === 0) {
            // First booking: Create event on Display Calendar
            const displayEvent = {
                summary: `${serviceType} Class`, // Generic class event
                start: { dateTime: startTime.toISOString(), timeZone: 'America/New_York' },
                end: { dateTime: endTime.toISOString(), timeZone: 'America/New_York' },
                description: `Capacity: ${classSchedule.capacity}`,
                transparency: 'transparent', // Initially "free"
            };

            const displayCalendarResponse = await calendar.events.insert({
                calendarId: process.env.DISPLAY_CALENDAR_ID, // Display Calendar
                resource: displayEvent,
            });

            // Store the Display Calendar event ID in the ClassSchedule
            classSchedule.displayCalendarEventId = displayCalendarResponse.data.id;
            await classSchedule.save({ session });

        } else if (existingBookingsCount + 1 === classSchedule.capacity) {
            // Class is now full: Mark event on Display Calendar as "busy"
            if (classSchedule.displayCalendarEventId) {
                await calendar.events.patch({
                    calendarId: process.env.DISPLAY_CALENDAR_ID, // Display Calendar
                    eventId: classSchedule.displayCalendarEventId,
                    requestBody: {
                        transparency: 'opaque', // "Busy"
                    },
                });
            }
        } else {
            // Optional: Update description on Display Calendar (e.g., "3/10 slots filled")
            if (classSchedule.displayCalendarEventId) {
                await calendar.events.patch({
                    calendarId: process.env.DISPLAY_CALENDAR_ID,
                    eventId: classSchedule.displayCalendarEventId,
                    requestBody: {
                        description: `Capacity: ${classSchedule.capacity}, Bookings: ${existingBookingsCount + 1}`,
                    },
                });
            }
        }

        // --- STRIPE INTEGRATION (End) --- (Still a placeholder)
        // ... (Your Stripe booking confirmation logic here, inside the transaction) ...

        await session.commitTransaction();
        session.endSession();

        res.status(201).json(savedBooking);

    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error creating booking:', err);
        res.status(500).json({ message: 'Error creating booking' });
    }
});

// --- Delete a Booking ---

router.delete('/:id', authMiddleware, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const booking = await Booking.findById(req.params.id).session(session);
        if (!booking) {
            await session.abortTransaction();
            return res.status(404).json({ message: 'Booking not found' });
        }

        // Check if the user making the request owns the booking
        if (booking.user.toString() !== req.user._id) {
            await session.abortTransaction();
            return res.status(403).json({ message: 'Unauthorized' });
        }

        const startTime = new Date(booking.start);
        const endTime = new Date(booking.end);
        const dayOfWeek = startTime.getDay();

        // 1. Find the relevant ClassSchedule
        const classSchedule = await ClassSchedule.findOne({
            serviceType: booking.serviceType,
            dayOfWeek: dayOfWeek,
            startTime: startTime.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
            endTime: endTime.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
        }).session(session);

        //Count Bookings
        const existingBookingsCount = await Booking.countDocuments({
            serviceType: booking.serviceType,
            start: startTime,
            end: endTime,
            status: { $ne: 'cancelled' }
        }).session(session);

        // 2. Delete the individual booking event from the Booking Calendar
        if (booking.googleCalendarEventId) {
            await calendar.events.delete({
                calendarId: process.env.GOOGLE_CALENDAR_ID, // Booking Calendar
                eventId: booking.googleCalendarEventId,
            });
        }

        // 3. Update the Display Calendar event
        if (existingBookingsCount === classSchedule.capacity) {
            // Class was full, now it's not: Mark as "free"
            if (classSchedule.displayCalendarEventId) {
                await calendar.events.patch({
                    calendarId: process.env.DISPLAY_CALENDAR_ID, // Display Calendar
                    eventId: classSchedule.displayCalendarEventId,
                    requestBody: {
                        transparency: 'transparent', // "Free"
                    },
                });
            }
        } else if (existingBookingsCount > 1) {
            // Optional: Update description on Display Calendar
            if (classSchedule.displayCalendarEventId) {
                await calendar.events.patch({
                    calendarId: process.env.DISPLAY_CALENDAR_ID,
                    eventId: classSchedule.displayCalendarEventId,
                    requestBody: {
                        description: `Capacity: ${classSchedule.capacity}, Bookings: ${existingBookingsCount - 1}`,
                    },
                });
            }
        } else {
            // Last booking deleted:  Delete the event from the Display Calendar
            if(classSchedule.displayCalendarEventId) {
                await calendar.events.delete({
                    calendarId: process.env.DISPLAY_CALENDAR_ID,
                    eventId: classSchedule.displayCalendarEventId
                })
            }
        }

        // 4. Delete the booking from your database
        await Booking.findByIdAndDelete(req.params.id).session(session);

        await session.commitTransaction();
        session.endSession();
        res.json({ message: 'Booking deleted' });

    } catch (err) {
        await session.abortTransaction();
        session.endSession();
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