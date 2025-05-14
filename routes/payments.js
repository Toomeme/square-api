// routes/payments.js
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { authMiddleware } = require('../utils/auth');
const User = require('../models/User');
const pricing = require('../services/pricing'); // Your pricing service
const Holiday = require('../models/Holiday');
const { format } = require('date-fns-tz'); // For date manipulation
const { addWeeks,parseISO } = require('date-fns');

router.post('/create-checkout-session', authMiddleware, async (req, res) => {
    console.log("--- CREATE UNIFIED CHECKOUT SESSION ---");
    const userId = req.user._id;
    const {
        serviceType,
        // Playgroup specific (for ROLLING enrollment)
        startDate: playgroupStartDateString, // NEW: YYYY-MM-DD
        durationWeeks: playgroupDurationWeeks,
        daysPerWeekBitmask,
        scheduleIds,
        paymentType, // 'full' or 'installment'
        // Open Play / Birthday specific (keep these)
        selectedSlot, openPlayOption, partyDuration,
        // itemsToBook // If you implemented a full cart for OpenPlay/Birthday
    } = req.body;

    console.log("Request Body for Checkout:", req.body);

    try {
        // --- Find or Create Stripe Customer ---
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "User not found." });

        let stripeCustomerId = user.stripeCustomerId;
        if (!stripeCustomerId) {
            console.log(`Creating Stripe Customer for user ${userId}`);
            const customer = await stripe.customers.create({
                email: user.email, name: user.username, metadata: { appUserId: userId }
            });
            stripeCustomerId = customer.id;
            user.stripeCustomerId = stripeCustomerId;
            await user.save(); // Save immediately
            console.log(`Stripe Customer created: ${stripeCustomerId}`);
        } else {
            console.log(`Using existing Stripe Customer: ${stripeCustomerId}`);
        }

        // --- Define common checkout session parameters ---
        const successUrl = process.env.STRIPE_SUCCESS_URL || 'https://collie-star-wf2t.squarespace.com/booking-success'; // Use env var
        const cancelUrl = process.env.STRIPE_CANCEL_URL || 'https://collie-star-wf2t.squarespace.com/booking-cancelled'; // Use env var
        let line_items = [];
        let mode = 'payment'; // Default to one-time payment
        let subscription_data = undefined;
        let metadata = { // Common metadata
            appUserId: userId.toString(),
            serviceType: serviceType,
        };

        // --- Configure based on Service Type and Payment Type ---

        if (serviceType === 'playgroup') {
            if (!playgroupStartDateString || !playgroupDurationWeeks || daysPerWeekBitmask === undefined || !scheduleIds || !paymentType) {
                 return res.status(400).json({ message: "Missing playgroup details for rolling enrollment." });
            }

            const enrollmentStartDate = parseISO(playgroupStartDateString); // Parse to Date object (UTC midnight)
            if (isNaN(enrollmentStartDate.getTime())) return res.status(400).json({ message: 'Invalid playgroup start date format.' });

            const parsedDuration = parseInt(playgroupDurationWeeks, 10);
            if (isNaN(parsedDuration) || parsedDuration <= 0) return res.status(400).json({ message: 'Invalid playgroup duration format.' });

            // Calculate end date for this 6-week block
            const enrollmentEndDate = addWeeks(enrollmentStartDate, parsedDuration);
            enrollmentEndDate.setDate(enrollmentEndDate.getDate() - 1); // Inclusive end

            // Store calculated dates and original selections in metadata
            metadata.bookingType = `playgroup_rolling_${paymentType}`;
            metadata.enrollmentStartDate = format(enrollmentStartDate, 'yyyy-MM-dd'); // Store as string
            metadata.enrollmentEndDate = format(enrollmentEndDate, 'yyyy-MM-dd');   // Store as string
            metadata.scheduleIds = JSON.stringify(scheduleIds);
            metadata.daysPerWeekBitmask = daysPerWeekBitmask;
            // numberOfDaysSelected can be recalculated or passed in metadata if needed by Stripe Description
            let numberOfDaysSelected = 0; let tempMask = daysPerWeekBitmask;
            while (tempMask > 0) { tempMask &= (tempMask - 1); numberOfDaysSelected++; }
            metadata.daysPerWeek = numberOfDaysSelected;
            metadata.durationWeeks = parsedDuration;


            // --- Calculate Cost for the 6-week block (SERVER-SIDE) ---
            const holidays = await Holiday.find({ date: { $gte: enrollmentStartDate, $lte: enrollmentEndDate } }).lean();
            const holidayDates = holidays.map(h => h.date);
            const costDetails = pricing.calculateRollingPlaygroupCost(
                numberOfDaysSelected,
                daysPerWeekBitmask,
                paymentType,
                holidayDates,
                enrollmentStartDate, // This is a Date object
                parsedDuration       // This should be a number (e.g., 6 or 12)
            );
            if (costDetails.error) throw new Error(`Cost calculation failed: ${costDetails.error}`);
            const totalCostForBlockInCents = Math.round(costDetails.totalActualCost * 100);
            if (totalCostForBlockInCents <= 0 && paymentType === 'full') throw new Error("Calculated amount for full payment is zero or less.");
            if (totalCostForBlockInCents < Math.round(costDetails.registrationFee * 100) && paymentType === 'installment') throw new Error("Calculated installment amount is less than registration fee.");

            metadata.calculatedTotalAmount = totalCostForBlockInCents; // For webhook reference


            if (paymentType === 'installment') {
                mode = 'subscription';
                console.log(`Setting up ROLLING Playgroup $0 SUBSCRIPTION + Reg Fee`);

                const zeroSubPriceId = process.env.STRIPE_PRICE_ID_ZERO_INSTALLMENT_PLACEHOLDER;
                const regFeePriceId = process.env.STRIPE_PRICE_ID_REGISTRATION_FEE;
                if (!zeroSubPriceId || !regFeePriceId) throw new Error("Stripe Price IDs for installment/reg fee not configured.");

                // For installments, calculate number of installments (e.g., 2 for 6 weeks)
                const numInstallments = 3; // Example: 2 installments for 6 weeks
                const classCostOnly = totalCostForBlockInCents - Math.round(costDetails.registrationFee * 100); // Cost excluding reg fee
                const baseInstallmentAmount = Math.floor(classCostOnly / numInstallments);
                const remainder = classCostOnly % numInstallments;
                const firstInstallmentAmount = baseInstallmentAmount + remainder; // First installment might be larger
                metadata.numInstallments = numInstallments;
                metadata.installmentAmount = baseInstallmentAmount; // Base for subsequent
                metadata.firstInstallmentAmount = firstInstallmentAmount; // For webhook to potentially use for 1st InvoiceItem

                line_items.push(
                    { price: zeroSubPriceId, quantity: 1 },
                    { price: regFeePriceId, quantity: 1 }
                    // Optional: Could add the first 'class cost' installment here as a one-time item
                    // { price_data: { currency: 'usd', product_data: { name: "First Playgroup Installment" }, unit_amount: firstInstallmentAmount }, quantity: 1 }
                );
                subscription_data = { metadata: { appUserId: userId.toString(), daysPerWeek: numberOfDaysSelected } };

            } else { // 'full' payment
                mode = 'payment';
                line_items.push({
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: `Playgroup Rolling Enrollment (${parsedDuration} Weeks - ${numberOfDaysSelected} Day/Wk)`,
                            description: `Starts: ${format(enrollmentStartDate, 'yyyy-MM-dd')}, Ends: ${format(enrollmentEndDate, 'yyyy-MM-dd')}`,
                        },
                        unit_amount: totalCostForBlockInCents,
                    },
                    quantity: 1,
                });
            }
        } else if (serviceType === 'openplay') {
             if (!openPlayOption) return res.status(400).json({ message: "Missing Open Play option." });
             mode = 'payment'; // All open play options are one-time payments
             metadata.openPlayOption = openPlayOption;

             let amountInCents = 0;
             let productName = 'Open Play';
             const quantity = (openPlayOption === 'dropin' && selectedSlot && selectedSlot.quantity) ? parseInt(selectedSlot.quantity, 10) : 1;
             switch (openPlayOption) {
                 case 'dropin':
                     if (!selectedSlot) return res.status(400).json({ message: "Selected slot required for drop-in." });
                     amountInCents = 15 * 100; // $15
                     productName = 'Open Play Drop-in';
                     metadata.bookingType = 'openplay_dropin';
                     metadata.slotStart = selectedSlot.start;
                     metadata.slotEnd = selectedSlot.end;
                     metadata.originalItemDetails = JSON.stringify(selectedSlot);
                     break;
                 case 'punchcard':
                     amountInCents = 120 * 100; // $120
                     productName = 'Open Play 10-Visit Punch Card';
                      metadata.bookingType = 'openplay_purchase'; // Use specific type
                     break;
                 case 'membership':
                     amountInCents = 99 * 100; // $99
                     productName = 'Open Play Monthly Membership';
                      metadata.bookingType = 'openplay_purchase'; // Use specific type
                     break;
                 default: throw new Error(`Invalid openPlayOption: ${openPlayOption}`);
             }
             if (amountInCents <= 0) throw new Error("Amount for Open Play option is invalid.");

             line_items.push({
                 price_data: {
                     currency: 'usd', product_data: { name: productName }, unit_amount: amountInCents,
                 }, quantity: quantity,
             });
             metadata.calculatedAmount = amountInCents;

        } else if (serviceType === 'birthday') {
            if (!selectedSlot || !partyDuration) return res.status(400).json({ message: "Missing birthday party details." });
            mode = 'payment';
            metadata.bookingType = 'birthday';
            metadata.slotStart = selectedSlot.start;
            metadata.slotEnd = selectedSlot.end;
            metadata.partyDuration = partyDuration;

            let amountInCents = 0;
            if (partyDuration === 2) {
                amountInCents = 275 * 100; // $275
            } else { throw new Error(`Unsupported party duration: ${partyDuration}`); } // Add more durations if needed

            if (amountInCents <= 0) throw new Error("Amount for Birthday Party is invalid.");

            line_items.push({
                 price_data: {
                     currency: 'usd', product_data: { name: `Birthday Party (${partyDuration} hours)` }, unit_amount: amountInCents,
                 }, quantity: 1,
            });
            metadata.calculatedAmount = amountInCents;

        } else {
            return res.status(400).json({ message: `Unsupported service type: ${serviceType}` });
        }

        // --- Create the Stripe Checkout Session ---
        console.log(`Creating Checkout Session: Mode=${mode}, Items=`, line_items.length);
        const sessionConfig = {
            payment_method_types: ['card'], // Add others? e.g., 'us_bank_account'
            mode: mode,
            customer: stripeCustomerId,
            line_items: line_items,
            success_url: successUrl + '?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: cancelUrl,
            metadata: metadata, // CRITICAL for webhook fulfillment
        };

        // Add subscription_data only if mode is 'subscription'
        if (mode === 'subscription') {
            sessionConfig.subscription_data = subscription_data;
        }

        const checkoutSession = await stripe.checkout.sessions.create(sessionConfig);

        console.log("Stripe Checkout Session created:", checkoutSession.id);
        res.json({ sessionId: checkoutSession.id }); // Return session ID to frontend

    } catch (error) {
        console.error('Error creating checkout session:', error);
        // Provide a more user-friendly message if possible
        const userMessage = error.message.includes("Price ID not configured") || error.message.includes("Invalid number of days")
            ? error.message // Show config errors directly
            : 'Failed to initiate payment setup. Please try again or contact support.';
        res.status(500).json({ message: userMessage });
    }
});

// POST /api/payments/assign-test-clock-customer
router.post('/assign-test-clock-customer', authMiddleware, async (req, res) => { // Use authMiddleware if you want to ensure only logged-in users can assign to themselves
    const { testClockId } = req.body;
    const userId = req.user._id; // Get ID of the currently logged-in test user

    if (!testClockId || !testClockId.startsWith('clock_')) {
        return res.status(400).json({ message: 'Valid testClockId starting with tc_ is required.' });
    }

    console.log(`TESTING: Attempting to assign clock ${testClockId} to user ${userId}`);

    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: "App User not found." });
        }

        // Check if user ALREADY has a Stripe Customer ID - handle if necessary (e.g., error out, or decide to overwrite?)
        if (user.stripeCustomerId) {
             console.warn(`TESTING: User ${userId} already has Stripe Customer ID ${user.stripeCustomerId}. Overwriting for test clock assignment.`);
             // You might want to delete the old Stripe customer object here if desired, but be careful.
             // For testing, overwriting the ID in your DB might be sufficient.
        }


        // Create NEW Stripe Customer linked to the Test Clock
        console.log(`TESTING: Creating new Stripe Customer with clock ${testClockId} for user ${userId}`);
        const customer = await stripe.customers.create({
            email: user.email,
            name: `${user.username} (Test Clock)`, // Add suffix for clarity
            test_clock: testClockId, // *** Associate clock here ***
            metadata: {
                appUserId: userId.toString() // Link back to your user
            }
        });
        const newStripeCustomerId = customer.id;
        console.log(`TESTING: Stripe Customer created: ${newStripeCustomerId}`);

        // Save the NEW Stripe Customer ID to YOUR User document
        user.stripeCustomerId = newStripeCustomerId;
        await user.save();
        console.log(`TESTING: Successfully saved Stripe Customer ID ${newStripeCustomerId} with clock ${testClockId} to User ${userId}`);

        res.json({
            message: `Successfully created/assigned Stripe Customer ${newStripeCustomerId} with Test Clock ${testClockId} to User ${userId}`,
            userId: userId,
            stripeCustomerId: newStripeCustomerId,
            testClockId: testClockId
        });

    } catch (error) {
        console.error("Error assigning test clock customer:", error);
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;