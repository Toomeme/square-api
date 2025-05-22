// routes/bookings.js
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Booking = require('../models/Booking');
const User = require('../models/User');
const ClassSchedule = require('../models/ClassSchedule');
const Holiday = require('../models/Holiday');
const { authMiddleware } = require('../utils/auth');
const mongoose = require('mongoose');
const dateFnsTz = require('date-fns-tz');
const { toDate, toZonedTime, format} = dateFnsTz; // Import necessary functions
const { isBefore, isEqual, addWeeks, eachDayOfInterval, getDay, startOfDay, parseISO } = require('date-fns');
const nodemailer = require('nodemailer');

const businessTimeZone = 'America/New_York'; // Consistent TZ
// --- Configure Transport based on .env ---
let transporter;
 if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    // Option A: Standard SMTP
    console.log(`Configuring Nodemailer for SMTP: ${process.env.EMAIL_HOST}`);
    transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT || '587', 10),
        secure: process.env.EMAIL_SECURE === 'true', // true for 465, false for 587
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
        // Optional: Add TLS options if needed for specific providers
        // tls: {
        //     ciphers:'SSLv3'
        // }
    });
} else {
    console.warn("Email transport not configured. Email notifications will be disabled.");
    // Optional: Create a dummy transporter that just logs
    transporter = {
        sendMail: (mailOptions) => {
             console.log("--- EMAIL SIMULATION (Transport not configured) ---");
             console.log("To:", mailOptions.to);
             console.log("Subject:", mailOptions.subject);
             console.log("Body (HTML):", mailOptions.html || mailOptions.text);
             console.log("--- END EMAIL SIMULATION ---");
             return Promise.resolve({ messageId: 'simulated_' + Date.now() });
         }
    };
}

const isHoliday = (dateToCheckUserLocal, holidaysArrayUtc) => {
    const zonedDateToCheck = toZonedTime(new Date(dateToCheckUserLocal), businessTimeZone);
    const startOfTargetDayInNy = startOfDay(zonedDateToCheck);

    return holidaysArrayUtc.some(holidayUtc => {
        const zonedHoliday = toZonedTime(new Date(holidayUtc), businessTimeZone);
        const startOfHolidayDayInNy = startOfDay(zonedHoliday);
        return isEqual(startOfTargetDayInNy, startOfHolidayDayInNy);
    });
};
// --- Email Sending Function ---
const sendAdminBookingNotification = async (bookingDetails) => {
    if (!transporter || !process.env.ADMIN_EMAIL_RECIPIENT) {
        console.warn("Cannot send admin notification: Email transport or recipient not configured.");
        return;
    }

    // Ensure bookingDetails has user info populated if needed
    const user = bookingDetails.user || {}; // Handle if user is not populated
    const details = bookingDetails.details || {};
    const serviceType = bookingDetails.serviceType || 'Unknown Service';
    const startDate = bookingDetails.start ? new Date(bookingDetails.start) : null;
    const endDate = bookingDetails.end ? new Date(bookingDetails.end) : null;

    const subject = `New Booking Confirmation: ${serviceType.charAt(0).toUpperCase() + serviceType.slice(1)} - ${user.username || 'Unknown User'}`;

    let htmlBody = `
        <h1>New Booking Received!</h1>
        <p>A new booking has been successfully created:</p>
        <ul>
            <li><strong>Booking ID:</strong> ${bookingDetails._id}</li>
            <li><strong>User ID:</strong> ${user._id || 'N/A'}</li>
            <li><strong>Username:</strong> ${user.username || 'N/A'}</li>
            <li><strong>Email:</strong> ${user.email || 'N/A'}</li>
            <li><strong>Service Type:</strong> ${serviceType}</li>
    `;

    // Add details specific to booking type
    if (startDate && endDate && serviceType !== 'openplay' || details.option === 'dropin') {
         htmlBody += `<li><strong>Date:</strong> ${startDate.toLocaleDateString('en-US', { timeZone: businessTimeZone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}</li>`;
         htmlBody += `<li><strong>Time:</strong> ${startDate.toLocaleTimeString('en-US', { timeZone: businessTimeZone, hour: 'numeric', minute: '2-digit' })} - ${endDate.toLocaleTimeString('en-US', { timeZone: businessTimeZone, hour: 'numeric', minute: '2-digit' })}</li>`;
    }

    if (serviceType === 'openplay') {
        htmlBody += `<li><strong>Option:</strong> ${details.option || 'N/A'}</li>`;
        if(details.option !== 'dropin') {
             htmlBody += `<li><strong>Purchase Time:</strong> ${new Date(bookingDetails.createdAt || Date.now()).toLocaleString('en-US', { timeZone: businessTimeZone })}</li>`;
        }
    } else if (serviceType === 'playgroup') {
         htmlBody += `<li><strong>Semester:</strong> ${details.semesterStart} to ${details.semesterEnd}</li>`;
         htmlBody += `<li><strong>Payment Ref:</strong> ${details.subscriptionId ? `Sub: ${details.subscriptionId}` : `PI: ${details.paymentIntentId}`}</li>`;
    } else if (serviceType === 'birthday') {
         htmlBody += `<li><strong>Duration:</strong> ${details.partyDuration || details.duration || 'N/A'} hours</li>`; // Use appropriate detail field
    }

    htmlBody += `<li><strong>Cost Recorded:</strong> $${(bookingDetails.cost || 0).toFixed(2)}</li>`; // Cost stored on this specific booking record
    htmlBody += `<li><strong>Booking Status:</strong> ${bookingDetails.status}</li>`;
    htmlBody += `<li><strong>Timestamp:</strong> ${new Date(bookingDetails.createdAt || Date.now()).toLocaleString('en-US', { timeZone: businessTimeZone })}</li>`;

    htmlBody += `</ul>
        <p>Booking Details Object:</p>
        <pre>${JSON.stringify(bookingDetails.details, null, 2)}</pre>
    `;

    const mailOptions = {
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER, // Use verified sender for SendGrid/SES
        to: process.env.ADMIN_EMAIL_RECIPIENT,
        subject: subject,
        html: htmlBody,
        text: `New booking received for ${user.username || 'Unknown User'} - ${serviceType}. Booking ID: ${bookingDetails._id}`, // Fallback text
    };

    try {
        console.log(`Sending admin notification email to ${process.env.ADMIN_EMAIL_RECIPIENT} for booking ${bookingDetails._id}...`);
        let info = await transporter.sendMail(mailOptions);
        console.log('Admin notification email sent successfully: %s', info.messageId);
    } catch (error) {
        console.error('Error sending admin notification email:', error);
        // Don't let email failure stop the main process
    }
};



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
async function createRollingPlaygroupBookings(userId, enrollmentStartDateStr, enrollmentEndDateStr, scheduleIds, paymentRef, isSubscription) {
    const refType = isSubscription ? 'Subscription' : 'PaymentIntent';
    console.log(`SERVICE: Creating ROLLING Playgroup bookings for user ${userId}, ${refType}: ${paymentRef}`);
    console.log(`SERVICE PARAMS: Start=${enrollmentStartDateStr}, End=${enrollmentEndDateStr}, Schedules=${JSON.stringify(scheduleIds)}`);

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const startDate = parseISO(enrollmentStartDateStr); // Parse YYYY-MM-DD strings
        const endDate = parseISO(enrollmentEndDateStr);
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) throw new Error("Invalid start/end dates for booking creation.");

        const userObjectId = new mongoose.Types.ObjectId(userId);
        const holidays = await Holiday.find({ date: { $gte: startDate, $lte: endDate } }).session(session).lean();
        const holidayDates = holidays.map(h => h.date);
        const selectedSchedules = await ClassSchedule.find({ '_id': { $in: scheduleIds } }).session(session);
        if (selectedSchedules.length === 0) throw new Error('No matching ClassSchedule documents found for provided IDs.');
        // If scheduleIds might not match selected days of week, re-calculate bitmask or trust it from metadata.
        // For simplicity, assume scheduleIds correctly reflect chosen days/times.

        const scheduleMap = selectedSchedules.reduce((map, sched) => { if (!map[sched.dayOfWeek]) map[sched.dayOfWeek] = []; map[sched.dayOfWeek].push(sched); return map;}, {});
        const user = await User.findById(userObjectId).session(session);
        if (!user) throw new Error(`User ${userId} not found.`);

        const createdBookings = [];
        let currentDate = new Date(startDate);
        const today = new Date(); // For skipping past slots

        const isDaySelected = (day, mask) => ((1 << day) & mask) !== 0;


        let iterationCount = 0;
        const datesInPeriod = eachDayOfInterval({ start: startDate, end: endDate });

        for (const loopDate of datesInPeriod) {
            iterationCount++;
            const zonedCurrentDate = toZonedTime(loopDate, businessTimeZone);
            const dayOfWeekInTZ = getDay(zonedCurrentDate); // date-fns getDay

            // Check if there's ANY schedule selected for this dayOfWeek
            if (scheduleMap[dayOfWeekInTZ] && scheduleMap[dayOfWeekInTZ].length > 0) {
                if (!isHoliday(loopDate, holidayDates)) {
                    for (const schedule of scheduleMap[dayOfWeekInTZ]) { // Loop through actual selected schedules for this day
                        const dateStr = format(zonedCurrentDate, 'yyyy-MM-dd');
                        const startString = `${dateStr}T${schedule.startTime}:00`;
                        const endString = `${dateStr}T${schedule.endTime}:00`;
                        const zonedStartTime = toZonedTime(startString, businessTimeZone);
                        const startTimeUTC = toDate(zonedStartTime);
                        const zonedEndTime = toZonedTime(endString, businessTimeZone);
                        const endTimeUTC = toDate(zonedEndTime);

                        if (isBefore(startOfDay(startTimeUTC), today)) { console.log(`SERVICE Rolling: Skipping past slot ${startTimeUTC.toISOString()}`); continue; }

                        // Capacity Check
                        const existingBookingsCount = await Booking.countDocuments({ serviceType: 'playgroup', start: startTimeUTC, status: { $in: ['paid', 'confirmed'] } }).session(session);
                        if (existingBookingsCount >= schedule.capacity) {
                            throw new Error(`Capacity full for playgroup slot on ${format(zonedStartTime, 'MMM d, yyyy HH:mm')}.`);
                        }

                        // Create Booking
                        const newBooking = new Booking({
                            user: userObjectId, serviceType: 'playgroup', cost: 0, // Cost is handled by overall payment/sub
                            details: {
                                scheduleId: schedule._id,
                                enrollmentStartDate: enrollmentStartDateStr,
                                enrollmentEndDate: enrollmentEndDateStr,
                                ...(isSubscription ? { subscriptionId: paymentRef } : { paymentIntentId: paymentRef })
                            },
                            start: startTimeUTC, end: endTimeUTC, status: 'confirmed', // Confirmed by successful payment/sub setup
                            ...(isSubscription ? {} : { paymentIntentId: paymentRef }) // Add PI only if not a sub
                        });
                        const savedBooking = await newBooking.save({ session: session });
                        await User.findByIdAndUpdate(userObjectId, { $push: { classes: savedBooking._id } }).session(session);
                        createdBookings.push(savedBooking);
                        // GCal removal means no GCal calls here
                    }
                } else { console.log(`SERVICE Rolling: Skipping holiday ${format(loopDate, 'yyyy-MM-dd')}`); }
            } // No else needed, just skip if no schedule for this day
            // currentDate.setDate(currentDate.getDate() + 1); // Not needed with eachDayOfInterval
        } // End loop

        console.log(`SERVICE Rolling: Loop finished after ${iterationCount} date checks.`);
        if (createdBookings.length === 0) console.warn("SERVICE Rolling: WARNING - No bookings created. Check dates, holidays, or schedule selection.");

        await session.commitTransaction();
        console.log(`SERVICE Rolling: Transaction committed. ${createdBookings.length} bookings created for ${refType} ${paymentRef}.`);
        return createdBookings;
    } catch (err) {
        console.error(`SERVICE Rolling: Error creating playgroup bookings for ${refType} ${paymentRef}:`, err);
        if (session.inTransaction()) await session.abortTransaction();
        throw err;
    } finally {
        if (session && session.endSession) session.endSession();
    }
}

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

async function createSlotBooking(userId, slotStart, slotEnd, serviceType, paymentIntentId, quantity, metadata = {}) {
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
        const neededCapacity = parseInt(quantity, 10) || 1;
        const remainingCapacity = classSchedule.capacity - existingBookingsCount;
        if (neededCapacity > remainingCapacity) {
            throw new Error(`Insufficient capacity. Needed: ${neededCapacity}, Available: ${remainingCapacity}`);
        }

        // Create Booking
        const createdBookingsThisSlot = [];
        for (let i = 0; i < neededCapacity; i++) {
        const newBooking = new Booking({
            user: userObjectId, serviceType, cost: metadata.calculatedAmount ? metadata.calculatedAmount / 100 : 0, // Get cost from metadata if available
            details: { ...metadata, scheduleId: classSchedule._id, paymentIntentId }, // Store metadata and PI
            start: startTime, end: endTime, status: 'paid', paymentIntentId
        });
        const savedBooking = await newBooking.save({ session });
        await User.findByIdAndUpdate(userObjectId, { $push: { classes: savedBooking._id } }).session(session);
        createdBookingsThisSlot.push(savedBooking);    
    }
        await session.commitTransaction();
        console.log(`SERVICE: Transaction committed. Slot booking ${createdBookingsThisSlot.length} created for PI ${paymentIntentId}.`);
        return createdBookingsThisSlot;

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

            if (isBefore(endTimeUTC, today)) continue; // Skip past slots

            const existingBookingsCount = await Booking.countDocuments({
                serviceType: serviceType, start: startTimeUTC, end: endTimeUTC,
                status: { $in: ['pending', 'paid', 'confirmed'] }
            });

            if (existingBookingsCount < schedule.capacity) {
                    availableSlots.push({ start: startTimeUTC.toISOString(), end: endTimeUTC.toISOString() });
            }
        }
        res.json(availableSlots);
    } catch (err) {
        console.error("Error in /available-slots:", err);
        res.status(500).json({ message: 'Error fetching available slots' });
    }
});

router.get('/rolling-slot-availability', authMiddleware, async (req, res) => {
    console.log("--- ROLLING AVAILABILITY CHECK (BACKEND) ---");
    console.log("Received Query Parameters:", JSON.stringify(req.query, null, 2)); // Log the whole query object

    const { scheduleId, checkStartDate: checkStartDateString, durationWeeks } = req.query;

    console.log(`Extracted scheduleId: '${scheduleId}' (type: ${typeof scheduleId})`);
    console.log(`Extracted checkStartDateString: '${checkStartDateString}' (type: ${typeof checkStartDateString})`);
    console.log(`Extracted durationWeeks: '${durationWeeks}' (type: ${typeof durationWeeks})`); // Log its raw value and type

    const today = startOfDay(new Date());

    // --- Validation ---
    if (!scheduleId || !mongoose.Types.ObjectId.isValid(scheduleId)) {
        console.error("Validation Error: Invalid or missing scheduleId.");
        return res.status(400).json({ message: 'Valid scheduleId is required.' });
    }
    if (!checkStartDateString || typeof checkStartDateString !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(checkStartDateString)) {
        console.error("Validation Error: Invalid or missing checkStartDate format. Must be YYYY-MM-DD string.");
        return res.status(400).json({ message: 'checkStartDate (YYYY-MM-DD string) is required.' });
    }

    // Explicitly check if durationWeeks is undefined, null, or an empty string BEFORE parsing
    if (durationWeeks === undefined || durationWeeks === null || String(durationWeeks).trim() === '') {
        console.error("Validation Error: durationWeeks is missing or empty.");
        return res.status(400).json({ message: 'durationWeeks query parameter is required and cannot be empty.' });
    }

    const parsedDuration = parseInt(durationWeeks, 10);
    console.log(`Parsed durationWeeks to integer: ${parsedDuration}`);

    if (isNaN(parsedDuration) || parsedDuration <= 0) {
        console.error(`Validation Error: parsedDuration is NaN or not positive. Original: '${durationWeeks}', Parsed: ${parsedDuration}`);
        return res.status(400).json({ message: 'Rolling enrollment weeks is invalid (must be a positive number).' });
    }

    let checkStartDate;
    try {
        checkStartDate = parseISO(checkStartDateString); // Parses YYYY-MM-DD
        if (isNaN(checkStartDate.getTime())) throw new Error("Parsed date is NaN");
        console.log("Parsed checkStartDate:", checkStartDate.toISOString());
    } catch (e) {
        console.error("Validation Error: Invalid checkStartDate format after parsing.", e.message);
        return res.status(400).json({ message: 'Invalid checkStartDate format. Use YYYY-MM-DD.' });
    }

    console.log(`ROLLING AVAIL CHECK: Schedule ${scheduleId}, For ${parsedDuration} weeks starting from ${format(checkStartDate, 'yyyy-MM-dd')}`);

    try {
        // 1. Fetch Schedule Details
        const schedule = await ClassSchedule.findById(scheduleId).lean();
        if (!schedule) return res.status(404).json({ message: 'Class schedule not found.' });
        const maxCapacity = schedule.capacity;

        // 2. Calculate the 8-week period based on checkStartDate
        const enrollmentStartDate = new Date(checkStartDate); // Use the provided start date
        const enrollmentEndDate = addWeeks(enrollmentStartDate, parsedDuration);
        enrollmentEndDate.setDate(enrollmentEndDate.getDate() - 1); // Inclusive end for 8 weeks
        console.log(` > Period: ${format(enrollmentStartDate, 'yyyy-MM-dd')} to ${format(enrollmentEndDate, 'yyyy-MM-dd')}`);


        // 3. Fetch Holidays in this specific 8-week range
        const holidays = await Holiday.find({ date: { $gte: enrollmentStartDate, $lte: enrollmentEndDate } }).lean();
        const holidayDates = holidays.map(h => h.date); // Array of Date objects
        console.log(` > Found ${holidayDates.length} holidays in this 8-week period.`);

        // 4. Iterate and Count (Focus on finding minimum remaining capacity in this 8-week block)
        let minRemainingCapacity = maxCapacity;
        let isEverFullInPeriod = false;
        let checkedFutureDatesInPeriod = 0;
        let firstAvailableDate = null; // To find the earliest bookable date in the 8-week window

        const datesInPeriod = eachDayOfInterval({ start: enrollmentStartDate, end: enrollmentEndDate });

        for (const currentDate of datesInPeriod) {
            const zonedCurrentDate = toZonedTime(currentDate, businessTimeZone);
            const dayOfWeekInTZ = getDay(zonedCurrentDate); // date-fns getDay: 0=Sun, 6=Sat

            if (dayOfWeekInTZ === schedule.dayOfWeek && !isHoliday(currentDate, holidayDates)) {
                // Calculate specific slot times for this date
                const dateStr = format(zonedCurrentDate, 'yyyy-MM-dd');
                const startString = `${dateStr}T${schedule.startTime}:00`;
                const endString = `${dateStr}T${schedule.endTime}:00`;
                const zonedStartTime = toZonedTime(startString, businessTimeZone);
                const startTimeUTC = toDate(zonedStartTime);
                 const zonedEndTime = toZonedTime(endString, businessTimeZone); // Not strictly needed for count if start is unique
                 const endTimeUTC = toDate(zonedEndTime);

                // Only consider dates/slots that are today or in the future
                if (!isBefore(startOfDay(startTimeUTC), today)) { // Compare start of day
                    checkedFutureDatesInPeriod++;
                    if (!firstAvailableDate) {
                        firstAvailableDate = new Date(startTimeUTC); // Capture the first valid future date
                    }

                    const count = await Booking.countDocuments({
                        serviceType: schedule.serviceType, // Assuming playgroup
                        start: startTimeUTC,
                        status: { $in: ['paid', 'confirmed'] }
                    });

                    const remaining = maxCapacity - count;
                    minRemainingCapacity = Math.min(minRemainingCapacity, remaining);
                    // console.log(` > ${dateStr} ${schedule.startTime} - Count=${count}, Remaining=${remaining}, MinSoFar=${minRemainingCapacity}`);

                    if (remaining <= 0) {
                        isEverFullInPeriod = true;
                        // Don't break here if you want to find the absolute minRemaining.
                        // If just checking if *any* slot is full, you can break.
                    }
                }
            }
        } // end for loop over datesInPeriod

        // 5. Return Result
        const result = {
            scheduleId: scheduleId,
            maxCapacity: maxCapacity,
            minRemainingCapacityInPeriod: isEverFullInPeriod ? 0 : Math.max(0, minRemainingCapacity), // Ensure non-negative
            requestedStartDate: checkStartDateString,
            periodCheckedStart: format(enrollmentStartDate, 'yyyy-MM-dd'),
            periodCheckedEnd: format(enrollmentEndDate, 'yyyy-MM-dd'),
            firstAvailableDateInPeriod: firstAvailableDate ? firstAvailableDate.toISOString() : null,
            checkedFutureDatesInPeriod: checkedFutureDatesInPeriod
        };
        console.log(`ROLLING AVAIL RESULT for ${scheduleId} starting ${checkStartDateString}:`, result);
        res.json(result);

    }catch (error) {
        console.error(`Error checking rolling availability for schedule ${scheduleId}:`, error);
        res.status(500).json({ message: 'Error checking slot availability.' });
    }
});

router.get('/semester-slot-availability', authMiddleware, async (req, res) => {
    const { scheduleId, semesterStart, semesterEnd } = req.query;
    const today = new Date(); // Compare against today

    // --- Validation ---
    if (!scheduleId || !mongoose.Types.ObjectId.isValid(scheduleId)) return res.status(400).json({ message: 'Valid scheduleId is required.' });
    if (!semesterStart || !semesterEnd || isNaN(new Date(semesterStart)) || isNaN(new Date(semesterEnd))) {
        return res.status(400).json({ message: 'Valid semesterStart and semesterEnd are required.' });
    }

    console.log(`AVAIL CHECK: Schedule ${scheduleId}, Semester ${semesterStart} - ${semesterEnd}`);

    try {
        // 1. Fetch Schedule Details
        const schedule = await ClassSchedule.findById(scheduleId).lean();
        if (!schedule) return res.status(404).json({ message: 'Class schedule not found.' });
        const maxCapacity = schedule.capacity;

        // 2. Fetch Holidays in Range (optimization)
        const startDate = new Date(semesterStart);
        const endDate = new Date(semesterEnd);
        const holidays = await Holiday.find({ date: { $gte: startDate, $lte: endDate } }).lean();
        const holidayDates = holidays.map(h => h.date);

        // 3. Iterate and Count (Focus on finding minimum remaining capacity)
        let minRemainingCapacity = maxCapacity; // Start assuming full availability
        let isEverFull = false;
        let currentDate = new Date(startDate);
        let checkedFutureDates = 0;

        while (currentDate <= endDate && minRemainingCapacity > 0) { // Stop if we find a full slot
            const zonedCurrentDate = toZonedTime(currentDate, businessTimeZone);
            const dayOfWeekInTZ = zonedCurrentDate.getDay();

            if (dayOfWeekInTZ === schedule.dayOfWeek && !isHoliday(currentDate, holidayDates)) {
                // Calculate specific slot times for this date
                const dateStr = format(zonedCurrentDate, 'yyyy-MM-dd');
                const startString = `${dateStr}T${schedule.startTime}:00`;
                const endString = `${dateStr}T${schedule.endTime}:00`;
                const zonedStartTime = toZonedTime(startString, businessTimeZone);
                const startTimeUTC = toDate(zonedStartTime);
                const zonedEndTime = toZonedTime(endString, businessTimeZone);
                const endTimeUTC = toDate(zonedEndTime);

                // Only check dates/slots from today onwards
                if (!isBefore(startTimeUTC, today)) {
                    checkedFutureDates++;
                    // Count bookings for this specific instance
                    const count = await Booking.countDocuments({
                        // Consider indexing this query: scheduleId + start + status?
                        // classScheduleId: scheduleId, // If you add this field to Booking model
                        serviceType: schedule.serviceType, // Assuming playgroup
                        start: startTimeUTC,
                        // end: endTimeUTC, // Optional: start time might be sufficient if unique
                        status: { $in: ['paid', 'confirmed'] }
                    });

                    const remaining = maxCapacity - count;
                    minRemainingCapacity = Math.min(minRemainingCapacity, remaining);

                    // console.log(`AVAIL CHECK: ${dateStr} ${schedule.startTime} - Count=${count}, Remaining=${remaining}, MinSoFar=${minRemainingCapacity}`); // Debug log

                    if (remaining <= 0) {
                        isEverFull = true;
                        break; // Found a full date, no need to check further
                    }
                }
            }
            currentDate.setDate(currentDate.getDate() + 1);
        } // end while loop

        // 4. Return Result
        const result = {
            scheduleId: scheduleId,
            maxCapacity: maxCapacity,
            // Return the minimum found, or 0 if any date was full
            minRemainingCapacity: isEverFull ? 0 : minRemainingCapacity,
            checkedFutureDates: checkedFutureDates // Info about how many dates were checked
        };
        console.log(`AVAIL CHECK RESULT for ${scheduleId}:`, result);
        res.json(result);

    } catch (error) {
        console.error(`Error checking availability for schedule ${scheduleId}:`, error);
        res.status(500).json({ message: 'Error checking slot availability.' });
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

                if (isBefore(endTimeUTC, today)) continue; // Skip past slots

                const existingBookingsCount = await Booking.countDocuments({ /* ... */ });

                if (existingBookingsCount < schedule.capacity) {
                        results[currentDateStr].push({ start: startTimeUTC.toISOString(), end: endTimeUTC.toISOString() });
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

        // --- Database Update (Soft Delete) ---
        booking.status = 'cancelled';
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

/*router.post('/test-email', authMiddleware, async (req, res) => {
    console.log("--- ADMIN: Received request to /api/admin/test-email ---");

    // You can optionally allow passing mock data via request body in Insomnia
    const mockBookingData = req.body.bookingData || {
        // Provide realistic default mock data if none sent in request
        _id: new mongoose.Types.ObjectId(), // Generate a fake booking ID
        user: { // Mock populated user data
            _id: new mongoose.Types.ObjectId(), // Use admin's ID or fake one
            username: 'Test User',
            email: 'test-recipient@example.com' // Default email for testing display
        },
        serviceType: 'playgroup',
        start: new Date(),
        end: new Date(Date.now() + 60 * 60 * 1000), // 1 hour later
        details: {
            scheduleId: new mongoose.Types.ObjectId(),
            semesterStart: '2025-09-01',
            semesterEnd: '2025-12-20',
            paymentIntentId: 'pi_test_xxxxxxxx',
            subscriptionId: 'subjhkjgfkgfu', // Will be undefined if not provided
            notes: "This is a test notification triggered via API.",
            ...({}) // Allow overriding details via request
        },
        cost:  0,
        status: 'paid',
        createdAt: new Date()
    };

    console.log("Using mock booking data:", mockBookingData);

    try {
        // Call the mailer function directly with the mock data
        await sendAdminBookingNotification(mockBookingData);

        res.status(200).json({
            message: `Test email notification triggered successfully for service type '${mockBookingData.serviceType}'. Check the recipient inbox (${process.env.ADMIN_EMAIL_RECIPIENT}) and server logs.`,
            sentTo: process.env.ADMIN_EMAIL_RECIPIENT
        });
    } catch (error) {
        // Catch errors specifically from the email sending function if needed,
        // although sendAdminBookingNotification already has internal logging.
        console.error("Error directly calling sendAdminBookingNotification:", error);
        res.status(500).json({ message: "Failed to trigger test email.", error: error.message });
    }
});*/


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
                    const session = data.object; // The Checkout Session object
                    console.log(`WH: Processing checkout.session.completed - Session ID: ${session.id}, Mode: ${session.mode}, Payment Status: ${session.payment_status}`);
                    console.log(`WH: Metadata: ${JSON.stringify(session.metadata, null, 2)}`);

                    // Ensure payment was successful OR subscription setup is complete
                    if (session.payment_status === 'paid' || (session.mode === 'subscription' && session.status === 'complete')) {
                        const {
                            appUserId,
                            bookingType, // e.g., 'playgroup_rolling_installment', 'playgroup_rolling_full'
                            serviceType, // Should be 'playgroup' for these cases
                            // Playgroup specific metadata for rolling:
                            enrollmentStartDate: enrollmentStartDateStr, // YYYY-MM-DD from metadata
                            durationWeeks: durationWeeksStr,             // String from metadata
                            scheduleIds: scheduleIdsJson,                // Stringified array from metadata
                            daysPerWeekBitmask: daysBitmaskStr,          // String from metadata
                            // For installments, these were calculated in payments.js and stored in metadata:
                            numInstallments: numInstallmentsStr,
                            installmentAmount: installmentAmountStr,     // Base installment amount
                            firstInstallmentAmount: firstInstallmentAmountStr,
                            totalSemesterCost: totalBlockCostStr,        // Total cost for this block
                            // For other booking types:
                            // openPlayOption, slotStart, slotEnd, partyDuration, bookedItems etc.
                            ...otherMetadata // Catch any other metadata
                        } = session.metadata || {};

                        // --- Basic Validation of Core Metadata ---
                        if (!appUserId || !bookingType) {
                            console.error(`WH CRITICAL: Missing appUserId ('${appUserId}') or bookingType ('${bookingType}') in metadata for session ${session.id}. Cannot fulfill.`);
                            break; // Acknowledge event but cannot proceed
                        }

                        console.log(`WH: Fulfilling ${bookingType} for User ${appUserId}`);
                        const paymentIntentId = session.payment_intent;     // For 'payment' mode
                        const subscriptionId = session.subscription;       // For 'subscription' mode

                        // --- Idempotency Check ---
                        // For one-time payments, check against paymentIntentId in Bookings
                        // For subscriptions, check against subscriptionId in User (for setup) and Bookings (for actual class bookings)
                        if (session.mode === 'payment' && paymentIntentId) {
                            const existingPiBooking = await Booking.findOne({ paymentIntentId: paymentIntentId });
                            if (existingPiBooking) {
                                console.log(`WH: Idempotency: Fulfillment for PI ${paymentIntentId} (Session ${session.id}) seems already processed (Booking found).`);
                                break;
                            }
                        } else if (session.mode === 'subscription' && subscriptionId) {
                            // Check if User record already has this subscription and installment setup
                            const userCheck = await User.findOne({ _id: appUserId, stripeSubscriptionId: subscriptionId });
                            if (userCheck && userCheck.playgroupInstallmentsRemaining !== undefined && userCheck.playgroupBookingsCreatedForSub === subscriptionId) {
                                 console.log(`WH: Idempotency: Subscription setup AND bookings for sub ${subscriptionId} already processed for user ${appUserId}.`);
                                 break;
                            } else if (userCheck && userCheck.playgroupInstallmentsRemaining !== undefined) {
                                console.log(`WH: Idempotency: User setup for sub ${subscriptionId} done, awaiting first invoice.paid for bookings.`);
                                // Don't break here if only user setup is done but bookings are not yet created (as bookings happen on first invoice.paid)
                            }
                        }


                        // --- Route Fulfillment Based on bookingType ---
                        try { // Wrap specific fulfillment actions
                            if (bookingType === 'playgroup_rolling_installment') {
                                if (!subscriptionId) throw new Error("Missing subscription ID for playgroup_rolling_installment.");
                                if (!enrollmentStartDateStr || !durationWeeksStr || !scheduleIdsJson || !numInstallmentsStr || !installmentAmountStr || !totalBlockCostStr) {
                                    throw new Error("Missing critical metadata for playgroup_rolling_installment setup.");
                                }

                                const numInstallments = parseInt(numInstallmentsStr, 10);
                                const baseInstallmentAmount = parseInt(installmentAmountStr, 10);
                                const totalCostForBlock = parseInt(totalBlockCostStr, 10);
                                const parsedDuration = parseInt(durationWeeksStr, 10);

                                // 1. Update User record with Stripe IDs & installment plan details
                                console.log(`WH: Updating user ${appUserId} with sub ${subscriptionId}, customer ${session.customer}, and rolling installment details.`);
                                await User.findByIdAndUpdate(appUserId, {
                                    stripeSubscriptionId: subscriptionId,
                                    stripeCustomerId: session.customer, // Get customer ID from session
                                    playgroupInstallmentAmount: baseInstallmentAmount,
                                    playgroupInstallmentsRemaining: numInstallments,
                                    playgroupTotalSemesterCost: totalCostForBlock, // Cost for this 8-week block
                                    playgroupTotalInstallments: numInstallments,
                                    playgroupEnrollmentStartDate: enrollmentStartDateStr, // Store YYYY-MM-DD
                                    playgroupEnrollmentEndDate: format(addWeeks(parseISO(enrollmentStartDateStr), parsedDuration -1), 'yyyy-MM-dd'), // Calculate and store end
                                    playgroupEnrollmentDurationWeeks: parsedDuration, // Store duration
                                    playgroupScheduleIds: scheduleIdsJson, // Store stringified schedule IDs
                                    playgroupDaysBitmask: parseInt(otherMetadata.daysBitmask, 10), // Store bitmask
                                    playgroupBookingsCreatedForSub: null // Bookings created on first invoice.paid
                                });
                                console.log(`WH: User ${appUserId} updated for rolling playgroup subscription. Bookings will be created on first invoice payment.`);
                                // Note: Actual Booking documents for class sessions are created on the first 'invoice.paid' event.

                            } else if (bookingType === 'playgroup_rolling_full') {
                                if (!paymentIntentId) throw new Error("Missing payment_intent ID for playgroup_rolling_full.");
                                if (!enrollmentStartDateStr || !durationWeeksStr || !scheduleIdsJson) {
                                    throw new Error("Missing critical metadata for playgroup_rolling_full.");
                                }
                                const parsedDuration = parseInt(durationWeeksStr, 10);
                                const enrollmentEndDate = format(addWeeks(parseISO(enrollmentStartDateStr), parsedDuration -1), 'yyyy-MM-dd');


                                console.log(`WH: Calling createRollingPlaygroupBookings (Full Payment) for PI ${paymentIntentId}...`);
                                await createRollingPlaygroupBookings(
                                    appUserId,
                                    enrollmentStartDateStr, // Pass as YYYY-MM-DD string
                                    enrollmentEndDate,      // Pass calculated end date string
                                    JSON.parse(scheduleIdsJson || '[]'),
                                    paymentIntentId,
                                    false // isSubscription = false
                                );
                                // No User flag like playgroupBookingsCreatedForSub for one-time PIs, idempotency relies on PI in Booking doc

                            } else if (bookingType === 'openplay_dropin' || bookingType === 'birthday') {
                                const paymentIntentId = session.payment_intent; if (!paymentIntentId) throw new Error(`Missing PI for ${bookingType}.`);
                                if (!otherMetadata.slotStart || !otherMetadata.slotEnd) throw new Error(`Missing slot data for ${bookingType}.`);
                                let itemDetails;
                                try { itemDetails = JSON.parse(otherMetadata.originalItemDetails || '{}'); } // Use otherMetadata
                                catch(e) { console.error("WH Error: Failed to parse originalItemDetails"); break; }
        
                                const quantityToBook = parseInt(itemDetails.quantity, 10) || 1;
                                console.log(`WH: Calling createSlotBooking for PI ${paymentIntentId} with quantity ${quantityToBook}`);
                                const savedBooking = await createSlotBooking(appUserId, otherMetadata.slotStart, otherMetadata.slotEnd, serviceType, paymentIntentId, quantityToBook, otherMetadata);
                                const populatedBooking = await Booking.findById(savedBooking._id).populate('user', 'username email').lean();
                         if (populatedBooking) await sendAdminBookingNotification(populatedBooking);

                            } else if (bookingType === 'openplay_purchase') {
                                if (!paymentIntentId) throw new Error("Missing PI for openplay_purchase.");
                                if (!otherMetadata.openPlayOption) throw new Error("Missing openPlayOption.");
                                await updateUserPurchase(appUserId, otherMetadata.openPlayOption, paymentIntentId, otherMetadata);

                            } else {
                                console.warn(`WH: Unhandled bookingType in checkout.session.completed: ${bookingType}`);
                            }
                            console.log(`WH: Successfully completed fulfillment logic for ${bookingType} / session ${session.id}`);

                        } catch (fulfillmentError) {
                            console.error(`WH CRITICAL: Fulfillment failed for session ${session.id} (bookingType: ${bookingType}):`, fulfillmentError);
                            await notifyAdminOfBookingFailure(appUserId, `Webhook fulfillment failed for ${bookingType} / session ${session.id}: ${fulfillmentError.message}`);
                            if (bookingType === 'playgroup_rolling_installment' && subscriptionId) { /* ... attempt to cancel sub ... */ }
                            // Respond 200 OK to Stripe to acknowledge receipt and prevent retries for app logic errors
                            return res.status(200).json({ received: true, error: `Internal fulfillment error: ${fulfillmentError.message}` });
                        }
                    } else {
                         console.warn(`WH: Checkout session ${session.id} completed but payment_status is '${session.payment_status}' OR mode/status not handled. No fulfillment action taken.`);
                    }
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
                        // --- Trigger Booking Creation on FIRST successful subscription invoice payment ---
                        if (invoicePaid.subscription && invoicePaid.billing_reason === 'subscription_create') { // First invoice after checkout
                             console.log(` > First invoice paid for subscription ${invoicePaid.subscription}.`);
                             const user = await User.findOne({ stripeSubscriptionId: invoicePaid.subscription })
                                 .select('+playgroupEnrollmentStartDate +playgroupEnrollmentEndDate +playgroupBookingsCreatedForSub +playgroupScheduleIds +playgroupEnrollmentDurationWeeks'); // Add fields needed
    
                             if (user && user.playgroupBookingsCreatedForSub !== invoicePaid.subscription && user.playgroupEnrollmentStartDate && user.playgroupEnrollmentEndDate && user.playgroupScheduleIds && user.playgroupEnrollmentDurationWeeks) {
                                 console.log(` > Triggering createRollingPlaygroupBookings for user ${user._id} for their new rolling enrollment...`);
                                 try {
                                     const scheduleIds = JSON.parse(user.playgroupScheduleIds || '[]');
                                     if (scheduleIds.length === 0) throw new Error("No scheduleIds stored on user for booking creation.");
    
                                     await createRollingPlaygroupBookings(
                                         user._id.toString(),
                                         user.playgroupEnrollmentStartDate, // Use string YYYY-MM-DD from DB
                                         user.playgroupEnrollmentEndDate,   // Use string YYYY-MM-DD from DB
                                         scheduleIds,
                                         invoicePaid.subscription,
                                         true // isSubscription = true
                                     );
                                     await User.findByIdAndUpdate(user._id, { playgroupBookingsCreatedForSub: invoicePaid.subscription });
                                     console.log(` > Marked bookings as created for sub ${invoicePaid.subscription}`);
                                     if (user.email) await sendInstallmentConfirmationEmail(user.email, invoicePaid.amount_paid); // Send initial confirmation
    
                                 } catch(bookingError) {
                                    console.error(` > CRITICAL: Failed to create rolling bookings on first invoice payment for sub ${invoicePaid.subscription}:`, bookingError);
                                    await notifyAdminOfBookingFailure(user._id, `Booking creation failed for rolling sub ${invoicePaid.subscription}: ${bookingError.message}`);
                                    // Don't return 500, payment succeeded. Admin needs to intervene.
                                 }
                             } else if (user && user.playgroupBookingsCreatedForSub === invoicePaid.subscription) {
                                 console.log(` > Bookings already created for sub ${invoicePaid.subscription}. Sending payment confirmation.`);
                                  if (user.email) await sendInstallmentConfirmationEmail(user.email, invoicePaid.amount_paid);
                             } else if (user) {
                                  console.error(` > User ${user._id} found for sub ${invoicePaid.subscription}, but missing necessary enrollment details (startDate, endDate, scheduleIds, duration) to create bookings.`);
                                  await notifyAdminOfBookingFailure(user._id, `Missing enrollment details for sub ${invoicePaid.subscription} on first invoice.paid.`);
                             } else {
                                 console.error(` > User not found for paid subscription ${invoicePaid.subscription}!`);
                             }
                         } else if (invoicePaid.subscription) { // Subsequent installment payments
                              const user = await User.findOne({ stripeSubscriptionId: invoicePaid.subscription });
                              if (user && user.email) await sendInstallmentConfirmationEmail(user.email, invoicePaid.amount_paid);
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