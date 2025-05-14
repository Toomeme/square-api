const { isBefore, startOfDay, addWeeks, eachDayOfInterval, getDay } = require('date-fns');

// services/pricing.js
function calculateRollingPlaygroupCost(numberOfDaysSelected, daysPerWeekBitmask, paymentType, holidays, enrollmentStartDate, durationWeeks,)
    {
    let sessionCost;

    if (durationWeeks === 6) {
        // Pricing for a 6-week block
        if (numberOfDaysSelected === 1) sessionCost = 55; // Example: Higher per-session for shorter commitment
        else if (numberOfDaysSelected === 2) sessionCost = 48;
        else if (numberOfDaysSelected === 3) sessionCost = 44;
        else if (numberOfDaysSelected >= 4) sessionCost = 40;
        else return { error: "Invalid number of days selected (1-5)." };
    } else if (durationWeeks === 12) {
        // Pricing for a 12-week block (potentially lower per-session)
        if (numberOfDaysSelected === 1) sessionCost = 50;
        else if (numberOfDaysSelected === 2) sessionCost = 44;
        else if (numberOfDaysSelected === 3) sessionCost = 40;
        else if (numberOfDaysSelected >= 4) sessionCost = 38;
        else return { error: "Invalid number of days selected (1-5)." };
    } else {
        return { error: `Unsupported duration: ${durationWeeks} weeks. Only 6 or 12 weeks allowed.` };
    }

    let registrationFee = 25;
    if (paymentType === 'full') {
        registrationFee = 0;
    }

    // 1. Calculate *potential* sessions (ignoring holidays)
    const enrollmentEndDate = addWeeks(enrollmentStartDate, durationWeeks);
    enrollmentEndDate.setDate(enrollmentEndDate.getDate() - 1);
    let potentialSessions = 0;
    let currentDate = new Date(enrollmentStartDate);
    const today = startOfDay(new Date());

    while (currentDate <= enrollmentEndDate) {
        const dayOfWeek = currentDate.getDay();
        // Check if this day of the week is one of the selected days
        if (isDaySelected(dayOfWeek, daysPerWeekBitmask)) {
            potentialSessions++;
        }
        currentDate.setDate(currentDate.getDate() + 1); // Move to the next day
    }

    // 2. Calculate *actual* sessions (excluding holidays)
    let actualSessions = 0;
    currentDate = new Date(enrollmentStartDate); // Reset currentDate

    while (currentDate <= enrollmentEndDate) {
        const dayOfWeek = currentDate.getDay();
        const isPastDate = isBefore(startOfDay(currentDate), today);
        if (isDaySelected(dayOfWeek, daysPerWeekBitmask) && !isHoliday(currentDate, holidays) &&
        !isPastDate) {
            actualSessions++;
        }
        currentDate.setDate(currentDate.getDate() + 1);
    }

    // 3. Calculate costs
    const totalPotentialCost = sessionCost * potentialSessions; // Use potential sessions for tiered pricing
    const totalActualCost = sessionCost * actualSessions + registrationFee;

    return {
        sessionCost: sessionCost,
        registrationFee: registrationFee,
        totalPotentialCost: totalPotentialCost, // Cost based on tiered pricing
        totalActualCost: totalActualCost,   // Actual cost to be charged
        potentialSessions: potentialSessions,
        actualSessions: actualSessions,
    };
}

// Helper function to check if a day of the week is selected
function isDaySelected(dayOfWeek, daysPerWeekBitmask) {
    // Use a bitmask to represent the days of the week.
    // Each bit corresponds to a day:
    //  Sunday:   1 (2^0)
    //  Monday:   2 (2^1)
    //  Tuesday:  4 (2^2)
    //  Wednesday: 8 (2^3)
    //  Thursday: 16 (2^4)
    //  Friday:  32 (2^5)
    //  Saturday: 64 (2^6)

    const dayMap = [1, 2, 4, 8, 16, 32, 64];

    // Check if the bit corresponding to dayOfWeek is set in daysPerWeek.
    return (dayMap[dayOfWeek] & daysPerWeekBitmask) !== 0;
}


// Helper function to check if a date is a holiday
function isHoliday(date, holidays) {
    return holidays.some(holiday => {
        return holiday.getDate() === date.getDate() &&
               holiday.getMonth() === date.getMonth() &&
               holiday.getFullYear() === date.getFullYear();
    });
}

// --- Open Play Pricing ---
function calculateOpenPlayCost(option, quantity = 1) {
    // quantity is only relevant for the punch card
    let cost;

    switch (option) {
        case 'dropin':
            cost = 15;
            break;
        case 'punchcard':
            cost = 120 * quantity; //  $120 for 10 visits
            break;
        case 'membership':
            cost = 99;
            break;
        default:
            return { error: "Invalid Open Play option." };
    }

    return { cost: cost, option: option, quantity: quantity };
}

// --- Birthday Party Pricing ---
function calculateBirthdayPartyCost(durationHours) {
    // Currently, only a 2-hour option is specified.  We can expand this.
    if (durationHours === 2) {
        return { cost: 275, durationHours: durationHours };
    } else {
        return { error: "Invalid birthday party duration." };
    }
}


// Export the functions so they can be used in other files
module.exports = {
    calculateOpenPlayCost,
    calculateBirthdayPartyCost,
    calculateRollingPlaygroupCost
};