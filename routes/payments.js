// routes/payments.js
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { authMiddleware } = require('../utils/auth'); // Protect this route
const User = require('../models/User');
const pricing = require('../services/pricing'); // May need pricing service for validation/lookup
const Holiday = require('../models/Holiday');

router.post('/create-checkout-session', authMiddleware, async (req, res) => {
    console.log("--- CREATE UNIFIED CHECKOUT SESSION ---");
    const userId = req.user._id;
    const {
        // Common fields
        serviceType, // 'playgroup', 'openplay', 'birthday'
        // Playgroup specific
        paymentType, // 'full' or 'installment'
        semesterDetails, // { start, end }
        daysPerWeekBitmask, // For selecting price tier
        scheduleIds, // Array of ClassSchedule._id strings
        // Open Play / Birthday specific
        selectedSlot, // { start, end } ISO strings for drop-in/birthday
        openPlayOption, // 'dropin', 'punchcard', 'membership'
        partyDuration, // e.g., 2 for birthday
    } = req.body;

    console.log("Request Body:", req.body); // Log incoming data

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
            if (!semesterDetails || !daysPerWeekBitmask || !scheduleIds || !paymentType) {
                 return res.status(400).json({ message: "Missing playgroup details for checkout." });
            }
            metadata.bookingType = `playgroup_${paymentType}`; // e.g., playgroup_full, playgroup_installment
            metadata.semesterStart = semesterDetails.start;
            metadata.semesterEnd = semesterDetails.end;
            metadata.scheduleIds = JSON.stringify(scheduleIds); // Store as JSON string
            metadata.daysBitmask = daysPerWeekBitmask;

            // Calculate numberOfDaysSelected from bitmask
            let numberOfDaysSelected = 0; let tempMask = daysPerWeekBitmask;
            while (tempMask > 0) { tempMask &= (tempMask - 1); numberOfDaysSelected++; }
            metadata.daysPerWeek = numberOfDaysSelected; // Add for clarity in webhook

            if (paymentType === 'installment') {
                mode = 'subscription';
                console.log(`Setting up $0 SUBSCRIPTION + Reg Fee`);

                // --- Use the $0 Placeholder Price ID ---
                const zeroSubPriceId = process.env.STRIPE_PRICE_ID_ZERO_INSTALLMENT_PLACEHOLDER; // e.g., price_zero_monthly
                if (!zeroSubPriceId) throw new Error("Stripe $0 Price ID not configured.");

                // --- Use the Registration Fee Price ID ---
                const regFeePriceId = process.env.STRIPE_PRICE_ID_REGISTRATION_FEE; // e.g., price_reg_fee
                if (!regFeePriceId) throw new Error("Stripe Registration Fee Price ID not configured.");

                console.log("WH: Calculating installment details for metadata...");
                const holidays = await Holiday.find({ date: { $gte: new Date(semesterDetails.start), $lte: new Date(semesterDetails.end) } });
                const holidayDates = holidays.map(h => new Date(h.date));
                const costDetails = pricing.calculatePlayGroupCost(
                    numberOfDaysSelected, daysPerWeekBitmask, 'full', // Use 'full' to get base class cost
                    new Date(semesterDetails.start), new Date(semesterDetails.end), holidayDates
                );
                if (costDetails.error) throw new Error(`Cost calculation failed: ${costDetails.error}`);

                const totalCostInCents = Math.round(costDetails.totalActualCost * 100);
                // Determine Number of Installments (Example: 4) - Adjust as needed
                let numInstallments = 4; // Or calculate based on semester duration
                 if (numInstallments <= 0) numInstallments = 1;
                const baseInstallmentAmount = Math.floor(totalCostInCents / numInstallments);
                const remainder = totalCostInCents % numInstallments;
                 // Calculate first installment amount if you want to handle remainder upfront
                 const firstInstallmentAmount = baseInstallmentAmount + remainder;
                 console.log(`Calc Results: Total=${totalCostInCents}, NumInst=${numInstallments}, BaseInst=${baseInstallmentAmount}, FirstInst=${firstInstallmentAmount}`);

                line_items.push(
                    {
                        // Instead of price: zeroSubPriceId, use price_data for display clarity
                        price_data: {
                            currency: 'usd',
                            product_data: {
                                name: `Playgroup Semester Installment Plan (${numberOfDaysSelected} Day/Wk)`,
                                description: `Covers ${numInstallments} monthly payments for the semester cost.`, // Add description
                            },
                            // STILL $0 for the recurring part itself
                            unit_amount: 0,
                            recurring: {
                                interval: 'month', // Or your interval
                            },
                        },
                        quantity: 1,
                    },
                    // Separate line item for the one-time Registration Fee
                    {
                        price: regFeePriceId, // Use the predefined Price for the fee
                        quantity: 1
                    }
                    // Potential: Add the *first* installment amount as another one-time item?
                    // This makes the initial charge clearer but complicates webhook logic slightly.
                    // {
                    //     price_data: {
                    //         currency: 'usd',
                    //         product_data: { name: "First Installment (of "+numInstallments+")" },
                    //         unit_amount: firstInstallmentAmount, // First installment amount in cents
                    //     },
                    //     quantity: 1,
                    // }
                );
                
                // Metadata still needed for backend calculation
                metadata.numInstallments = numInstallments;
                metadata.installmentAmount = baseInstallmentAmount; // Store base amount
                metadata.firstInstallmentAmount = firstInstallmentAmount; // Store first amount if different
                metadata.totalSemesterCost = totalCostInCents; // Store total for reference
                
                subscription_data = {
                    metadata: { appUserId: userId.toString(), daysPerWeek: numberOfDaysSelected }
                    // Optional: Could set 'cancel_at_period_end' or specific 'cancel_at' date
                    // based on numInstallments if you know the exact end date.
                };

            } else {
                // --- One-Time Payment Mode (Full Semester) ---
                mode = 'payment';
                console.log(`Setting up ONE-TIME payment for full semester (${numberOfDaysSelected} days/week)`);

                // SERVER-SIDE COST CALCULATION (Essential for security)
                const holidays = await Holiday.find({ date: { $gte: new Date(semesterDetails.start), $lte: new Date(semesterDetails.end) } });
                const holidayDates = holidays.map(h => new Date(h.date));
                const costDetails = pricing.calculatePlayGroupCost(
                    numberOfDaysSelected, daysPerWeekBitmask, 'full', // Use 'full' type for calc
                    new Date(semesterDetails.start), new Date(semesterDetails.end), holidayDates
                );
                if (costDetails.error) throw new Error(costDetails.error);
                const amountInCents = Math.round(costDetails.totalActualCost * 100);

                if (amountInCents <= 0) throw new Error("Calculated amount for full payment is zero or less.");

                // Create line item using price_data for one-time charge
                line_items.push({
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: `Playgroup Semester (Full) - ${numberOfDaysSelected} Day(s)/Wk`,
                            description: `Semester: ${semesterDetails.start} to ${semesterDetails.end}`,
                        },
                        unit_amount: amountInCents, // Amount for the entire semester
                    },
                    quantity: 1,
                });
                 metadata.calculatedAmount = amountInCents; // Store for webhook reference/validation
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