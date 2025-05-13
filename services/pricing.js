const { isBefore, startOfDay, addWeeks, eachDayOfInterval, getDay } = require('date-fns');
const { isHoliday } = require('./holidayUtils');
const { isDaySelected } = require('./scheduleUtils');

// services/pricing.js
function calculatePlayGroupCost(numberOfDays, daysPerWeekBitmask, paymentType, semesterStartDate, semesterEndDate, holidays)
    {
    let sessionCost;

    if (numberOfDays === 1) {
        sessionCost = 50;
    } else if (numberOfDays === 2) {
         sessionCost = 44;
    } else if (numberOfDays === 3) {
         sessionCost = 40;
    } else if (numberOfDays === 4 || numberOfDays === 5) { // Correct logic
         sessionCost = 38;
    } else {
        // This validation is now correct for the count
        console.error("Validation failed for numberOfDays:", numberOfDays);
        return { error: "Invalid number of days per week (must be 1-5)." };
    }

    let registrationFee = 25;
    if (paymentType === 'full') {
        registrationFee = 0;
    }

    // 1. Calculate *potential* sessions (ignoring holidays)
    const startDate = new Date(semesterStartDate);
    const endDate = new Date(semesterEndDate);
    let potentialSessions = 0;
    let currentDate = new Date(startDate);

    while (currentDate <= endDate) {
        const dayOfWeek = currentDate.getDay();
        // Check if this day of the week is one of the selected days
        if (isDaySelected(dayOfWeek, daysPerWeekBitmask)) {
            potentialSessions++;
        }
        currentDate.setDate(currentDate.getDate() + 1); // Move to the next day
    }

    // 2. Calculate *actual* sessions (excluding holidays)
    let actualSessions = 0;
    currentDate = new Date(startDate); // Reset currentDate

    while (currentDate <= endDate) {
        const dayOfWeek = currentDate.getDay();
        if (isDaySelected(dayOfWeek, daysPerWeekBitmask) && !isHoliday(currentDate, holidays)) {
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
function calculateRollingPlaygroupCost(numberOfDaysSelected, daysPerWeekBitmask, paymentType, enrollmentStartDate, durationWeeks, holidays) {
   console.log(`ROLLING COST CALC: Start=${enrollmentStartDate.toISOString()}, Weeks=${durationWeeks}, DaysSelected=${numberOfDaysSelected}, Bitmask=${daysPerWeekBitmask}`);

   // --- Determine Session Cost Tier ---
   let sessionCost;
   if (numberOfDaysSelected === 1) sessionCost = 50;
   else if (numberOfDaysSelected === 2) sessionCost = 44;
   else if (numberOfDaysSelected === 3) sessionCost = 40;
   else if (numberOfDaysSelected >= 4) sessionCost = 38; // 4 or 5 days
   else return { error: "Invalid number of days selected (1-5)." };

   const registrationFee = (paymentType === 'full') ? 0 : 25;

   // --- Calculate End Date ---
   // addWeeks adds weeks, but the end date should be exclusive for the loop typically,
   // or inclusive depending on how you count "8 weeks".
   // Let's calculate end date as start + 8 weeks - 1 day for an inclusive 8-week period.
   const enrollmentEndDate = addWeeks(enrollmentStartDate, durationWeeks);
   enrollmentEndDate.setDate(enrollmentEndDate.getDate() - 1); // Inclusive end date
   console.log(`ROLLING COST CALC: Calculated End Date (inclusive): ${enrollmentEndDate.toISOString()}`);


   // --- Calculate Actual Sessions in the specific 8-week block ---
   let actualSessions = 0;
   const today = startOfDay(new Date()); // Start of today UTC

   try {
       // Get all dates within the interval
       const intervalDates = eachDayOfInterval({
           start: enrollmentStartDate,
           end: enrollmentEndDate
       });

       for (const currentDate of intervalDates) {
           const dayOfWeek = getDay(currentDate); // 0=Sun, 6=Sat

           // Check if it's a selected day, NOT a holiday, AND NOT in the past
           const isPastDate = isBefore(startOfDay(currentDate), today);

           if (!isPastDate && isDaySelected(dayOfWeek, daysPerWeekBitmask) && !isHoliday(currentDate, holidays)) {
               actualSessions++;
           }
       }
   } catch (err) {
        console.error("Error during date iteration in rolling cost calc:", err);
        return { error: "Error calculating session dates." };
   }

   const totalActualCost = sessionCost * actualSessions + registrationFee;

   console.log(`ROLLING COST CALC: Actual Sessions=${actualSessions}, Total Cost=${totalActualCost}`);

   return {
       sessionCost,
       registrationFee,
       totalActualCost, // Actual cost to be charged for this 8-week block
       actualSessions, // Count for this 8-week block
       startDate: enrollmentStartDate.toISOString().split('T')[0], // Return dates used
       endDate: enrollmentEndDate.toISOString().split('T')[0],
       durationWeeks,
       numberOfDaysSelected,
       daysPerWeekBitmask,
       // Add calculated installment amount if needed here?
       // installments: paymentType === 'installment' ? calculateInstallments(totalActualCost - registrationFee, 2) : null // Example: 2 installments
   };
}

// Export the functions so they can be used in other files
module.exports = {
    calculatePlayGroupCost,
    calculateOpenPlayCost,
    calculateBirthdayPartyCost,
    calculateRollingPlaygroupCost
};