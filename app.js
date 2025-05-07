require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');
const connectDB = require('./config/db');
const bookingRoutes = require('./routes/bookings');
const paymentRoutes = require('./routes/payments');
const publicUserRoutes = require('./routes/users'); // Renamed for clarity
const pricingRoutes = require('./routes/pricing');
const classScheduleRoutes = require('./routes/classSchedules');
const adminRoutes = require('./routes/adminRoutes'); // Combined admin routes
//const adminApiRoutes = require('./routes/bookings');

const cron = require('node-cron');
const User = require('./models/User'); // Adjust path
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

app.set('trust proxy', 1);
const port = process.env.PORT || 3001;

// Connect to Database
connectDB();

// Middleware
app.use(cors());
app.use('/api/bookings/webhook', express.raw({ type: 'application/json' }), bookingRoutes);
app.use(express.json()); // Replace bodyParser.json()
app.use(express.urlencoded({ extended: true }));
// --- Session Middleware (Configure BEFORE routes that use it) ---
if (!process.env.SESSION_SECRET) {
    console.error("FATAL ERROR: SESSION_SECRET environment variable is not set.");
    process.exit(1);
}
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI, collectionName: 'admin_sessions' }), // Use distinct collection
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 8, // 8 hours
        // sameSite: 'lax' // Good for security
    }
}));

// --- Templating Engine Setup (EJS) ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); // 'views' folder in root


// Routes
app.use('/api/bookings', bookingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/users', publicUserRoutes); // For Squarespace user registration/login
app.use('/api/pricing', pricingRoutes);
app.use('/api/class-schedules', classScheduleRoutes);
// --- Admin Routes (View and API combined, prefix with /admin) ---
app.use('/admin', adminRoutes); // This handles /admin/login, /admin/calendar, /admin/api/calendar-bookings etc.
// --- Basic Root/Error Handling ---
app.get('/', (req, res) => { res.send('API Running. Admin panel at /admin/login'); });
// 404 for other /api paths
app.use('/api/*', (req, res) => res.status(404).json({ message: 'API endpoint not found.' }));
// Basic Error Handling
app.use((err, req, res, next) => {
    console.error("Global Error Handler:", err.stack);
    res.status(err.status || 500).json({ message: err.message || 'Something broke!' });
});

cron.schedule('5 2 * * *', async () => {
    console.log(`\n=== CRON JOB: Running daily check for subscriptions to cancel @ ${new Date().toISOString()} ===`);
    try {
        // Find users with active subscriptions where installments MAY have run out
        // We check remaining <= 0 in case something went wrong and it went negative
        const usersToCheck = await User.find({
            stripeSubscriptionId: { $exists: true, $ne: null, $ne: "" },
            playgroupInstallmentsRemaining: { $exists: true, $lte: 0 } // Find where counter is 0 or less
        }).select('stripeSubscriptionId');

        if (usersToCheck.length === 0) {
             console.log('CRON: No users found with 0 or fewer remaining installments.');
             return; // Exit if none found
        }

        console.log(`CRON: Found ${usersToCheck.length} user(s) with <= 0 remaining installments. Verifying subscription status...`);

        for (const user of usersToCheck) {
            const subId = user.stripeSubscriptionId;
            if (!subId) continue; // Skip if somehow subId is missing

            try {
                console.log(`CRON: Checking subscription ${subId} for user ${user._id}...`);
                const subscription = await stripe.subscriptions.retrieve(subId);

                // Check if it's active and NOT already scheduled to cancel
                if (subscription && subscription.status === 'active' && !subscription.cancel_at_period_end) {
                    console.log(`CRON: Scheduling subscription ${subId} to cancel at period end (found via daily check).`);
                    await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
                } else {
                     console.log(`CRON: Subscription ${subId} status is '${subscription?.status}' or already cancelling. No action needed.`);
                }
            } catch (error) {
                 if (error.code === 'resource_missing') {
                    // Subscription doesn't exist in Stripe anymore - clean up DB record
                    console.warn(`CRON: Subscription ${subId} not found in Stripe. Cleaning up stale ID for user ${user._id}.`);
                    await User.updateOne({ _id: user._id, stripeSubscriptionId: subId }, { // Ensure we only update the correct user
                       $unset: {
                           stripeSubscriptionId: "",
                           playgroupInstallmentAmount: "",
                           playgroupInstallmentsRemaining: "",
                           playgroupTotalSemesterCost: "",
                           playgroupTotalInstallments: ""
                       }
                    });
                 } else {
                    // Log other errors but continue checking other users
                    console.error(`CRON: Error processing subscription ${subId} for user ${user._id}:`, error.message);
                 }
            }
        } // End for loop
        console.log('=== CRON JOB: Daily subscription check finished ===');
    } catch (error) {
        console.error('=== CRON JOB: Error during daily subscription check execution: ===', error);
    }
}, {
    scheduled: true,
    timezone: "America/New_York" // Optional: Specify timezone for schedule
});

console.log("CRON Job for subscription cleanup scheduled.");
// --- *** END NODE-CRON SETUP *** ---


app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});