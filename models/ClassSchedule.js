// models/ClassSchedule.js
const mongoose = require('mongoose');

const classScheduleSchema = new mongoose.Schema({
    serviceType: { type: String, required: true }, // e.g., 'playgroup'
    dayOfWeek: { type: Number, required: true }, // 0 = Sunday, 1 = Monday, ...
    startTime: { type: String, required: true }, // e.g., "09:00"
    endTime: { type: String, required: true },   // e.g., "10:00"
});

module.exports = mongoose.model('ClassSchedule', classScheduleSchema);