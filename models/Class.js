const mongoose = require('mongoose');

const classSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: { type: String, required: true },
    date: { type: Date, required: true },
    time: { type: String, required: true },
    duration: { type: Number, required: true }, // in minutes
    capacity: { type: Number, required: true },
    price: { type: Number, required: true },
    instructor: { type: String },
    location: { type: String },
    // Add other relevant fields
});

module.exports = mongoose.model('Class', classSchema);