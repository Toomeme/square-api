// populateClassSchedules.js
require('dotenv').config();
const mongoose = require('mongoose');
const ClassSchedule = require('./models/ClassSchedule');
const Booking = require('./models/Booking'); // Import Booking model
const connectDB = require('./config/db');
const calendar = require('./config/googleCalendar');

connectDB();

const classSchedules = [
    // --- Playgroup ---
    {
        serviceType: 'playgroup',
        dayOfWeek: 1, // Monday
        startTime: '09:00',
        endTime: '10:00',
        capacity: 2, // Reduced for testing
        displayCalendarEventId: null,
    },
    {
        serviceType: 'playgroup',
        dayOfWeek: 1, // Monday
        startTime: '10:30',
        endTime: '11:30',
        capacity: 3, // Reduced for testing
        displayCalendarEventId: null,
    },
    {
        serviceType: 'playgroup',
        dayOfWeek: 3, // Wednesday
        startTime: '09:00',
        endTime: '10:00',
        capacity: 2, // Reduced for testing
        displayCalendarEventId: null,
    },
    {
        serviceType: 'playgroup',
        dayOfWeek: 5, // Friday
        startTime: '09:00',
        endTime: '10:00',
        capacity: 4, // Reduced for testing
        displayCalendarEventId: null,
    },

    // --- Open Play ---
    {
        serviceType: 'openplay',
        dayOfWeek: 2, // Tuesday
        startTime: '14:00',
        endTime: '16:00',
        capacity: 5, // Reduced for testing
        displayCalendarEventId: null,
    },
    {
        serviceType: 'openplay',
        dayOfWeek: 4, // Thursday
        startTime: '14:00',
        endTime: '16:00',
        capacity: 5, // Reduced for testing
        displayCalendarEventId: null,
    },
    {
        serviceType: 'openplay',
        dayOfWeek: 6, // Saturday
        startTime: '10:00',
        endTime: '12:00',
        capacity: 5, // Reduced for testing
        displayCalendarEventId: null,
    },

    // --- Birthday Parties (Example - you might handle these differently) ---
    {
        serviceType: 'birthday',
        dayOfWeek: 6, // Saturday
        startTime: '13:00',
        endTime: '15:00',
        capacity: 3, // Reduced for testing
        displayCalendarEventId: null,
    },
    {
        serviceType: 'birthday',
        dayOfWeek: 0, // Sunday
        startTime: '11:00',
        endTime: '13:00',
        capacity: 3, // Reduced for testing
        displayCalendarEventId: null,
    },
];

const seedDB = async () => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        await ClassSchedule.deleteMany({}).session(session);
        await Booking.deleteMany({}).session(session); // Also clear bookings

        for (const scheduleData of classSchedules) {
            const newSchedule = new ClassSchedule(scheduleData);
            const savedSchedule = await newSchedule.save({ session });

            // --- Calculate the date of the *next* occurrence of this class ---
            const now = new Date();
            const today = now.getDay();
            let daysUntilNextClass = scheduleData.dayOfWeek - today;
            if (daysUntilNextClass < 0) {
                daysUntilNextClass += 7;
            }
            const nextClassDate = new Date(now);
            nextClassDate.setDate(now.getDate() + daysUntilNextClass);

            const [startHour, startMinute] = scheduleData.startTime.split(':').map(Number);
            const [endHour, endMinute] = scheduleData.endTime.split(':').map(Number);
            const startTime = new Date(nextClassDate);
            startTime.setHours(startHour, startMinute, 0, 0);
            const endTime = new Date(nextClassDate);
            endTime.setHours(endHour, endMinute, 0, 0);

            // --- Create Fake Bookings (up to capacity) ---
            for (let i = 0; i < savedSchedule.capacity; i++) {
                const userId = new mongoose.Types.ObjectId(); // Generate a fake ObjectId
                const newBooking = new Booking({
                    user: userId,
                    serviceType: savedSchedule.serviceType,
                    cost: 0, // Set a default cost (or calculate it)
                    details: {
                        /* ... you might want to populate this ... */
                    },
                    start: startTime,
                    end: endTime,
                    status: 'confirmed', // Or 'pending', as appropriate
                });

                const savedBooking = await newBooking.save({ session });

                // --- Create Event on Booking Calendar ---
                const bookingEvent = {
                    summary: `${savedSchedule.serviceType} Booking - ${userId}`,
                    start: { dateTime: startTime.toISOString(), timeZone: 'America/New_York' },
                    end: { dateTime: endTime.toISOString(), timeZone: 'America/New_York' },
                    description: `Booking ID: ${savedBooking._id}\nService: ${savedSchedule.serviceType}`,
                };

                const bookingCalendarResponse = await calendar.events.insert({
                    calendarId: process.env.GOOGLE_CALENDAR_ID, // Booking Calendar
                    resource: bookingEvent,
                });

                savedBooking.googleCalendarEventId = bookingCalendarResponse.data.id;
                await savedBooking.save({ session });
            }

            // --- Create Event on Display Calendar ---
            const displayEvent = {
                summary: `${scheduleData.serviceType}`,
                start: { dateTime: startTime.toISOString(), timeZone: 'America/New_York' },
                end: { dateTime: endTime.toISOString(), timeZone: 'America/New_York' },
                description: `Capacity: ${scheduleData.capacity}`,
                transparency: 'opaque', // Initially "busy" since we're filling all slots
            };

            const displayCalendarResponse = await calendar.events.insert({
                calendarId: process.env.DISPLAY_CALENDAR_ID, // Display Calendar
                resource: displayEvent,
            });

            savedSchedule.displayCalendarEventId = displayCalendarResponse.data.id;
            await savedSchedule.save({ session });
        }

        await session.commitTransaction();
        console.log('Class schedules, bookings, and Google Calendar events seeded!');
    } catch (err) {
        await session.abortTransaction();
        console.error('Error seeding data:', err);
    } finally {
        session.endSession();
        mongoose.connection.close();
    }
};

seedDB();