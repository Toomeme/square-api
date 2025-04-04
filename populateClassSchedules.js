// populateDb.js (or your preferred filename)
require('dotenv').config();
const mongoose = require('mongoose');
const ClassSchedule = require('./models/ClassSchedule');
const Booking = require('./models/Booking');
const User = require('./models/User');
// const Holiday = require('./models/Holiday'); // Include if needed for logic, though not seeded here
const connectDB = require('./config/db');
const calendar = require('./config/googleCalendar');
const { toDate, toZonedTime, format } = require('date-fns-tz'); // Use date-fns-tz

// --- Configuration ---
const businessTimeZone = 'America/New_York'; // Match your booking logic

// --- Seed Data ---
const classSchedulesData = [
    // --- Playgroup ---
    { serviceType: 'playgroup', dayOfWeek: 1, startTime: '09:30', endTime: '11:00', capacity: 10 },
    { serviceType: 'playgroup', dayOfWeek: 2, startTime: '09:30', endTime: '11:00', capacity: 10 },
    { serviceType: 'playgroup', dayOfWeek: 3, startTime: '09:30', endTime: '11:00', capacity: 10 }, //9:30-11:00
    { serviceType: 'playgroup', dayOfWeek: 4, startTime: '09:30', endTime: '11:00', capacity: 10 },
    { serviceType: 'playgroup', dayOfWeek: 5, startTime: '09:30', endTime: '11:00', capacity: 10 }, 

    // --- Open Play ---
    { serviceType: 'openplay', dayOfWeek: 1, startTime: '12:00', endTime: '17:00', capacity: 10 },
    { serviceType: 'openplay', dayOfWeek: 2, startTime: '12:00', endTime: '17:00', capacity: 10 },
    { serviceType: 'openplay', dayOfWeek: 3, startTime: '12:00', endTime: '17:00', capacity: 10 }, // Tue 12-5 PM
    { serviceType: 'openplay', dayOfWeek: 4, startTime: '12:00', endTime: '17:00', capacity: 10 }, 
    { serviceType: 'openplay', dayOfWeek: 5, startTime: '12:00', endTime: '17:00', capacity: 10 },
    { serviceType: 'openplay', dayOfWeek: 6, startTime: '09:00', endTime: '15:00', capacity: 10 },
    { serviceType: 'openplay', dayOfWeek: 7, startTime: '09:00', endTime: '15:00', capacity: 10 }, // Sat 09-03 PM

    // --- Birthday Parties ---
    { serviceType: 'birthday', dayOfWeek: 6, startTime: '11:00', endTime: '13:00', capacity: 1 },
    { serviceType: 'birthday', dayOfWeek: 6, startTime: '13:30', endTime: '15:30', capacity: 1 },
    { serviceType: 'birthday', dayOfWeek: 6, startTime: '16:00', endTime: '18:00', capacity: 1 },
    { serviceType: 'birthday', dayOfWeek: 0, startTime: '11:00', endTime: '13:00', capacity: 1 }, // Sun 11-1 PM
    { serviceType: 'birthday', dayOfWeek: 0, startTime: '13:30', endTime: '15:30', capacity: 1 },
];

const seedDB = async () => {
    try {
        console.log('Connecting to MongoDB...');
        await connectDB();
        console.log('MongoDB Connected.');

        const session = await mongoose.startSession();
        session.startTransaction();
        console.log('Transaction started.');

        try {
            console.log('Clearing existing data (ClassSchedule, Booking, User)...');
            // WARNING: Clears all users! Add environment check if necessary.
            // if (process.env.NODE_ENV !== 'production') {
                 await User.deleteMany({}).session(session);
            // } else {
            //     console.warn('Skipping User collection clearing in production.');
            // }
            await ClassSchedule.deleteMany({}).session(session);
            await Booking.deleteMany({}).session(session);
            console.log('Existing data cleared.');

            for (const scheduleData of classSchedulesData) {
                console.log(`Processing schedule: ${scheduleData.serviceType} on day ${scheduleData.dayOfWeek} at ${scheduleData.startTime}`);

                // 1. Create ClassSchedule
                const newSchedule = new ClassSchedule({
                    ...scheduleData,
                    displayCalendarEventId: null // Initialize as null
                });
                const savedSchedule = await newSchedule.save({ session });
                console.log(` > Saved ClassSchedule: ${savedSchedule._id}`);

                // 2. Calculate Date/Time for the *next* occurrence of this class
                const now = new Date();
                const zonedNow = toZonedTime(now, businessTimeZone); // Get current time in target TZ
                const todayDayInTZ = zonedNow.getDay(); // Day of week in target TZ

                let daysUntilNextClass = scheduleData.dayOfWeek - todayDayInTZ;
                if (daysUntilNextClass < 0) {
                    daysUntilNextClass += 7;
                }
                 // If the class is later today, daysUntilNextClass might be 0
                if (daysUntilNextClass === 0) {
                    const [startHour, startMinute] = scheduleData.startTime.split(':').map(Number);
                     if (zonedNow.getHours() > startHour || (zonedNow.getHours() === startHour && zonedNow.getMinutes() >= startMinute)) {
                         daysUntilNextClass = 7; // Schedule already passed today, move to next week
                     }
                }

                const nextClassDateTime = new Date(zonedNow); // Start calculation from now in TZ
                nextClassDateTime.setDate(zonedNow.getDate() + daysUntilNextClass);

                // Use date-fns-tz to get correct UTC start/end times
                const dateStr = format(nextClassDateTime, 'yyyy-MM-dd'); // Date part in target TZ
                const startString = `${dateStr}T${scheduleData.startTime}:00`; // e.g., "2024-09-16T09:00:00"
                const endString = `${dateStr}T${scheduleData.endTime}:00`;     // e.g., "2024-09-16T10:00:00"

                const zonedStartTime = toZonedTime(startString, businessTimeZone);
                const startTimeUTC = toDate(zonedStartTime); // Correct UTC Date object
                const zonedEndTime = toZonedTime(endString, businessTimeZone);
                const endTimeUTC = toDate(zonedEndTime);     // Correct UTC Date object

                console.log(` > Next Occurrence (UTC): ${startTimeUTC.toISOString()} - ${endTimeUTC.toISOString()}`);

                // 5. Create Google Calendar Event (Display Calendar - one per schedule)
                try {
                    const displayEvent = {
                        summary: `${savedSchedule.serviceType.charAt(0).toUpperCase() + savedSchedule.serviceType.slice(1)} Class (${savedSchedule.startTime}-${savedSchedule.endTime})`,
                        description: `Capacity: ${savedSchedule.capacity}\nSeed Bookings: ${bookingsCreatedThisSchedule}`,
                        // Use timeZone field for recurring events if needed, but for single instance:
                        start: { dateTime: startTimeUTC.toISOString(), timeZone: businessTimeZone },
                        end: { dateTime: endTimeUTC.toISOString(), timeZone: businessTimeZone },
                        transparency: (bookingsCreatedThisSchedule < savedSchedule.capacity) ? 'transparent' : 'opaque', // 'transparent' = Free, 'opaque' = Busy
                    };
                    const displayCalendarResponse = await calendar.events.insert({
                        calendarId: process.env.DISPLAY_CALENDAR_ID,
                        resource: displayEvent,
                    });
                    // Save display event ID back to the ClassSchedule document
                    savedSchedule.displayCalendarEventId = displayCalendarResponse.data.id;
                    await savedSchedule.save({ session });
                    console.log(` > Created GCal Display Event: ${displayCalendarResponse.data.id}`);
                } catch (gcalError) {
                    console.error(` > ERROR creating GCal Display Event for schedule ${savedSchedule._id}:`, gcalError.message);
                }

            } // End schedule loop

            console.log('Committing transaction...');
            await session.commitTransaction();
            console.log('Transaction committed successfully.');
            console.log(`Database seeded with ${classSchedulesData.length} schedules and ${totalFakeBookings} fake bookings/users.`);

        } catch (error) {
            console.error('Error during seeding transaction:', error);
            console.log('Aborting transaction...');
            await session.abortTransaction();
            console.log('Transaction aborted.');
            throw error; // Re-throw error after aborting
        } finally {
            session.endSession();
            console.log('Session ended.');
        }

    } catch (err) {
        console.error('Seeding script failed:', err);
        process.exitCode = 1; // Indicate failure
    } finally {
        console.log('Closing MongoDB connection...');
        await mongoose.connection.close();
        console.log('MongoDB connection closed.');
    }
};

// Run the seeding function
seedDB();