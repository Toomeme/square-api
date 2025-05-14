// routes/users.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { signToken,authMiddleware } = require('../utils/auth');
const Booking = require('../models/Booking');
const WaiverSignature = require('../models/Waiver');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Needed for subscription status

// --- User Registration ---
router.post('/register', async (req, res) => {
    try {
        const user = await User.create(req.body);
        const token = signToken(user);
        res.json({ token, user });
    } catch (err) {
        console.error(err);
        res.status(400).json({ message: 'Registration failed', error: err.message });
    }
});

// --- User Login ---
router.post('/login', async (req, res) => {
    try {
        const user = await User.findOne({ email: req.body.email });

        if (!user) {
            return res.status(400).json({ message: "Can't find this user" });
        }

        const correctPw = await user.isCorrectPassword(req.body.password);

        if (!correctPw) {
            return res.status(400).json({ message: 'Wrong password!' });
        }

        const token = signToken(user);
        res.json({ token, user });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Login failed', error: err.message });
    }
});

// --- *** NEW: Get Logged-In User's Profile Data *** ---
// GET /api/users/me  (or /api/profile)
router.get('/me', authMiddleware, async (req, res) => {
    console.log(`--- GET USER PROFILE FOR: ${req.user._id} ---`);
    const userId = req.user._id; // Get user ID from token payload via middleware

    try {
        // 1. Fetch User data (including Stripe info, punches, membership)
        // Select only the fields needed for the profile page
        const user = await User.findById(userId)
            .select('username email openPlayPunches membershipExpiry stripeCustomerId stripeSubscriptionId') // Added Stripe IDs
            .lean(); // Use lean for read-only operations

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // 2. Fetch Upcoming Bookings (adjust date range as needed)
        const now = new Date();
        // Fetch bookings starting from today onwards, limit to maybe next 3 months?
        const futureEndDate = new Date(now);
        futureEndDate.setMonth(now.getMonth() + 3);

        const upcomingBookings = await Booking.find({
            user: userId,
            start: { $gte: now /*, $lte: futureEndDate */ }, // Find bookings starting now or later
            status: { $in: ['paid', 'confirmed'] } // Only show active bookings
        })
        .sort({ start: 1 }) // Sort by start date ascending
        .select('serviceType start end details cost') // Select relevant fields
        .limit(50) // Add a reasonable limit
        .lean();

        // 3. Fetch Subscription Status from Stripe (if user has a subscription ID)
        let subscriptionStatus = null;
        let subscriptionPeriodEnd = null;
        if (user.stripeSubscriptionId) {
             console.log(` > Fetching Stripe subscription status for ${user.stripeSubscriptionId}`);
             try {
                 const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
                 subscriptionStatus = subscription.status; // e.g., 'active', 'past_due', 'canceled'
                 subscriptionPeriodEnd = subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null;
                  console.log(` > Subscription Status: ${subscriptionStatus}`);
             } catch (stripeError) {
                  console.error(`WARN: Failed to retrieve Stripe subscription ${user.stripeSubscriptionId}:`, stripeError.message);
                   // Handle cases where subscription might be deleted in Stripe but ID still exists in DB
                   if (stripeError.code === 'resource_missing') {
                        subscriptionStatus = 'not_found_in_stripe';
                        // Optionally: Clean up the stale stripeSubscriptionId from the user record here
                        // await User.findByIdAndUpdate(userId, { $unset: { stripeSubscriptionId: "" }});
                   } else {
                       subscriptionStatus = 'error_fetching';
                   }
             }
        }

        // 4. Combine data into response object
        const profileData = {
            user: {
                username: user.username,
                email: user.email,
                openPlayPunches: user.openPlayPunches,
                membershipExpiry: user.membershipExpiry, // Send as ISO string or formatted date
                hasActiveSubscription: !!user.stripeSubscriptionId, // Indicate if a sub ID exists
                subscriptionStatus: subscriptionStatus, // Send status from Stripe
                subscriptionPeriodEnd: subscriptionPeriodEnd, // Send billing cycle end
            },
            upcomingBookings: upcomingBookings,
        };

        res.json(profileData);

    } catch (error) {
        console.error(`Error fetching profile data for user ${userId}:`, error);
        res.status(500).json({ message: 'Error fetching profile information.' });
    }
});

router.post('/sign-waiver', authMiddleware, async (req, res) => {
    console.log(`--- POST /api/users/sign-waiver for User: ${req.user._id} ---`);
    const { signedName, agreedToTerms, waiverVersion } = req.body;
    const userId = req.user._id; // From authMiddleware

    if (!signedName || typeof signedName !== 'string' || signedName.trim().length < 3) {
        return res.status(400).json({ message: 'Valid full name is required for signature.' });
    }
    if (agreedToTerms !== true) { // Explicitly check for true
        return res.status(400).json({ message: 'You must agree to the terms to proceed.' });
    }

    try {
        // Optional: Check if this user has already signed this version of the waiver
        // This depends on your business logic (e.g., if they need to re-sign for new versions)
        const existingSignature = await WaiverSignature.findOne({
            user: userId,
            waiverVersion: waiverVersion || '1.0' // Use provided version or default
        });

        if (existingSignature) {
            console.log(`User ${userId} has already signed waiver version ${existingSignature.waiverVersion}. Allowing proceed.`);
            // If they already signed, you might just return success without creating a new record,
            // or you might update the timestamp on the existing one.
            // For simplicity, we'll allow them to "re-affirm" by creating a new record if you want an audit for each session,
            // or just return success. Let's return success if already signed.
            return res.status(200).json({ message: 'Waiver already on file and acknowledged.', signature: existingSignature });
        }

        const newSignature = new WaiverSignature({
            user: userId,
            signedName: signedName.trim(),
            agreedToTerms: true,
            waiverVersion: waiverVersion || '1.0', // Store a version
            // Optional: Capture IP and User-Agent
            ipAddress: req.ip || req.socket?.remoteAddress,
            userAgent: req.headers['user-agent']
        });

        await newSignature.save();

        // Optional: Update a flag on the User model itself
        await User.findByIdAndUpdate(userId, { hasSignedWaiver: true, lastWaiverSignDate: new Date() });

        console.log(`Waiver signed and recorded for user ${userId}, signature ID: ${newSignature._id}`);
        res.status(201).json({ message: 'Waiver signed successfully.', signatureId: newSignature._id });

    } catch (error) {
        console.error('Error saving waiver signature:', error);
        // Handle potential duplicate key error if you have a unique index and don't want duplicates
        if (error.code === 11000) {
            return res.status(409).json({ message: 'Waiver signature for this version already exists for this user.' });
        }
        res.status(500).json({ message: 'Failed to record waiver signature.' });
    }
});

module.exports = router;