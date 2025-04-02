const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // Ensure required
    serviceType: { type: String, required: true, enum: ['playgroup', 'openplay', 'birthday'] },
    cost: { type: Number, required: true }, // Store the cost paid for this specific booking (can be 0 for semester items if cost stored elsewhere)
    details: { type: Object, required: true }, // Can store semester details, pricing breakdown, etc.
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    googleCalendarEventId: { type: String },
    status: { type: String, enum: ['pending', 'paid', 'confirmed', 'cancelled', 'failed'], default: 'pending' }, // Added 'failed'
    paymentIntentId: { type: String, index: true }, // Added to link to Stripe payment
    // Optional: Link semester bookings together
    // semesterGroupId: { type: mongoose.Schema.Types.ObjectId },
}, { timestamps: true });

// Add index for faster lookups during capacity checks
bookingSchema.index({ start: 1, end: 1, serviceType: 1, status: 1 });

module.exports = mongoose.model('Booking', bookingSchema);