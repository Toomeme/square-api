// models/Booking.js
const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    serviceType: { type: String, required: true, enum: ['playgroup', 'openplay', 'birthday'] },
    cost: { type: Number, required: true },
    details: { type: Object, required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'paid', 'confirmed', 'cancelled', 'failed', 'cancelled_payment_failed', 'cancelled_subscription'], default: 'pending' }, // Keep statuses
    paymentIntentId: { type: String, index: true },
    // details.subscriptionId is used for subscription link now
}, { timestamps: true });

bookingSchema.index({ start: 1, end: 1, serviceType: 1, status: 1 });

module.exports = mongoose.model('Booking', bookingSchema);