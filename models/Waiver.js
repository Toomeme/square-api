// models/WaiverSignature.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const waiverSignatureSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    signedName: { // The name the user typed
        type: String,
        required: true,
        trim: true,
    },
    agreedToTerms: { // To confirm the checkbox was checked
        type: Boolean,
        required: true,
        default: false,
    },
    waiverVersion: { // In case your waiver text changes over time
        type: String,
        default: '1.0', // Or a date like '2024-07-16'
    },
    ipAddress: { // Optional, for additional audit, consider privacy implications
        type: String,
    },
    userAgent: { // Optional, for additional audit
        type: String,
    }
}, {
    timestamps: true // Adds createdAt and updatedAt automatically
});

// Optional: Ensure a user can only sign a specific version once, if needed
// waiverSignatureSchema.index({ user: 1, waiverVersion: 1 }, { unique: true });

const WaiverSignature = mongoose.model('WaiverSignature', waiverSignatureSchema);

module.exports = WaiverSignature;