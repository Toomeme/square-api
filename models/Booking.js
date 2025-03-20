const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Corrected reference
    serviceType: { type: String, required: true, enum: ['playgroup', 'openplay', 'birthday'] },
    cost: { type: Number, required: true },
    details: { type: Object, required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    googleCalendarEventId: { type: String },
    status: { type: String, enum: ['pending', 'paid', 'confirmed', 'cancelled'], default: 'pending' }
}, { timestamps: true });

module.exports = mongoose.model('Booking', bookingSchema);