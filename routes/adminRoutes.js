// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const User = require('../models/User');
const Booking = require('../models/Booking');
const { adminCheckMiddleware, redirectIfAdminLoggedIn } = require('../utils/adminAuth');
const { toDate, toZonedTime, format, isEqual } = require('date-fns-tz');
const { parseISO } = require('date-fns');

const businessTimeZone = 'America/New_York'; // Assuming this is set

// --- Admin Login Routes ---
// GET /admin/login - Show login page
router.get('/login', redirectIfAdminLoggedIn, (req, res) => {
    res.render('admin/login', { title: 'Admin Login', error: req.query.error || null }); // Pass error via query
});

// POST /admin/login - Process login attempt
router.post('/login', redirectIfAdminLoggedIn, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.redirect('/admin/login?error=Email and password required.');
    }
    try {
        const user = await User.findOne({ email: email });
        if (!user || !user.isAdmin) { // Must exist and be an admin
             return res.redirect('/admin/login?error=Invalid credentials or not an admin.');
        }

        const isMatch = await user.isCorrectPassword(password);
        if (!isMatch) {
            return res.redirect('/admin/login?error=Invalid credentials.');
        }

        // Login Success - Set Session
        req.session.userId = user._id.toString();
        req.session.username = user.username;
        req.session.isAdmin = true;

        console.log(`Admin login successful for: ${user.username}`);
        res.redirect('/admin/calendar'); // Redirect to calendar after login

    } catch (err) {
        console.error("Admin login error:", err);
        res.redirect('/admin/login?error=An internal error occurred.');
    }
});

// --- Logout Route ---
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) { console.error("Error destroying session:", err); }
        res.clearCookie('connect.sid'); // Default cookie name
        res.redirect('/admin/login');
    });
});


// --- Protected Routes (Apply adminCheckMiddleware) ---
router.use(adminCheckMiddleware); // All routes defined BELOW this line are protected

// GET /admin/calendar - View Bookings Calendar Page
router.get('/calendar', (req, res) => {
    res.render('admin/view-calendar', {
        title: 'Bookings Calendar',
        // username will be available via res.locals.adminUser.username in EJS
    });
});

// API Route: GET /admin/api/calendar-bookings
router.get('/api/calendar-bookings', async (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ message: 'start and end query params are required.' });

    let startDate, endDate;
    try {
        startDate = parseISO(start);
        endDate = parseISO(end);
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) throw new Error("Invalid date format");
    } catch (dateError) { return res.status(400).json({ message: 'Invalid date format.' }); }

    console.log(`ADMIN CALENDAR API: Fetching bookings from ${startDate.toISOString()} to ${endDate.toISOString()}`);
    try {
        const bookings = await Booking.find({
            start: { $gte: startDate },
            end: { $lte: endDate },
            status: { $in: ['paid', 'confirmed'] }
        })
        .populate('user', 'username email')
        .sort({ start: 1 })
        .lean();

        const calendarEvents = bookings.map(booking => {
            let title = `${booking.serviceType.charAt(0).toUpperCase() + booking.serviceType.slice(1)}`;
            if (booking.user) title += ` - ${booking.user.username || 'Unknown'}`;
            if (booking.details?.childIndex && booking.details?.bookedQuantity > 1) title += ` (Child ${booking.details.childIndex}/${booking.details.bookedQuantity})`;
            else if (booking.details?.bookedQuantity > 1) title += ` (${booking.details.bookedQuantity} Children)`;

            return {
                id: booking._id.toString(), title, start: booking.start, end: booking.end,
                extendedProps: { /* Add any other details you want in the click popover */
                    service: booking.serviceType,
                    userEmail: booking.user?.email,
                    status: booking.status,
                }
            };
        });
        res.json(calendarEvents);
    } catch (error) {
        console.error("Error fetching for admin calendar:", error);
        res.status(500).json({ message: "Failed to fetch bookings." });
    }
});

module.exports = router;