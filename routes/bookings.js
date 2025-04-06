// routes/bookings.js
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const calendar = require('../config/googleCalendar'); // Google Calendar API client
const Booking = require('../models/Booking');
const User = require('../models/User');
const ClassSchedule = require('../models/ClassSchedule');
const Holiday = require('../models/Holiday');
const { authMiddleware } = require('../utils/auth');
const mongoose = require('mongoose');
const dateFnsTz = require('date-fns-tz');
const { toDate, toZonedTime, format } = dateFnsTz; // Import necessary functions
const { isBefore, isEqual } = require('date-fns');

const businessTimeZone = 'America/New_York'; // Consistent TZ

// --- Placeholder Notification Functions (Replace with actual email/notification service) ---
async function sendInstallmentConfirmationEmail(userEmail, amountPaid) {
    console.log(`INFO: Sending installment confirmation email to ${userEmail} for $${(amountPaid / 100).toFixed(2)}.`);
    // Example: Use Nodemailer or SendGrid API here
    return Promise.resolve();
}
async function sendPaymentFailedEmail(userEmail) {
    console.log(`WARN: Sending payment failed email to ${userEmail}.`);
    // Example: Use Nodemailer or SendGrid API here
    return Promise.resolve();
}
async function notifyAdminOfPaymentFailure(userId, invoiceId) {
    console.error(`ALERT: Payment failed for user ${userId}, Invoice: ${invoiceId}. Admin notified.`);
    // Example: Send email/Slack message to admin
    return Promise.resolve();
}
async function notifyAdminOfSubscriptionCancellation(userId, subscriptionId) {
    console.log(`INFO: Subscription ${subscriptionId} cancelled for user ${userId}. Admin notified.`);
    // Example: Send email/Slack message to admin
    return Promise.resolve();
}
async function notifyAdminOfBookingFailure(userId, errorDetails) {
    console.error(`ALERT: Failed to create bookings for user ${userId}. Reason: ${errorDetails}. Admin notified.`);
    // Example: Send email/Slack message to admin
    return Promise.resolve();
}
// --- End Placeholder Notifications ---


// --- Helper Service Function for Creating Semester Bookings ---
async function createSemesterBookings(userId, semesterStart, semesterEnd, scheduleIds, subscriptionId) {
    console.log(`SERVICE: Creating semester bookings for user ${userId}, sub ${subscriptionId}`);
    const session = await mongoose.startSession();
    session.startTransaction();
    console.log("SERVICE: Transaction started.");

    try {
        const startDate = new Date(semesterStart);
        const endDate = new Date(semesterEnd);
        const userObjectId = new mongoose.Types.ObjectId(userId);

        // Fetch data needed
        const holidays = await Holiday.find({ date: { $gte: startDate, $lte: endDate } }).session(session).lean(); // Use lean for holidays
        const holidayDates = holidays.map(h => h.date);
        const selectedSchedules = await ClassSchedule.find({ '_id': { $in: scheduleIds } }).session(session);
        if (selectedSchedules.length !== scheduleIds.length) throw new Error('One or more selected class schedules not found.');

        const scheduleMap = selectedSchedules.reduce((map, sched) => {
            if (!map[sched.dayOfWeek]) map[sched.dayOfWeek] = [];
            map[sched.dayOfWeek].push(sched); return map;
        }, {});

        const user = await User.findById(userObjectId).session(session);
        if (!user) throw new Error(`User ${userId} not found.`);

        let daysPerWeekBitmask = 0;
        selectedSchedules.forEach(sched => { daysPerWeekBitmask |= (1 << sched.dayOfWeek); });

        const createdBookings = [];
        let currentDate = new Date(startDate);
        const today = new Date(); // For skipping past slots

        const isDaySelected = (day, mask) => ((1 << day) & mask) !== 0;
        const isHoliday = (date, holidaysArr) => {
            const checkDate = new Date(date); checkDate.setHours(0, 0, 0, 0);
            return holidaysArr.some(h => { const hd = new Date(h); hd.setHours(0, 0, 0, 0); return isEqual(hd, checkDate); }); // Use isEqual for date comparison
        };

        while (currentDate <= endDate) {
            const zonedCurrentDate = toZonedTime(currentDate, businessTimeZone);
            const dayOfWeekInTZ = zonedCurrentDate.getDay();

            if (isDaySelected(dayOfWeekInTZ, daysPerWeekBitmask) && scheduleMap[dayOfWeekInTZ]) {
                if (!isHoliday(currentDate, holidayDates)) {
                    const schedulesForThisDay = scheduleMap[dayOfWeekInTZ];
                    for (const schedule of schedulesForThisDay) {
                        const dateStr = format(zonedCurrentDate, 'yyyy-MM-dd'); // Use 'dd'
                        const startString = `${dateStr}T${schedule.startTime}:00`;
                        const endString = `${dateStr}T${schedule.endTime}:00`;
                        const zonedStartTime = toZonedTime(startString, businessTimeZone);
                        const startTimeUTC = toDate(zonedStartTime);
                        const zonedEndTime = toZonedTime(endString, businessTimeZone);
                        const endTimeUTC = toDate(zonedEndTime);

                        // Skip slots that have already passed
                        if (isBefore(startTimeUTC, today)) {
                            console.log(`SERVICE: Skipping past slot: ${startTimeUTC.toISOString()}`);
                            continue;
                        }

                        // Capacity Check
                        const existingBookingsCount = await Booking.countDocuments({
                            serviceType: 'playgroup', start: startTimeUTC, end: endTimeUTC,
                            status: { $in: ['pending', 'paid', 'confirmed'] }
                        }).session(session);

                        if (existingBookingsCount >= schedule.capacity) {
                            // Example: Log critical error and notify admin, then abort.
                            const errorMsg = `Capacity full for class on ${format(zonedStartTime, 'MMM d, yyyy HH:mm')} (UTC: ${startTimeUTC.toISOString()}). Cannot complete booking for sub ${subscriptionId}.`;
                            console.error(`CRITICAL: ${errorMsg}`);
                            await notifyAdminOfBookingFailure(userId, errorMsg); // Notify admin
                            throw new Error(`Capacity full for a required class session.`); // Abort transaction
                        }

                        // Create Booking
                        const newBooking = new Booking({
                            user: userObjectId, serviceType: 'playgroup', cost: 0,
                            details: { scheduleId: schedule._id, semesterStart, semesterEnd, subscriptionId },
                            start: startTimeUTC, end: endTimeUTC, status: 'confirmed',
                        });
                        const savedBooking = await newBooking.save({ session });
                        await User.findByIdAndUpdate(userObjectId, { $push: { classes: savedBooking._id } }).session(session);

                        // GCal Event (Main Booking Calendar)
                        try {
                            const bookingEvent = {
                                summary: `Playgroup - ${user.username || userObjectId}`,
                                description: `User ID: ${userId}\nSub ID: ${subscriptionId}\nBooking ID: ${savedBooking._id}`,
                                start: { dateTime: startTimeUTC.toISOString(), timeZone: businessTimeZone },
                                end: { dateTime: endTimeUTC.toISOString(), timeZone: businessTimeZone },
                                attendees: user.email ? [{ email: user.email }] : [],
                            };
                            const bookingCalendarResponse = await calendar.events.insert({
                                calendarId: process.env.GOOGLE_CALENDAR_ID, resource: bookingEvent, sendNotifications: false,
                            });
                            savedBooking.googleCalendarEventId = bookingCalendarResponse.data.id;
                            await savedBooking.save({ session });
                            console.log(`SERVICE: GCal Booking event created: ${bookingCalendarResponse.data.id}`);
                        } catch (gcalError) {
                            console.error(`SERVICE: WARN - Failed to create GCal Booking event for booking ${savedBooking._id}:`, gcalError.message);
                            // Continue even if GCal fails
                        }

                        // GCal Event Update (Display Calendar)
                        if (schedule.displayCalendarEventId) {
                            try {
                                const newCount = existingBookingsCount + 1;
                                const descriptionUpdate = `Capacity: ${schedule.capacity}\nBookings: ${newCount}`;
                                let patchBody = { description: descriptionUpdate };
                                // If class just became full, mark as busy
                                if (newCount === schedule.capacity) {
                                    patchBody.transparency = 'opaque';
                                    console.log(`SERVICE: Marking display event ${schedule.displayCalendarEventId} as BUSY.`);
                                }
                                await calendar.events.patch({
                                    calendarId: process.env.DISPLAY_CALENDAR_ID,
                                    eventId: schedule.displayCalendarEventId,
                                    requestBody: patchBody,
                                });
                                console.log(`SERVICE: Updated GCal Display event: ${schedule.displayCalendarEventId}`);
                            } catch (displayGcalError) {
                                console.error(`SERVICE: WARN - Failed to update GCal Display event ${schedule.displayCalendarEventId}:`, displayGcalError.message);
                            }
                        } else {
                            console.warn(`SERVICE: No displayCalendarEventId found for ClassSchedule ${schedule._id} to update.`);
                        }

                        createdBookings.push(savedBooking);
                    } // end loop schedules for day
                } else { console.log(`SERVICE: Skipping holiday ${format(currentDate, 'yyyy-MM-dd')}`); }
            } // end if day selected
            currentDate.setDate(currentDate.getDate() + 1);
        } // end while loop semester

        await session.commitTransaction();
        console.log(`SERVICE: Transaction committed. ${createdBookings.length} bookings created for sub ${subscriptionId}.`);
        return createdBookings;

    } catch (err) {
        console.error(`SERVICE: Error creating semester bookings for sub ${subscriptionId}:`, err);
        if (session.inTransaction()) { await session.abortTransaction(); console.log("SERVICE: Transaction aborted."); }
        throw err; // Re-throw
    } finally {
        if (session && session.endSession) { session.endSession(); console.log("SERVICE: Session ended."); }
    }
}

// --- *** NEW Service Function for Creating Semester Bookings (One-Time Payment) *** ---
async function createSemesterBookingsOneTime(userId, semesterStart, semesterEnd, scheduleIds, paymentIntentId) {
    console.log(`SERVICE: Creating semester bookings (One-Time) for user ${userId}, PI: ${paymentIntentId}`);

    console.log(`SERVICE PARAMS: Start=${semesterStart}, End=${semesterEnd}, Schedules=${JSON.stringify(scheduleIds)}`); // Log inputs
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const startDate = new Date(semesterStart);
        const endDate = new Date(semesterEnd);
        console.log(`SERVICE DATES: Start=${startDate.toISOString()}, End=${endDate.toISOString()}`); // Log parsed dates
        const userObjectId = new mongoose.Types.ObjectId(userId);

        // Fetch data (schedules, user, holidays)
        const holidays = await Holiday.find({ date: { $gte: startDate, $lte: endDate } }).session(session).lean();
        const holidayDates = holidays.map(h => h.date);
        console.log(`SERVICE: Found ${holidayDates.length} holidays in range.`);
        const selectedSchedules = await ClassSchedule.find({ '_id': { $in: scheduleIds } }).session(session);
        if (selectedSchedules.length !== scheduleIds.length) throw new Error('Schedules not found.');
        console.log(`SERVICE: Found ${selectedSchedules.length} matching schedule documents.`);
        const scheduleMap = selectedSchedules.reduce((map, sched) => { if (!map[sched.dayOfWeek]) map[sched.dayOfWeek] = []; map[sched.dayOfWeek].push(sched); return map; }, {});
        console.log("SERVICE: Schedule Map by DayOfWeek:", Object.keys(scheduleMap)); // See which days have schedules
        const user = await User.findById(userObjectId).session(session);
        if (!user) throw new Error(`User ${userId} not found.`);

        let daysPerWeekBitmask = 0;
        selectedSchedules.forEach(sched => { daysPerWeekBitmask |= (1 << sched.dayOfWeek); });
        console.log(`SERVICE: Calculated Bitmask: ${daysPerWeekBitmask}`);

        const createdBookings = [];
        let currentDate = new Date(startDate);
        const today = new Date();
        const isDaySelected = (day, mask) => ((1 << day) & mask) !== 0;
        const isHoliday = (date, holidaysArr) => { const cd = new Date(date); cd.setHours(0, 0, 0, 0); return holidaysArr.some(h => { const hd = new Date(h); hd.setHours(0, 0, 0, 0); return isEqual(hd, cd); }); };

        let iterationCount = 0; // Add iteration counter

        // --- Main Loop ---
        while (currentDate <= endDate) {
            iterationCount++;
            const currentDateStrForLog = format(currentDate, 'yyyy-MM-dd'); // For logging
            console.log(`\nSERVICE LOOP ${iterationCount}: Checking ${currentDateStrForLog}`);

            const zonedCurrentDate = toZonedTime(currentDate, businessTimeZone);
            const dayOfWeekInTZ = zonedCurrentDate.getDay();
            console.log(`SERVICE LOOP: DayOfWeekInTZ=${dayOfWeekInTZ}`);

            // Check 1: Is Day Selected?
            const dayIsSelected = isDaySelected(dayOfWeekInTZ, daysPerWeekBitmask);
            console.log(`SERVICE LOOP: isDaySelected? ${dayIsSelected}`);

            // Check 2: Is there a schedule defined for this day?
            const scheduleExistsForDay = !!scheduleMap[dayOfWeekInTZ];
            console.log(`SERVICE LOOP: scheduleExistsForDay? ${scheduleExistsForDay}`);


            if (dayIsSelected && scheduleExistsForDay) {
                // Check 3: Is it a holiday?
                const holidayCheck = isHoliday(currentDate, holidayDates);
                console.log(`SERVICE LOOP: isHoliday? ${holidayCheck}`);

                if (!holidayCheck) {
                    const schedulesForThisDay = scheduleMap[dayOfWeekInTZ];
                    console.log(`SERVICE LOOP: Found ${schedulesForThisDay.length} schedule(s) for this valid day.`);
                    for (const schedule of schedulesForThisDay) {
                        // Check 4: Calculate Times
                        const dateStr = format(zonedCurrentDate, 'yyyy-MM-dd');
                        const startString = `${dateStr}T${schedule.startTime}:00`;
                        const endString = `${dateStr}T${schedule.endTime}:00`;
                        const zonedStartTime = toZonedTime(startString, businessTimeZone);
                        const startTimeUTC = toDate(zonedStartTime);
                        const zonedEndTime = toZonedTime(endString, businessTimeZone);
                        const endTimeUTC = toDate(zonedEndTime);
                        console.log(`SERVICE LOOP: Slot Times UTC: ${startTimeUTC.toISOString()} - ${endTimeUTC.toISOString()}`);

                        // Check 5: Is it in the past?
                        const isSlotPast = isBefore(startTimeUTC, today);
                        console.log(`SERVICE LOOP: isSlotPast? ${isSlotPast}`);
                        if (isSlotPast) continue;

                        // Check 6: Capacity Check
                        const bookingQuery = { serviceType: 'playgroup', start: startTimeUTC, end: endTimeUTC, status: { $in: ['pending', 'paid', 'confirmed'] } };
                        console.log(`SERVICE LOOP: Capacity Query: ${JSON.stringify(bookingQuery)}`);
                        const existingBookingsCount = await Booking.countDocuments(bookingQuery).session(session);
                        console.log(`SERVICE LOOP: Existing Bookings=${existingBookingsCount}, Capacity=${schedule.capacity}`);
                        if (existingBookingsCount >= schedule.capacity) {
                            console.error(`SERVICE LOOP: FAIL - Capacity full for ${startTimeUTC.toISOString()}`);
                            // Decide how to handle capacity failure here. For webhook, often best to abort.
                            throw new Error(`Capacity full for a required class session.`);
                        } else {
                            console.log(`SERVICE LOOP: Capacity OK.`);
                        }

                        // --- If all checks pass, create booking ---
                        console.log(`SERVICE LOOP: *** CREATING BOOKING *** for ${startTimeUTC.toISOString()}`);
                        console.log("SERVICE LOOP: Preparing to create booking. Values:");
                        console.log(`  > userObjectId: ${userObjectId} (Type: ${typeof userObjectId})`);
                        console.log(`  > serviceType: 'playgroup'`);
                        console.log(`  > cost: 0`);
                        console.log(`  > details.scheduleId: ${schedule?._id}`); // Use optional chaining
                        console.log(`  > details.semesterStart: ${semesterStart}`);
                        console.log(`  > details.semesterEnd: ${semesterEnd}`);
                        console.log(`  > details.paymentIntentId: ${paymentIntentId}`);
                        console.log(`  > start: ${startTimeUTC} (ISO: ${startTimeUTC?.toISOString()})`); // Use optional chaining
                        console.log(`  > end: ${endTimeUTC} (ISO: ${endTimeUTC?.toISOString()})`); // Use optional chaining
                        console.log(`  > status: 'paid'`);
                        console.log(`  > paymentIntentId (field): ${paymentIntentId}`);
                        const newBooking = new Booking({
                            user: userObjectId,
                            serviceType: 'playgroup',
                            cost: 0,
                            details: {
                                scheduleId: schedule._id, // Ensure schedule and _id exist
                                semesterStart: semesterStart,
                                semesterEnd: semesterEnd,
                                paymentIntentId: paymentIntentId
                            },
                            start: startTimeUTC,
                            end: endTimeUTC,
                            status: 'paid',
                            paymentIntentId: paymentIntentId
                        });
                        const savedBooking = await newBooking.save({ session });

                        await User.findByIdAndUpdate(userObjectId, { $push: { classes: savedBooking._id } }).session(session);
                        createdBookings.push(savedBooking);
                        console.log(`SERVICE LOOP: Booking ${savedBooking._id} created.`);

                        // GCal Events (Optional, keep logging minimal unless debugging GCal)
                        try { /* ... GCal Main ... */ console.log(`SERVICE LOOP: GCal Main attempt.`); } catch (e) { console.error("WARN: GCal main failed", e.message) }
                        if (schedule.displayCalendarEventId) { try { /* ... GCal Display Update ... */ console.log(`SERVICE LOOP: GCal Display attempt.`); } catch (e) { console.error("WARN: GCal display failed", e.message) } }

                    } // End inner schedule loop
                } else {
                    console.log(`SERVICE LOOP: Skipped - Holiday`);
                }
            } else {
                console.log(`SERVICE LOOP: Skipped - Day not selected or no schedule found for this day.`);
            }
            currentDate.setDate(currentDate.getDate() + 1); // Move to next day
        } // End while loop semester

        console.log(`SERVICE: Loop finished after ${iterationCount} iterations.`);
        if (createdBookings.length === 0) {
            console.warn("SERVICE: WARNING - Loop completed, but no bookings were created. Check loop conditions and dates.");
        }

        await session.commitTransaction();
        console.log(`SERVICE: Transaction committed (One-Time). ${createdBookings.length} bookings created for PI ${paymentIntentId}.`);
        return createdBookings;
    } catch (err) {
        console.error(`SERVICE: Error creating semester bookings (One-Time) for PI ${paymentIntentId}:`, err);
        if (session.inTransaction()) await session.abortTransaction();
        throw err; // Re-throw
    } finally {
        if (session && session.endSession) session.endSession();
    }
}

async function createSlotBooking(userId, slotStart, slotEnd, serviceType, paymentIntentId, metadata = {}) {
    console.log(`SERVICE: Creating slot booking (${serviceType}) for user ${userId}, PI: ${paymentIntentId}`);
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const userObjectId = new mongoose.Types.ObjectId(userId);
        const startTime = new Date(slotStart);
        const endTime = new Date(slotEnd);

        // Find ClassSchedule
        const zonedStartTime = toZonedTime(startTime, businessTimeZone);
        const dayOfWeekInTZ = zonedStartTime.getDay();
        const startTimeString = format(zonedStartTime, 'HH:mm');
        const zonedEndTime = toZonedTime(endTime, businessTimeZone);
        const endTimeString = format(zonedEndTime, 'HH:mm');
        const classSchedule = await ClassSchedule.findOne({
            serviceType, dayOfWeek: dayOfWeekInTZ, startTime: startTimeString, endTime: endTimeString,
        }).session(session);
        if (!classSchedule) throw new Error('Invalid booking slot: No class scheduled.');

        // Capacity Check
        const existingBookingsCount = await Booking.countDocuments({
            serviceType, start: startTime, end: endTime, status: { $in: ['pending', 'paid', 'confirmed'] }
        }).session(session);
        if (existingBookingsCount >= classSchedule.capacity) throw new Error('Booking failed: This time slot is now full.');

        // Create Booking
        const newBooking = new Booking({
            user: userObjectId, serviceType, cost: metadata.calculatedAmount ? metadata.calculatedAmount / 100 : 0, // Get cost from metadata if available
            details: { ...metadata, scheduleId: classSchedule._id, paymentIntentId }, // Store metadata and PI
            start: startTime, end: endTime, status: 'paid', paymentIntentId
        });
        const savedBooking = await newBooking.save({ session });
        await User.findByIdAndUpdate(userObjectId, { $push: { classes: savedBooking._id } }).session(session);

        // GCal Events (Main & Display Update)
        try { /* ... GCal Main ... */ } catch (e) { console.error("WARN: GCal main failed", e.message) }
        if (classSchedule.displayCalendarEventId) { try { /* ... GCal Display Update ... */ } catch (e) { console.error("WARN: GCal display failed", e.message) } }

        await session.commitTransaction();
        console.log(`SERVICE: Transaction committed. Slot booking ${savedBooking._id} created for PI ${paymentIntentId}.`);
        return savedBooking;
    } catch (err) {
        console.error(`SERVICE: Error creating slot booking for PI ${paymentIntentId}:`, err);
        if (session.inTransaction()) await session.abortTransaction();
        throw err; // Re-throw
    } finally {
        if (session && session.endSession) session.endSession();
    }
}

// --- *** NEW Service Function for Updating User Purchase (Membership/Punchcard) *** ---
async function updateUserPurchase(userId, openPlayOption, paymentIntentId, metadata = {}) {
    console.log(`SERVICE: Updating user purchase (${openPlayOption}) for user ${userId}, PI: ${paymentIntentId}`);
    try {
        let updateUser = {}; let successMessage = '';
        if (openPlayOption === 'membership') {
            const expiry = new Date(); expiry.setMonth(expiry.getMonth() + 1);
            updateUser = { membershipExpiry: expiry }; successMessage = `Membership activated.`;
        } else if (openPlayOption === 'punchcard') {
            updateUser = { $inc: { openPlayPunches: 10 } }; successMessage = `10 punches added.`;
        } else { throw new Error(`Invalid purchase option: ${openPlayOption}`); }

        const updatedUser = await User.findByIdAndUpdate(userId, updateUser, { new: true });
        if (!updatedUser) throw new Error(`User ${userId} not found for update.`);

        // Create Purchase Record
        const purchaseRecord = new Booking({
            user: userId, serviceType: 'openplay', cost: metadata.calculatedAmount ? metadata.calculatedAmount / 100 : 0,
            details: { ...metadata, option: openPlayOption, paymentIntentId },
            start: new Date(), end: new Date(), status: 'paid', paymentIntentId
        });
        await purchaseRecord.save();
        console.log(`SERVICE: Purchase record ${purchaseRecord._id} created for ${openPlayOption}, PI ${paymentIntentId}.`);
        return { updatedUser, purchaseRecord };
    } catch (err) {
        console.error(`SERVICE: Error processing ${openPlayOption} for PI ${paymentIntentId}:`, err);
        await notifyAdminOfBookingFailure(userId, `Failed ${openPlayOption} update after PI ${paymentIntentId}: ${err.message}`);
        throw err; // Re-throw
    }
}
// --- End Service Function ---


// --- GET Available Slots (Single Date) ---
router.get('/available-slots', async (req, res) => {
    console.log("--- AVAILABLE SLOTS HANDLER START ---");
    const { serviceType, date } = req.query;
    if (!serviceType || !date) { return res.status(400).json({ message: 'serviceType and date query parameters are required.' }); }
    try {
        const dateStringWithTime = `${date}T00:00:00`;
        const zonedStartOfDay = toZonedTime(dateStringWithTime, businessTimeZone);
        const requestedDateStartOfDayUTC = toDate(zonedStartOfDay);

        const holiday = await Holiday.findOne({ date: requestedDateStartOfDayUTC });
        if (holiday) { console.log("Skipping holiday:", date); return res.json([]); }

        const dayOfWeekInTZ = zonedStartOfDay.getDay();
        const classSchedules = await ClassSchedule.find({ serviceType: serviceType, dayOfWeek: dayOfWeekInTZ });
        if (!classSchedules || classSchedules.length === 0) { return res.json([]); }

        const availableSlots = [];
        const today = new Date();
        for (const schedule of classSchedules) {
            const startString = `${date}T${schedule.startTime}:00`;
            const endString = `${date}T${schedule.endTime}:00`;
            const zonedStartTime = toZonedTime(startString, businessTimeZone);
            const startTimeUTC = toDate(zonedStartTime);
            const zonedEndTime = toZonedTime(endString, businessTimeZone);
            const endTimeUTC = toDate(zonedEndTime);

            if (isBefore(startTimeUTC, today)) continue; // Skip past slots

            const existingBookingsCount = await Booking.countDocuments({
                serviceType: serviceType, start: startTimeUTC, end: endTimeUTC,
                status: { $in: ['pending', 'paid', 'confirmed'] }
            });

            if (existingBookingsCount < schedule.capacity) {
                let isBusyGcal = false;
                // GCal Check (optional)
                try {
                    const response = await calendar.freebusy.query({ /* ... */ });
                    // ... parse response ... isBusyGcal = ...
                } catch (gcalError) { console.error("WARN: GCal freebusy check failed:", gcalError.message); }

                if (!isBusyGcal) {
                    availableSlots.push({ start: startTimeUTC.toISOString(), end: endTimeUTC.toISOString() });
                }
            }
        }
        res.json(availableSlots);
    } catch (err) {
        console.error("Error in /available-slots:", err);
        res.status(500).json({ message: 'Error fetching available slots' });
    }
});

// --- GET Available Slots for a Date Range ---
router.get('/available-slots-range', async (req, res) => {
    console.log("--- AVAILABLE SLOTS RANGE HANDLER START ---");
    const { serviceType } = req.query;
    const numberOfDays = parseInt(req.query.days || '7', 10);

    // --- Validation ---
    if (!serviceType || (serviceType !== 'openplay' && serviceType !== 'birthday')) { /* ... bad request ... */ }
    if (isNaN(numberOfDays) || numberOfDays <= 0 || numberOfDays > 30) { /* ... bad request ... */ }

    const results = {};
    const today = new Date();
    const startDate = toZonedTime(today, businessTimeZone);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + numberOfDays - 1);
    console.log(`Fetching range for ${serviceType} from ${format(startDate, 'yyyy-MM-dd')} to ${format(endDate, 'yyyy-MM-dd')}`);

    try {
        // Fetch holidays for the range
        const rangeStartUTC = toDate(format(startDate, 'yyyy-MM-dd') + 'T00:00:00', { timeZone: businessTimeZone });
        const rangeEndUTC = toDate(format(endDate, 'yyyy-MM-dd') + 'T23:59:59', { timeZone: businessTimeZone });
        const holidays = await Holiday.find({ date: { $gte: rangeStartUTC, $lte: rangeEndUTC } }).lean();
        const holidayDates = holidays.map(h => h.date); // Keep as Date objects for isHoliday helper

        let currentDate = new Date(startDate); // Loop variable needs to be standard Date

        // --- Loop Helpers ---
        const isHolidayInRange = (date, holidaysArr) => {
            const checkDate = new Date(date); checkDate.setHours(0, 0, 0, 0);
            return holidaysArr.some(h => { const hd = new Date(h); hd.setHours(0, 0, 0, 0); return isEqual(hd, checkDate); });
        };
        // --- End Loop Helpers ---

        while (currentDate <= endDate) {
            const currentDateZoned = toZonedTime(currentDate, businessTimeZone); // Convert inside loop for dayOfWeek check
            const currentDateStr = format(currentDateZoned, 'yyyy-MM-dd'); // Format for key
            console.log(`Checking date: ${currentDateStr}`);
            results[currentDateStr] = [];

            // Check holiday using Date object
            if (isHolidayInRange(currentDate, holidayDates)) {
                console.log(` > ${currentDateStr} is a holiday. Skipping.`);
                currentDate.setDate(currentDate.getDate() + 1);
                continue;
            }

            const dayOfWeekInTZ = currentDateZoned.getDay();
            const classSchedules = await ClassSchedule.find({ serviceType: serviceType, dayOfWeek: dayOfWeekInTZ });

            if (!classSchedules || classSchedules.length === 0) { /* ... continue loop ... */ }

            for (const schedule of classSchedules) {
                const startString = `${currentDateStr}T${schedule.startTime}:00`;
                const endString = `${currentDateStr}T${schedule.endTime}:00`;
                const zonedStartTime = toZonedTime(startString, businessTimeZone);
                const startTimeUTC = toDate(zonedStartTime);
                const zonedEndTime = toZonedTime(endString, businessTimeZone);
                const endTimeUTC = toDate(zonedEndTime);

                if (isBefore(startTimeUTC, today)) continue; // Skip past slots

                const existingBookingsCount = await Booking.countDocuments({ /* ... */ });

                if (existingBookingsCount < schedule.capacity) {
                    let isBusyGcal = false;
                    // GCal Check (optional)
                    try { /* ... GCal freebusy query ... */ } catch (gcalError) { console.error("WARN: GCal range check failed:", gcalError.message); }

                    if (!isBusyGcal) {
                        results[currentDateStr].push({ start: startTimeUTC.toISOString(), end: endTimeUTC.toISOString() });
                    }
                }
            } // End schedule loop
            currentDate.setDate(currentDate.getDate() + 1); // Increment standard Date object
        } // End date range loop

        console.log("--- AVAILABLE SLOTS RANGE HANDLER END ---");
        res.json(results);
    } catch (err) {
        console.error("Error in /available-slots-range:", err);
        res.status(500).json({ message: 'Error fetching available slots range' });
    }
});

// Add to routes/bookings.js

// GET /api/bookings/by-session/:sessionId
router.get('/by-session/:sessionId', authMiddleware, async (req, res) => {
    const { sessionId } = req.params;
    const userId = req.user._id; // From logged-in user token

    if (!sessionId || !sessionId.startsWith('cs_')) {
        return res.status(400).json({ message: 'Invalid Session ID format.' });
    }
    console.log(`--- GET BOOKING BY SESSION ${sessionId} for User ${userId} ---`);

    try {
        // 1. Retrieve Checkout Session from Stripe
        // Expand payment_intent or subscription for easier access
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
            expand: ['payment_intent', 'subscription'],
        });

        // Security Check: Ensure this session belongs to the logged-in user
        // Check against metadata OR retrieve customer and check metadata there
        if (session.metadata?.appUserId !== userId.toString()) {
             // If checking customer: const customer = await stripe.customers.retrieve(session.customer); if(customer.metadata?.appUserId !== userId.toString()) ...
             console.warn(`Security Alert: User ${userId} attempting to access session ${sessionId} belonging to ${session.metadata?.appUserId}`);
             return res.status(403).json({ message: 'Forbidden: Cannot access this session.' });
        }

        // 2. Determine how to find the bookings based on session mode/metadata
        let bookings = [];
        const referenceId = session.mode === 'subscription' ? session.subscription?.id : session.payment_intent?.id; // Use expanded object IDs
        const referenceType = session.mode === 'subscription' ? 'details.subscriptionId' : 'paymentIntentId';
        const bookingType = session.metadata?.bookingType;

        console.log(` > Session Mode: ${session.mode}, Ref Type: ${referenceType}, Ref ID: ${referenceId}, Booking Type: ${bookingType}`);

        if (!referenceId) {
            console.warn(` > No Payment Intent or Subscription ID found on session ${sessionId}. Cannot reliably find bookings yet.`);
            // Return pending status or empty array? Depends on desired UX.
            // Could also try finding based on user ID + recent timestamp + metadata, but less reliable.
             return res.status(202).json({ status: 'pending', message: 'Booking details are processing.' }); // 202 Accepted - processing
        }

         // --- Idempotency Check --- Add logging inside the functions
         console.log(`Checking idempotency for ${referenceType} = ${referenceId}`);
         const existingRecord = await Booking.findOne({ [referenceType]: referenceId });
         if (existingRecord) {
             console.log(`WH: Idempotency check PASSED - Record already exists for ${referenceId}. Skipping.`);
            
         } else {
            return res.status(202).json({ status: 'pending', message: 'Booking details are processing.' }); // 202 Accepted - processing
        }

        // 3. Query Your Database for Bookings
        // Query using the reference ID and ensure it belongs to the correct user
        bookings = await Booking.find({
            user: userId,
            [referenceType]: referenceId // Find by PI or Sub ID stored in the booking
        })
        .sort({ start: 1 })
        .select('serviceType start end details cost') // Adjust fields as needed
        .limit(150) // Limit for semester bookings
        .lean();


        if (bookings.length === 0) {
            // This might happen if the webhook hasn't finished processing yet.
            console.warn(` > No bookings found for user ${userId} with ${referenceType} ${referenceId}. Webhook might be delayed.`);
             // Return a specific status indicating processing might still be ongoing
             return res.status(202).json({ status: 'pending', message: 'Booking details are processing. Please check back shortly.' });
        }

        console.log(` > Found ${bookings.length} booking(s) for session ${sessionId}`);

        // 4. Return Booking Details
        res.json({
            status: 'success',
            bookingType: bookingType, // Pass booking type for context
            bookings: bookings // Array of booking objects
        });

    } catch (error) {
        console.error(`Error fetching booking by session ${sessionId}:`, error);
        // Handle Stripe errors specifically (e.g., session not found)
        if (error.type === 'StripeInvalidRequestError' && error.code === 'resource_missing') {
             return res.status(404).json({ message: 'Checkout session not found.' });
        }
        res.status(500).json({ message: 'Error retrieving booking details.' });
    }
});

// --- DELETE Booking ---
router.delete('/:id', authMiddleware, async (req, res) => {
    console.log(`--- DELETE BOOKING ${req.params.id} ---`);
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const booking = await Booking.findById(req.params.id).session(session);
        if (!booking) { await session.abortTransaction(); return res.status(404).json({ message: 'Booking not found' }); }
        if (booking.user.toString() !== req.user._id) { await session.abortTransaction(); return res.status(403).json({ message: 'Unauthorized' }); }

        // Check if booking is in the past - maybe prevent deletion?
        if (isBefore(new Date(booking.start), new Date())) {
            console.warn(`Attempt to delete past booking ${booking._id}`);
            // Decide business logic: allow or deny? For now, allow but log.
            // await session.abortTransaction();
            // return res.status(400).json({ message: 'Cannot delete past bookings.' });
        }


        // --- GCal (Main) Deletion ---
        if (booking.googleCalendarEventId) {
            try {
                await calendar.events.delete({
                    calendarId: process.env.GOOGLE_CALENDAR_ID,
                    eventId: booking.googleCalendarEventId,
                });
                console.log("Deleted GCal main event:", booking.googleCalendarEventId);
            } catch (gcalErr) {
                // Ignore "Not Found" errors, log others
                if (gcalErr.code !== 404) {
                    console.error("WARN: Failed to delete GCal main event:", gcalErr.message);
                } else {
                    console.log("Gcal main event already deleted or never existed.");
                }
            }
        }

        // --- GCal (Display) Update ---
        // Find relevant ClassSchedule to update display event
        const zonedStartTime = toZonedTime(new Date(booking.start), businessTimeZone);
        const dayOfWeekInTZ = zonedStartTime.getDay();
        const startTimeString = format(zonedStartTime, 'HH:mm');
        const zonedEndTime = toZonedTime(new Date(booking.end), businessTimeZone);
        const endTimeString = format(zonedEndTime, 'HH:mm');

        const classSchedule = await ClassSchedule.findOne({
            serviceType: booking.serviceType, dayOfWeek: dayOfWeekInTZ,
            startTime: startTimeString, endTime: endTimeString,
        }).session(session).lean(); // Lean for read-only

        if (classSchedule && classSchedule.displayCalendarEventId) {
            // Count bookings *after* this one is removed
            const remainingBookingsCount = await Booking.countDocuments({
                _id: { $ne: booking._id }, // Exclude current booking
                serviceType: booking.serviceType, start: booking.start, end: booking.end,
                status: { $in: ['pending', 'paid', 'confirmed'] }
            }).session(session);

            try {
                let patchBody = { description: `Capacity: ${classSchedule.capacity}\nBookings: ${remainingBookingsCount}` };
                // If class WAS full and now isn't
                if (remainingBookingsCount === classSchedule.capacity - 1) {
                    patchBody.transparency = 'transparent'; // Mark as free again
                    console.log(`Marking display event ${classSchedule.displayCalendarEventId} as FREE again.`);
                }
                await calendar.events.patch({
                    calendarId: process.env.DISPLAY_CALENDAR_ID,
                    eventId: classSchedule.displayCalendarEventId,
                    requestBody: patchBody,
                });
                console.log(`Updated GCal Display event ${classSchedule.displayCalendarEventId} count to ${remainingBookingsCount}.`);
            } catch (displayErr) {
                console.error("WARN: Failed to update GCal Display event:", displayErr.message);
            }
        }

        // --- Database Update (Soft Delete) ---
        booking.status = 'cancelled';
        booking.googleCalendarEventId = null; // Remove link
        await booking.save({ session });
        console.log("Booking marked as cancelled:", booking._id);

        // Remove from user's list
        await User.findByIdAndUpdate(booking.user, { $pull: { classes: booking._id } }).session(session);

        await session.commitTransaction();
        res.json({ message: 'Booking cancelled successfully' });

    } catch (err) {
        console.error('Error cancelling booking:', err);
        if (session.inTransaction()) await session.abortTransaction();
        res.status(err.status || 500).json({ message: err.message || 'Error cancelling booking' });
    } finally {
        if (session && session.endSession) session.endSession();
    }
});


// --- Stripe Webhook Endpoint (Primary Fulfillment Logic) ---
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret); }
    catch (err) { console.error('Webhook signature verification failed.', err.message); return res.status(400).send(`Webhook Error: ${err.message}`); }

    console.log(`\n--- WEBHOOK RECEIVED --- Type: ${event.type}, ID: ${event.id}`);

    // Wrapper for async handlers
    const handleEvent = async (eventType, data) => {
        try {
            switch (eventType) {
                case 'checkout.session.completed':
                    const session = data.object;
                    console.log(`WH: Processing checkout.session.completed - Session ID: ${session.id}, Mode: ${session.mode}, Payment Status: ${session.payment_status}`);
                    console.log(`WH: Metadata: ${JSON.stringify(session.metadata, null, 2)}`);

                    // Only fulfill if payment is successful or subscription setup is complete
                    if (session.payment_status === 'paid' || (session.mode === 'subscription' && session.status === 'complete')) {
                        const { appUserId, bookingType, serviceType, ...otherMetadata } = session.metadata || {};
                        if (!appUserId || !bookingType) { console.error(`WH CRITICAL: Missing appUserId or bookingType in metadata for session ${session.id}. Cannot fulfill.`); break; }

                        const referenceId = session.mode === 'subscription' ? session.subscription : session.payment_intent;
                        const referenceType = session.mode === 'subscription' ? 'details.subscriptionId' : 'paymentIntentId';
                        if (!referenceId) { console.error(`WH CRITICAL: Missing reference ID (Sub or PI) on session ${session.id}. Cannot fulfill.`); break; }
                        console.log(`WH: Reference Type='${referenceType}', Reference ID='${referenceId}'`);

                        // --- Idempotency Check ---
                        console.log(`WH: Checking idempotency for ${referenceType} = ${referenceId}`);
                        const existingRecord = await Booking.findOne({ [referenceType]: referenceId });
                        if (existingRecord) { console.log(`WH: Idempotency check PASSED - Booking record already exists for ${referenceId}. Skipping.`); break; }
                        // Also check User flag for subscriptions
                        if (session.mode === 'subscription') {
                            const userCheck = await User.findOne({ _id: appUserId, stripeSubscriptionId: session.subscription });
                            if (userCheck && userCheck.playgroupBookingsCreatedForSub === session.subscription) {
                                console.log(`WH: Idempotency check PASSED - User flag already set for sub ${session.subscription}. Skipping.`);
                                break;
                            }
                            if (userCheck && userCheck.playgroupInstallmentsRemaining === undefined) {
                                // User exists with sub ID but installment setup wasn't completed? Log warning.
                                console.warn(`WH: User ${appUserId} has sub ID ${session.subscription} but installment details seem missing. Attempting setup again.`);
                            }
                        }
                        console.log(`WH: Idempotency check OK - Proceeding with fulfillment.`);


                        console.log(`WH: Routing fulfillment for bookingType: ${bookingType}`);
                        // --- Route Fulfillment ---
                        try { // Wrap specific fulfillment
                            if (bookingType === 'playgroup_installment') {
                                const subscriptionId = session.subscription; const customerId = session.customer;
                                if (!subscriptionId) throw new Error("Missing subscription ID.");

                                // --- Get Installment Details from METADATA ---
                                const numInstallments = parseInt(otherMetadata.numInstallments, 10);
                                const baseInstallmentAmount = parseInt(otherMetadata.installmentAmount, 10); // Base amount from metadata
                                const totalSemesterCost = parseInt(otherMetadata.totalSemesterCost, 10);
                                // const firstInstallmentAmount = parseInt(otherMetadata.firstInstallmentAmount, 10); // Also available if needed

                                if (isNaN(numInstallments) || isNaN(baseInstallmentAmount) || isNaN(totalSemesterCost)) {
                                    throw new Error("Invalid installment details found in session metadata.");
                                }
                                console.log(`WH: Using Metadata - NumInst=${numInstallments}, BaseInst=${baseInstallmentAmount}, TotalCost=${totalSemesterCost}`);
                                console.log(`WH: Updating user ${appUserId} with sub ${subscriptionId} and installment details...`);
                                await User.findByIdAndUpdate(appUserId, {
                                    stripeSubscriptionId: subscriptionId,
                                    stripeCustomerId: customerId,
                                    playgroupInstallmentAmount: baseInstallmentAmount, // Store BASE amount
                                    playgroupInstallmentsRemaining: numInstallments,   // Store TOTAL count initially
                                    playgroupEnrollmentSemester: otherMetadata.semesterKey || `${otherMetadata.semesterStart}_${otherMetadata.semesterEnd}`,
                                    playgroupBookingsCreatedForSub: null,
                                    playgroupTotalSemesterCost: totalSemesterCost,     // Store total cost
                                    playgroupTotalInstallments: numInstallments,        // Store total count
                                }, { new: true }); // Ensure update completes before proceeding

                                // 2. Attempt to Create Bookings NOW
                                console.log("WH: Triggering createSemesterBookings service NOW...");
                                const createdBookings = await createSemesterBookings(
                                    appUserId,
                                    otherMetadata.semesterStart,
                                    otherMetadata.semesterEnd,
                                    JSON.parse(otherMetadata.scheduleIds || '[]'),
                                    subscriptionId
                                );

                                // 3. Mark Bookings as Created on User (if successful)
                                await User.findByIdAndUpdate(appUserId, { playgroupBookingsCreatedForSub: subscriptionId });
                                console.log(`WH: Successfully created ${createdBookings.length} bookings and updated user flag for sub ${subscriptionId}`);

                            } else if (bookingType === 'playgroup_full') {
                                const paymentIntentId = session.payment_intent; if (!paymentIntentId) throw new Error("Missing PI for full playgroup.");
                                console.log(`WH: Calling createSemesterBookingsOneTime for PI ${paymentIntentId}...`);
                                await createSemesterBookingsOneTime(appUserId, otherMetadata.semesterStart, otherMetadata.semesterEnd, JSON.parse(otherMetadata.scheduleIds || '[]'), paymentIntentId);

                            } else if (bookingType === 'openplay_dropin' || bookingType === 'birthday') {
                                const paymentIntentId = session.payment_intent; if (!paymentIntentId) throw new Error(`Missing PI for ${bookingType}.`);
                                if (!otherMetadata.slotStart || !otherMetadata.slotEnd) throw new Error(`Missing slot data for ${bookingType}.`);
                                console.log(`WH: Calling createSlotBooking for PI ${paymentIntentId}...`);
                                await createSlotBooking(appUserId, otherMetadata.slotStart, otherMetadata.slotEnd, serviceType, paymentIntentId, otherMetadata);

                            } else if (bookingType === 'openplay_purchase') {
                                const paymentIntentId = session.payment_intent; if (!paymentIntentId) throw new Error("Missing PI for openplay_purchase.");
                                if (!otherMetadata.openPlayOption) throw new Error("Missing openPlayOption.");
                                console.log(`WH: Calling updateUserPurchase for PI ${paymentIntentId}...`);
                                await updateUserPurchase(appUserId, otherMetadata.openPlayOption, paymentIntentId, otherMetadata);

                            } else { console.warn(`WH: Unhandled bookingType: ${bookingType}`); }

                            console.log(`WH: Successfully completed fulfillment logic for ${bookingType} / session ${session.id}`);

                        } catch (fulfillmentError) { // Catch errors from the service functions
                            console.error(`WH CRITICAL: Fulfillment failed for session ${session.id} (bookingType: ${bookingType}):`, fulfillmentError);
                            await notifyAdminOfBookingFailure(appUserId, `Webhook fulfillment failed for ${bookingType} / session ${session.id}: ${fulfillmentError.message}`);

                            // --- Attempt to Cancel Subscription if Booking Failed ---
                            if (bookingType === 'playgroup_installment' && session.subscription) {
                                console.warn(`WH: Attempting to cancel subscription ${session.subscription} due to booking failure...`);
                                try {
                                    await stripe.subscriptions.cancel(session.subscription);
                                    console.log(`WH: Successfully cancelled subscription ${session.subscription}.`);
                                } catch (cancelError) {
                                    console.error(`WH: CRITICAL - Failed to cancel subscription ${session.subscription}:`, cancelError);
                                    await notifyAdminOfBookingFailure(appUserId, `FAILED TO AUTO-CANCEL sub ${session.subscription}`);
                                }
                            }
                            // *** IMPORTANT: Re-throw the error so the OUTER catch handles the response ***
                            throw fulfillmentError;
                            // return res.status(200).json({ received: true, error: `Internal fulfillment error.` }); // REMOVE THIS LINE
                        }
                    } else { console.warn(`WH: Checkout session ${session.id} completed but payment_status is '${session.payment_status}'. No fulfillment action taken.`); }
                    break; // End checkout.session.completed case


                case 'invoice.created':
                    const invoiceCreated = data.object;
                    //logging
                    console.log(`\n--- WH: Processing invoice.created ---`);
                    console.log(`WH InvoiceCreated: ID=${invoiceCreated.id}, Sub=${invoiceCreated.subscription}, Status=${invoiceCreated.status}, AmountDue=${invoiceCreated.amount_due}, BillingReason=${invoiceCreated.billing_reason}, Customer=${invoiceCreated.customer}`);
                    console.log(`WH InvoiceCreated: Draft? ${invoiceCreated.status === 'draft'}, Cycle/Create Reason? ${(invoiceCreated.billing_reason === 'subscription_cycle' || invoiceCreated.billing_reason === 'subscription_create')}`);
                    console.log(`WH: Invoice Created ${invoiceCreated.id}, Sub: ${invoiceCreated.subscription}, Status: ${invoiceCreated.status}, Reason: ${invoiceCreated.billing_reason}`);
                    //end logging

                    if (invoiceCreated.subscription && invoiceCreated.status === 'draft' && (invoiceCreated.billing_reason === 'subscription_cycle' || invoiceCreated.billing_reason === 'subscription_create')) {
                        console.log(`WH InvoiceCreated: Conditions MET for Sub ${invoiceCreated.subscription}. Processing...`);
                        const user = await User.findOne({ stripeSubscriptionId: invoiceCreated.subscription })
                            .select('+playgroupInstallmentsRemaining +playgroupInstallmentAmount +playgroupTotalSemesterCost +playgroupTotalInstallments');
                        console.log(`WH InvoiceCreated: Found User? ${user ? user._id : 'NO'}`);

                        // Check if installments *still* remain according to DB state BEFORE trying to add item
                        if (user && user.playgroupInstallmentsRemaining && user.playgroupInstallmentsRemaining > 0 && user.playgroupInstallmentAmount !== undefined && user.playgroupTotalSemesterCost !== undefined && user.playgroupTotalInstallments !== undefined) {
                            console.log(`WH InvoiceCreated: User Data: Remaining=${user.playgroupInstallmentsRemaining}, BaseAmount=${user.playgroupInstallmentAmount}, TotalCost=${user.playgroupTotalSemesterCost}, TotalInst=${user.playgroupTotalInstallments}`);

                            let amountThisInstallment = user.playgroupInstallmentAmount;

                            if (user.playgroupInstallmentsRemaining === 1 && user.playgroupTotalInstallments > 1) {
                                console.log("WH InvoiceCreated: Calculating FINAL installment amount...");
                                const amountBilledSoFar = user.playgroupInstallmentAmount * (user.playgroupTotalInstallments - 1);
                                amountThisInstallment = user.playgroupTotalSemesterCost - amountBilledSoFar;
                                console.log(`WH InvoiceCreated: Final Amount Calculation: Total=${user.playgroupTotalSemesterCost}, Base=${user.playgroupInstallmentAmount}, TotalInst=${user.playgroupTotalInstallments}, BilledSoFar=${amountBilledSoFar}, FinalAmount=${amountThisInstallment}`);
                                if (amountThisInstallment < 0) {
                                    console.error(`WH Error: Calculated final installment amount is negative (${amountThisInstallment}) for sub ${invoiceCreated.subscription}. Using base amount instead.`);
                                    amountThisInstallment = user.playgroupInstallmentAmount; // Fallback
                                }
                            } else {
                                // Not the last installment, use the base amount
                                console.log(` > Using base installment amount: ${amountThisInstallment}`);
                            }

                            if (amountThisInstallment > 0) {
                                // *** Moved state update inside the successful try block ***
                                try {
                                    console.log(`WH InvoiceCreated: Attempting to add Invoice Item: Amount=${amountThisInstallment}, Invoice=${invoiceCreated.id}`);
                                    // --- Create Invoice Item ---
                                    await stripe.invoiceItems.create({
                                        customer: invoiceCreated.customer,
                                        amount: amountThisInstallment,
                                        currency: 'usd',
                                        invoice: invoiceCreated.id,
                                        subscription: invoiceCreated.subscription,
                                        description: `Playgroup Semester Installment (${user.playgroupTotalInstallments - user.playgroupInstallmentsRemaining + 1} of ${user.playgroupTotalInstallments})`,
                                    });
                                    console.log(`WH InvoiceCreated: Successfully CREATED invoice item for invoice ${invoiceCreated.id}.`);

                                    // --- Decrement remaining count ONLY AFTER successful creation ---
                                    const updateOpResult = await User.findByIdAndUpdate(user._id, { $inc: { playgroupInstallmentsRemaining: -1 } });
                                    const newRemainingCount = user.playgroupInstallmentsRemaining - 1; // Calculate based on value BEFORE update for logging/check
                                    if (updateOpResult) {
                                        console.log(`WH InvoiceCreated: Successfully DECREMENTED remaining count for user ${user._id}. New count: ${newRemainingCount}`);
                                    } else {
                                        // This is unlikely if user was found before, but good to log
                                        console.error(`WH Error: Failed to find user ${user._id} to decrement remaining count after adding item!`);
                                    }

                                    // --- Schedule cancellation if last installment added ---
                                    if (newRemainingCount === 0) {
                                        console.log(`WH InvoiceCreated: Last installment added. Scheduling sub ${invoiceCreated.subscription} to cancel at period end.`);
                                        await stripe.subscriptions.update(invoiceCreated.subscription, { cancel_at_period_end: true });
                                    }

                                } catch (itemError) {
                                    console.error(`WH Error: Failed to add invoice item to ${invoiceCreated.id}:`, itemError);
                                    // DO NOT decrement counter if item creation failed
                                }
                            } else {
                                console.log(`WH InvoiceCreated: Calculated installment amount is 0 or less for invoice ${invoiceCreated.id}. Skipping invoice item.`);
                                // If amount is 0, should we still decrement the counter? Depends on business logic.
                                // If a $0 final invoice means the cycle is done, maybe decrement here too and cancel sub?
                                if (user.playgroupInstallmentsRemaining === 1) { // If it was supposed to be the last one
                                    console.log(`WH InvoiceCreated: Calculated $0 for final installment. Decrementing count and scheduling cancellation.`);
                                    await User.findByIdAndUpdate(user._id, { $inc: { playgroupInstallmentsRemaining: -1 } });
                                    await stripe.subscriptions.update(invoiceCreated.subscription, { cancel_at_period_end: true });
                                }
                            }
                        } else {
                            console.log(`WH InvoiceCreated: User/Installment details missing or no installments remaining for sub ${invoiceCreated.subscription} (Remaining = ${user?.playgroupInstallmentsRemaining}).`);
                        }
                    } else {
                        console.log(`WH InvoiceCreated: Invoice ${invoiceCreated.id} not relevant for item addition (Status: ${invoiceCreated.status}, Reason: ${invoiceCreated.billing_reason}).`);
                    }
                    break;

                case 'invoice.paid':
                    const invoicePaid = data.object;
                    console.log(`WH: Invoice Paid ${invoicePaid.id}, Sub: ${invoicePaid.subscription}, Reason: ${invoicePaid.billing_reason}`);
                    if (invoicePaid.subscription) {
                        const user = await User.findOne({ stripeSubscriptionId: invoicePaid.subscription });
                        if (user && user.email) {
                            await sendInstallmentConfirmationEmail(user.email, invoicePaid.amount_paid);
                            // Redundancy check for booking creation
                            if (invoicePaid.billing_reason === 'subscription_create' && user.playgroupBookingsCreatedForSub !== invoicePaid.subscription) {
                                console.error(`WH ALERT: First invoice paid for sub ${invoicePaid.subscription}, but bookings flag not set on user ${user._id}! Fulfillment might have failed earlier.`);
                                await notifyAdminOfBookingFailure(user._id, `Booking flag mismatch on first invoice paid for sub ${invoicePaid.subscription}.`);
                            }
                        }
                        if (user && user.playgroupInstallmentsRemaining !== undefined && user.playgroupInstallmentsRemaining === 0) {
                            // Check if the subscription is ALREADY scheduled to cancel
                            try {
                                const subscription = await stripe.subscriptions.retrieve(invoicePaid.subscription);
                                if (subscription && !subscription.cancel_at_period_end && subscription.status === 'active') {
                                    console.warn(`WH InvoicePaid: Detected 0 installments remaining for sub ${invoicePaid.subscription}, but it's not scheduled to cancel. Scheduling cancellation now.`);
                                    await stripe.subscriptions.update(invoicePaid.subscription, { cancel_at_period_end: true });
                                } else if (subscription && subscription.cancel_at_period_end) {
                                    console.log(`WH InvoicePaid: Sub ${invoicePaid.subscription} already scheduled to cancel. No action needed.`);
                                } else {
                                    console.log(`WH InvoicePaid: Sub ${invoicePaid.subscription} status is '${subscription?.status}'. No cancellation action needed.`);
                                }
                            } catch (subError) {
                                console.error(`WH InvoicePaid: Error checking/updating subscription ${invoicePaid.subscription} for cancellation:`, subError);
                            }
                        }
                    }
                    break;

                case 'invoice.payment_failed':
                    const invoiceFailed = data.object;
                    console.error(`WH: Invoice Payment FAILED ${invoiceFailed.id}, Sub: ${invoiceFailed.subscription}`);
                    if (invoiceFailed.subscription) {
                        const user = await User.findOne({ stripeSubscriptionId: invoiceFailed.subscription });
                        if (user) {
                            await sendPaymentFailedEmail(user.email);
                            await notifyAdminOfPaymentFailure(user._id, invoiceFailed.id);
                            const cancelResult = await Booking.updateMany(
                                { 'details.subscriptionId': invoiceFailed.subscription, start: { $gt: new Date() }, status: 'confirmed' },
                                { $set: { status: 'cancelled_payment_failed' } }
                            );
                            console.log(`WH: Marked ${cancelResult.modifiedCount} future bookings as cancelled_payment_failed.`);
                        }
                    }
                    break;

                case 'customer.subscription.deleted':
                    const subDeleted = data.object;
                    console.log(`WH: Subscription Deleted ${subDeleted.id}, Status: ${subDeleted.status}`);
                    const userSubDel = await User.findOneAndUpdate({ stripeSubscriptionId: subDeleted.id }, { $unset: { stripeSubscriptionId: "", playgroupInstallmentAmount: "", playgroupInstallmentsRemaining: "", playgroupEnrollmentSemester: "", playgroupBookingsCreatedForSub: "" } });
                    if (userSubDel) {
                        await notifyAdminOfSubscriptionCancellation(userSubDel._id, subDeleted.id);
                        const cancelResult = await Booking.updateMany(
                            { 'details.subscriptionId': subDeleted.id, start: { $gt: new Date() }, status: 'confirmed' },
                            { $set: { status: 'cancelled_subscription' } }
                        );
                        console.log(`WH: Marked ${cancelResult.modifiedCount} future bookings as cancelled_subscription.`);
                    }
                    break;

                default:
                //console.log(`WH: Unhandled event type ${event.type}`);
            } // End switch
        } catch (err) {
            console.error(`Webhook handler error for ${eventType}:`, err);
            throw err; // Rethrow
        }
    }; // End handleEvent definition

    // Execute handler and respond
    try {
        await handleEvent(event.type, event.data);
        // If handleEvent completes WITHOUT throwing, send 200 OK
        res.json({ received: true });
    } catch (handlerError) {
        // If handleEvent THROWS an error (including fulfillment errors), send 500
        console.error(`Webhook outer catch block error:`, handlerError) // Log the error that reached here
        res.status(500).json({ error: `Webhook handler failed: ${handlerError.message}` });
    }
});

module.exports = router;