const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Booking = require('../models/Booking'); // Import your Booking model

router.post('/create-payment-intent', async (req, res) => {
    const { bookingId } = req.body; // Get the booking ID from the request

    try {
        // 1. Retrieve the booking and calculate the total amount
        const booking = await Booking.findById(bookingId).populate('class');
        if (!booking) {
            return res.status(404).json({ message: 'Booking not found' });
        }
        const amount = booking.class.price * 100; // Convert to cents

        // 2. Create a PaymentIntent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount,
            currency: 'usd', // Or your preferred currency
            // Add metadata for your records (optional)
            metadata: {
                bookingId: bookingId,
            },
        });

        // 3. Send the client secret to the frontend
        res.json({ clientSecret: paymentIntent.client_secret });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error creating payment intent' });
    }
});

// Webhook endpoint for Stripe to notify you of payment events (VERY IMPORTANT)
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
            // Update your booking status to "paid"
            const bookingId = paymentIntent.metadata.bookingId;
            await Booking.findByIdAndUpdate(bookingId, { status: 'paid' });
            console.log('PaymentIntent was successful!');
            break;
        case 'payment_intent.payment_failed':
            // Handle payment failure (e.g., notify the user)
            console.log('PaymentIntent failed!');
            break;
        // ... handle other event types
        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    // Return a 200 response to acknowledge receipt of the event
    res.json({received: true});
});

module.exports = router;