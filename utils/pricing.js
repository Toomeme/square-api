// --- Play Group Pricing ---
function calculatePlayGroupCost(daysPerWeek, paymentType) {
    let sessionCost;

    if (daysPerWeek === 1) {
        sessionCost = 50;
    } else if (daysPerWeek === 2) {
        sessionCost = 44;
    } else if (daysPerWeek === 3) {
        sessionCost = 40;
    } else if (daysPerWeek >= 4 && daysPerWeek <= 5) {
        sessionCost = 38;
    } else {
        return { error: "Invalid number of days per week." }; // Handle invalid input
    }

    let registrationFee = 50;
    if (paymentType === 'full') {
        registrationFee = 0; // Waived if paid in full
    }

    // Assuming a semester is a fixed number of weeks (e.g., 15 weeks)
    const weeksPerSemester = 15; //  Make this a constant or configurable
    const totalSessionCost = sessionCost * daysPerWeek * weeksPerSemester;
    const totalCost = totalSessionCost + registrationFee;

    return {
        sessionCost: sessionCost,
        registrationFee: registrationFee,
        totalSessionCost: totalSessionCost,
        totalCost: totalCost,
        weeksPerSemester: weeksPerSemester // Return this for display purposes
    };
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
            cost = 130;
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
    calculatePlayGroupCost,
    calculateOpenPlayCost,
    calculateBirthdayPartyCost,
};